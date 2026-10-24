//! Training takes for the fine-tuning workbench (`wt-train record`, `training/`).
//!
//! The recorder runs a page on 127.0.0.1 and hands the running app its session with
//! `walkietalkey --training-session http://127.0.0.1:<port>/app/v1#<token>` (the
//! single-instance handoff, like `--toggle-transcription`; with no app running the binary
//! exits [`NOT_RUNNING_EXIT`] instead of starting one). The app connects out to that address
//! only, with the token ([`link`]); it opens no socket of its own.
//!
//! One condition per session ([`state`]): on the phone, the recorder's prompt goes to the
//! session's phone as a `training_prompt` inside the end-to-end encryption, the only text a
//! computer ever sends a phone (spec 12.1, PRIV-05), and the phone records the take through
//! its dictation capture and sends it with `audio_start_training` (0x24) and the usual chunks
//! (PROTOCOL.md 8.4); on the Mac, the page's space bar starts and stops a take on the
//! app's own input (`AudioRecordingManager`, as for a key dictation, without VAD). Either
//! way the recorder gets the 16 kHz audio exactly as the app received it, before VAD.
//!
//! A training take is never transcribed, pasted, shown in the pill or kept in history: it
//! never reaches `on_audio_start` or `finish_phone_dictation` (the event loop hands its events
//! here first). A take that belongs to no session (the phone still shows an old prompt, or
//! another phone) is answered `error` at its end and the phone is told the session is over.

mod link;
mod state;

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use log::{info, warn};
use once_cell::sync::OnceCell;
use tauri::{AppHandle, Manager};
use wt_relay_client::wt_protocol::{
    DeviceId, DevicePayload, ResultOutcome, ResultReason, SessionId,
};

pub use link::{parse_session_url, HelloPhone};
use link::{Hello, LinkError, RecorderLink, LONG_POLL_S};
use state::{Action, Key, Session, Upload};

/// `--training-session` exits with this when no WalkieTalkey is running (`training/wt_train/app.py`).
pub const NOT_RUNNING_EXIT: i32 = 3;
/// How long a finished phone take waits for the phone's resend of missing blocks (DESK-61).
const RESEND_WAIT: Duration = super::session::RESEND_WAIT;
/// The recorder may be unreachable this many times in a row before the session ends.
const MAX_FAILURES: u32 = 3;
const RETRY_EVERY: Duration = Duration::from_secs(1);

/// What a training session needs from the app; the tests use a fake.
pub trait Effects: Send + Sync + 'static {
    /// The paired phones, as the recorder's hello lists them.
    fn phones(&self) -> BoxFuture<'static, Vec<HelloPhone>>;
    /// The app's selected microphone, if one is chosen.
    fn input(&self) -> Option<String>;
    fn version(&self) -> String;
    fn send_phone(&self, phone: DeviceId, payload: DevicePayload) -> BoxFuture<'static, ()>;
    fn send_result(
        &self,
        phone: DeviceId,
        session: SessionId,
        outcome: ResultOutcome,
    ) -> BoxFuture<'static, ()>;
    /// Starts a take on the Mac's input; the error says why it cannot.
    fn mac_start(&self) -> BoxFuture<'static, Result<(), String>>;
    /// Ends it: the 16 kHz samples and the input's name.
    fn mac_stop(&self) -> BoxFuture<'static, Option<(Vec<f32>, Option<String>)>>;
    fn mac_cancel(&self) -> BoxFuture<'static, ()>;
}

struct Active {
    generation: u64,
    link: Arc<RecorderLink>,
    session: Session,
}

#[derive(Default)]
struct Inner {
    active: Option<Active>,
    /// Phone takes of no session: answered `error` at their end.
    refused: HashSet<Key>,
}

/// The app's training sessions: at most one at a time; a new handoff replaces the old one.
pub struct Trainer<E: Effects> {
    effects: Arc<E>,
    inner: Arc<Mutex<Inner>>,
    generation: AtomicU64,
}

fn spawn<F: Future<Output = ()> + Send + 'static>(fut: F) {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(fut);
        }
        Err(_) => {
            tauri::async_runtime::spawn(fut);
        }
    }
}

impl<E: Effects> Trainer<E> {
    pub fn new(effects: E) -> Arc<Self> {
        Arc::new(Self {
            effects: Arc::new(effects),
            inner: Arc::new(Mutex::new(Inner::default())),
            generation: AtomicU64::new(0),
        })
    }

    pub fn is_active(&self) -> bool {
        self.inner.lock().unwrap().active.is_some()
    }

    /// A session handed over by `--training-session`: connects to the recorder and follows it.
    pub fn start(self: &Arc<Self>, url: &str) -> Result<(), String> {
        let url = parse_session_url(url)?;
        let link = Arc::new(RecorderLink::new(url)?);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let this = Arc::clone(self);
        spawn(async move { this.run(generation, link).await });
        Ok(())
    }

    async fn run(self: Arc<Self>, generation: u64, link: Arc<RecorderLink>) {
        info!(
            "Training session: connecting to the recorder at {}",
            link.base()
        );
        let hello = Hello {
            app: "walkietalkey",
            version: self.effects.version(),
            os: if cfg!(target_os = "windows") {
                "win"
            } else {
                "mac"
            },
            phones: self.effects.phones().await,
            input: self.effects.input(),
        };
        let mut answer = None;
        for attempt in 0..MAX_FAILURES {
            match link.hello(&hello).await {
                Ok(a) => {
                    answer = Some(a);
                    break;
                }
                Err(LinkError::Unreachable(e)) if attempt + 1 < MAX_FAILURES => {
                    warn!("Training session: {e}; trying again");
                    tokio::time::sleep(RETRY_EVERY).await;
                }
                Err(e) => {
                    warn!("Training session refused: {e}");
                    return;
                }
            }
        }
        let Some(answer) = answer else { return };
        let session = match Session::new(&answer) {
            Ok(s) => s,
            Err(e) => {
                warn!("Training session: {e}");
                return;
            }
        };
        // A newer handoff replaces this one; an older session still running ends here.
        let old = {
            let mut inner = self.inner.lock().unwrap();
            if self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            inner.active.replace(Active {
                generation,
                link: Arc::clone(&link),
                session,
            })
        };
        if let Some(old) = old {
            self.finish_session(old).await;
        }
        info!("Training session started");

        let (mut after, mut failures) = (0u64, 0u32);
        'session: loop {
            if !self.is_current(generation) {
                break;
            }
            match link.next(after, LONG_POLL_S).await {
                Ok(commands) => {
                    failures = 0;
                    for numbered in commands {
                        after = after.max(numbered.seq);
                        let actions = match self
                            .with_session(generation, |s| s.on_command(&numbered.command))
                        {
                            Some(a) => a,
                            None => break 'session,
                        };
                        if self.carry_out(generation, &link, actions).await {
                            break 'session;
                        }
                    }
                }
                Err(LinkError::Unauthorized) => break,
                Err(e) => {
                    failures += 1;
                    if failures >= MAX_FAILURES {
                        warn!("Training session: {e}; ending it");
                        break;
                    }
                    tokio::time::sleep(RETRY_EVERY).await;
                }
            }
        }
        let ended = {
            let mut inner = self.inner.lock().unwrap();
            match &inner.active {
                Some(a) if a.generation == generation => inner.active.take(),
                _ => None,
            }
        };
        if let Some(active) = ended {
            self.finish_session(active).await;
        }
        info!("Training session ended");
    }

    fn is_current(&self, generation: u64) -> bool {
        matches!(&self.inner.lock().unwrap().active, Some(a) if a.generation == generation)
    }

    fn with_session<T>(&self, generation: u64, f: impl FnOnce(&mut Session) -> T) -> Option<T> {
        match &mut self.inner.lock().unwrap().active {
            Some(a) if a.generation == generation => Some(f(&mut a.session)),
            _ => None,
        }
    }

    /// The phone leaves the training screen, takes still coming in get `error`, the page hears
    /// the app is gone.
    async fn finish_session(&self, active: Active) {
        if let Some(Action::Phone(phone, payload)) = active.session.end_frame() {
            self.effects.send_phone(phone, payload).await;
        }
        let mut inner_refused = Vec::new();
        for key in active.session.open_takes() {
            inner_refused.push(key);
        }
        self.inner.lock().unwrap().refused.extend(inner_refused);
        let _ = active.link.event(&serde_json::json!({"type": "bye"})).await;
    }

    /// Carries out the actions in order; `true` when the session is over.
    async fn carry_out(
        &self,
        generation: u64,
        link: &Arc<RecorderLink>,
        actions: Vec<Action>,
    ) -> bool {
        for action in actions {
            match action {
                Action::Phone(phone, payload) => self.effects.send_phone(phone, payload).await,
                Action::Event(event) => {
                    if let Err(e) = link.event(&event).await {
                        warn!("Training session: could not tell the recorder: {e}");
                    }
                }
                Action::MacStart(prompt) => match self.effects.mac_start().await {
                    Ok(()) => {
                        let event = serde_json::json!({
                            "type": "recording", "prompt": prompt, "source": "mac", "input": self.effects.input()
                        });
                        let _ = link.event(&event).await;
                    }
                    Err(message) => {
                        self.with_session(generation, Session::mac_failed);
                        let _ = link
                            .event(&serde_json::json!({"type": "mac_failed", "message": message}))
                            .await;
                    }
                },
                Action::MacStop => {
                    let stopped = self.effects.mac_stop().await;
                    let upload = stopped.and_then(|(samples, input)| {
                        self.with_session(generation, |s| s.mac_upload(&samples, input))
                            .flatten()
                    });
                    match upload {
                        Some(upload) => {
                            if let Err(e) = link.take(&upload.meta, upload.pcm16).await {
                                warn!("Training session: the Mac take did not reach the recorder: {e}");
                            }
                        }
                        None => {
                            self.with_session(generation, Session::mac_failed);
                            let _ = link
                                .event(&serde_json::json!({"type": "mac_failed", "message": "no audio"}))
                                .await;
                        }
                    }
                }
                Action::MacCancel => self.effects.mac_cancel().await,
                Action::End => return true,
            }
        }
        false
    }

    // ---- phone events, from the relay's event loop ------------------------------------

    /// `audio_start_training`. Always consumed: a training take never becomes a dictation.
    pub fn on_start(
        self: &Arc<Self>,
        phone: DeviceId,
        session: SessionId,
        training: SessionId,
        prompt: String,
        microphone: Option<String>,
    ) {
        let key = (phone, session);
        let mut inner = self.inner.lock().unwrap();
        let taken = inner.active.as_mut().map(|a| {
            let (mine, actions) = a.session.start(key, training, &prompt, microphone);
            (mine, actions, a.generation, Arc::clone(&a.link))
        });
        match taken {
            Some((true, actions, generation, link)) => {
                drop(inner);
                let this = Arc::clone(self);
                spawn(async move {
                    this.carry_out(generation, &link, actions).await;
                });
            }
            _ => {
                // No session for it: tell the phone its training is over; its take gets an
                // error when it ends.
                warn!("A training take arrived for no running training session");
                inner.refused.insert(key);
                drop(inner);
                let effects = Arc::clone(&self.effects);
                spawn(async move {
                    effects
                        .send_phone(phone, DevicePayload::TrainingEnd { training })
                        .await;
                });
            }
        }
    }

    /// A block of a training take: `true` when it was one (never a dictation's).
    pub fn on_chunk(&self, key: &Key, index: u32, pcm: &[u8]) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.refused.contains(key) {
            return true;
        }
        inner
            .active
            .as_mut()
            .is_some_and(|a| a.session.chunk(key, index, pcm))
    }

    /// `audio_end` of a training take: waits for missing blocks, hands the take to the
    /// recorder and answers the phone. `true` when it was a training take.
    pub fn on_end(self: &Arc<Self>, key: Key, chunks: u32) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.refused.remove(&key) {
            drop(inner);
            let effects = Arc::clone(&self.effects);
            spawn(async move {
                effects
                    .send_result(key.0, key.1, ResultOutcome::Failed(ResultReason::Error))
                    .await;
            });
            return true;
        }
        let Some(active) = inner.active.as_mut() else {
            return false;
        };
        if !active.session.end(&key, chunks) {
            return false;
        }
        let (generation, link) = (active.generation, Arc::clone(&active.link));
        drop(inner);
        let this = Arc::clone(self);
        spawn(async move { this.hand_over(generation, link, key).await });
        true
    }

    async fn hand_over(&self, generation: u64, link: Arc<RecorderLink>, key: Key) {
        let deadline = tokio::time::Instant::now() + RESEND_WAIT;
        while tokio::time::Instant::now() < deadline
            && !self
                .with_session(generation, |s| s.complete(&key))
                .unwrap_or(true)
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let upload: Option<Upload> = self
            .with_session(generation, |s| s.phone_upload(&key))
            .flatten();
        let outcome = match upload {
            Some(upload) => match link.take(&upload.meta, upload.pcm16).await {
                Ok(answer) => state::outcome(&answer),
                Err(e) => {
                    warn!("Training session: the take did not reach the recorder: {e}");
                    ResultOutcome::Failed(ResultReason::Error)
                }
            },
            None => ResultOutcome::Failed(ResultReason::Error),
        };
        self.effects.send_result(key.0, key.1, outcome).await;
    }

    /// `audio_cancel` of a training take.
    pub fn on_cancel(self: &Arc<Self>, key: &Key) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.refused.remove(key) {
            return true;
        }
        let Some(active) = inner.active.as_mut() else {
            return false;
        };
        let Some(actions) = active.session.cancel(key) else {
            return false;
        };
        let (generation, link) = (active.generation, Arc::clone(&active.link));
        drop(inner);
        let this = Arc::clone(self);
        spawn(async move {
            this.carry_out(generation, &link, actions).await;
        });
        true
    }

    /// The relay says a phone came online or went away.
    pub fn on_phone(self: &Arc<Self>, phone: DeviceId, online: bool) {
        let inner = self.inner.lock().unwrap();
        let Some(active) = inner.active.as_ref() else {
            return;
        };
        let actions = active.session.on_phone(phone, online);
        if actions.is_empty() {
            return;
        }
        let (generation, link) = (active.generation, Arc::clone(&active.link));
        drop(inner);
        let this = Arc::clone(self);
        spawn(async move {
            this.carry_out(generation, &link, actions).await;
        });
    }

    /// The phone was removed or left: its takes go.
    pub fn forget_phone(&self, phone: &DeviceId) {
        let mut inner = self.inner.lock().unwrap();
        inner.refused.retain(|(p, _)| p != phone);
        if let Some(active) = inner.active.as_mut() {
            for key in active.session.open_takes() {
                if &key.0 == phone {
                    active.session.cancel(&key);
                }
            }
        }
    }
}

// ---- the app ------------------------------------------------------------------------

/// The app's effects: the relay client, the recording manager, the settings.
pub struct AppEffects {
    app: AppHandle,
}

const MAC_BINDING: &str = "wt-training";

impl Effects for AppEffects {
    fn phones(&self) -> BoxFuture<'static, Vec<HelloPhone>> {
        Box::pin(async move {
            let Some(client) = super::client() else {
                return Vec::new();
            };
            match client.status().await {
                Ok(status) => status
                    .phones
                    .into_iter()
                    .map(|p| HelloPhone {
                        id: p.id.to_b64u(),
                        name: p.name.unwrap_or_default(),
                        platform: p.platform,
                        online: p.online,
                    })
                    .collect(),
                Err(_) => Vec::new(),
            }
        })
    }

    fn input(&self) -> Option<String> {
        crate::settings::get_settings(&self.app).selected_microphone
    }

    fn version(&self) -> String {
        self.app.package_info().version.to_string()
    }

    fn send_phone(&self, phone: DeviceId, payload: DevicePayload) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let Some(client) = super::client() else {
                return;
            };
            if let Err(e) = client.send_training(phone, payload).await {
                // Sent again when the phone or the relay is back.
                info!("Training prompt not sent now: {e}");
            }
        })
    }

    fn send_result(
        &self,
        phone: DeviceId,
        session: SessionId,
        outcome: ResultOutcome,
    ) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let Some(client) = super::client() else {
                return;
            };
            if let Err(e) = client.send_result(phone, session, outcome).await {
                warn!("Could not send the training take's result to the phone: {e}");
            }
        })
    }

    fn mac_start(&self) -> BoxFuture<'static, Result<(), String>> {
        let app = self.app.clone();
        Box::pin(async move {
            tauri::async_runtime::spawn_blocking(move || {
                let rm = app
                    .try_state::<Arc<crate::managers::audio::AudioRecordingManager>>()
                    .ok_or("the recorder is not ready")?;
                // Every frame, before VAD: what the model would hear (the live stream is not
                // open, so nothing is transcribed).
                rm.try_start_recording(
                    MAC_BINDING,
                    crate::audio_toolkit::audio::VadPolicy::Disabled,
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }

    fn mac_stop(&self) -> BoxFuture<'static, Option<(Vec<f32>, Option<String>)>> {
        let app = self.app.clone();
        Box::pin(async move {
            tauri::async_runtime::spawn_blocking(move || {
                let rm = app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>()?;
                let samples = rm.stop_recording(MAC_BINDING, rm.cancel_generation())?;
                // The input the take came from (and DESK-59's verdict, logged).
                let input = crate::walkietalkey::mic::finish_take().map(|t| t.input);
                Some((samples, input))
            })
            .await
            .ok()
            .flatten()
        })
    }

    fn mac_cancel(&self) -> BoxFuture<'static, ()> {
        let app = self.app.clone();
        Box::pin(async move {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Some(rm) =
                    app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>()
                {
                    rm.cancel_recording();
                }
                let _ = crate::walkietalkey::mic::finish_take();
            })
            .await;
        })
    }
}

static TRAINER: OnceCell<Arc<Trainer<AppEffects>>> = OnceCell::new();

/// The app's trainer, once a session was handed over.
pub fn trainer() -> Option<&'static Arc<Trainer<AppEffects>>> {
    TRAINER.get()
}

/// The app's trainer, made on first use (a training take can arrive before any session, from a
/// phone that still shows an old prompt).
pub fn trainer_for(app: &AppHandle) -> &'static Arc<Trainer<AppEffects>> {
    TRAINER.get_or_init(|| Trainer::new(AppEffects { app: app.clone() }))
}

/// `--training-session <url>` reached the running app.
pub fn start(app: &AppHandle, url: &str) {
    if let Err(e) = trainer_for(app).start(url) {
        warn!("Refused a training session: {e}");
    }
}

/// The value of `--training-session` in a second instance's arguments.
pub fn session_arg(args: &[String]) -> Option<&str> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--training-session" {
            return it.next().map(String::as_str);
        }
        if let Some(v) = a.strip_prefix("--training-session=") {
            return Some(v);
        }
    }
    None
}

#[cfg(test)]
mod tests;
