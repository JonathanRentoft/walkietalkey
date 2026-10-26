//! Receiving from the phone (spec 5, 6.8): one relay connection for this
//! computer's room (DESK-60), pairing with a QR (5.3), "Var det dig?" for
//! every new phone (DESK-62), phone dictations fed into a live chunked decode
//! as they arrive (DESK-61) and answered with a result that never carries the
//! text (DESK-64), and presence answers (DESK-63).

pub mod dictations;
pub mod headless;
pub mod keystore;
pub mod levels;
pub mod session;
pub mod training;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::{error, info, warn};
use once_cell::sync::Lazy;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::UnboundedReceiver;
use wt_relay_client::wt_protocol::{ComputerOs, DeviceId, ResultOutcome, ResultReason, SessionId};
use wt_relay_client::{ClientConfig, ClientError, KeyStore, RelayClient, RelayEvent};

use self::dictations::{Dictation, Dictations, PhoneDictation, TOO_LONG};
use self::session::RESEND_WAIT;
use super::output::Source;
use crate::managers::transcription::{SideStream, TranscriptionManager};

static CLIENT: Lazy<Mutex<Option<RelayClient>>> = Lazy::new(|| Mutex::new(None));

/// Bumped whenever a client starts or stops, so a client's helpers (the wake
/// watcher) know when they belong to one that is gone.
static CLIENT_GENERATION: AtomicU64 = AtomicU64::new(0);

/// How long "Par en telefon" waits for a fresh connection to the relay.
const CONNECT_WAIT: Duration = Duration::from_secs(15);

/// Phone names by device id, for history labels and notifications.
static NAMES: Lazy<Mutex<HashMap<DeviceId, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn client() -> Option<RelayClient> {
    CLIENT.lock().unwrap().clone()
}

fn computer_name() -> String {
    tauri_plugin_os::hostname()
        .trim_end_matches(".local")
        .replace('-', " ")
}

fn computer_os() -> ComputerOs {
    if cfg!(target_os = "windows") {
        ComputerOs::Win
    } else {
        ComputerOs::Mac
    }
}

/// The other addresses of the relay at `relay_url`. relay.walkietalkey.com
/// and v1's workers.dev address are the same Worker, which finds a room by
/// its id alone (RELAY-01), so a room made on one is the same room on the
/// other and its phones stay paired (DESK-60). A company relay has none.
fn relay_aliases(relay_url: &str) -> Vec<String> {
    let ours = [
        super::settings::DEFAULT_RELAY_URL,
        super::settings::V1_RELAY_URL,
    ];
    let url = relay_url.trim_end_matches('/');
    if !ours.contains(&url) {
        return Vec::new();
    }
    ours.iter()
        .filter(|other| **other != url)
        .map(|other| other.to_string())
        .collect()
}

fn client_config(settings: &super::settings::WtSettings) -> ClientConfig {
    let mut config = ClientConfig::new(
        settings.relay_url.clone(),
        settings.phone_app_url.clone(),
        computer_name(),
        computer_os(),
    );
    config.relay_aliases = relay_aliases(&config.relay_url);
    config
}

/// Where the relay state lives, and where v0.1 kept it if that differs. On
/// macOS it sits in the private secret folder with the keys (run 5); v0.1's
/// `relay/` in the data folder is retired by the key store.
fn state_dirs(app: &AppHandle) -> anyhow::Result<(std::path::PathBuf, Option<std::path::PathBuf>)> {
    let data = crate::portable::app_data_dir(app)?;
    #[cfg(unix)]
    {
        let secrets = super::secrets::secret_dir().map_err(|e| anyhow::anyhow!("{e}"))?;
        Ok((secrets.join("relay"), Some(data.join("relay"))))
    }
    #[cfg(not(unix))]
    {
        Ok((data.join("relay"), None))
    }
}

/// Opens the key store: the keys in the app's secret store (never the
/// keychain on macOS, run 5), the room and counters beside them.
fn open_store(app: &AppHandle) -> anyhow::Result<Arc<dyn KeyStore>> {
    let secrets = super::secrets::store().map_err(|e| anyhow::anyhow!("{e}"))?;
    let (dir, legacy) = state_dirs(app)?;
    let store = keystore::DesktopKeyStore::open(&dir, secrets, legacy.as_deref())
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(Arc::new(store))
}

/// Starts the relay connection when a phone is paired. Without one, nothing
/// connects (spec 5.3, PRIV-04): "Par en telefon" connects and creates the
/// room. Nothing connects when the phone feature is turned off (managed
/// `AllowPhonePairing`). Called from `setup` on the main thread, so the store
/// is read on a worker: nothing at startup waits on the main thread (run 5).
pub fn start(app: &AppHandle) {
    let settings = super::store::get(app);
    if !settings.allow_phone_pairing {
        info!("Phone pairing is turned off; no relay connection");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let reader = app.clone();
        let paired = tauri::async_runtime::spawn_blocking(move || match open_store(&reader) {
            Ok(store) => store.load_phones().map(|p| !p.is_empty()).unwrap_or(false),
            Err(e) => {
                error!("Relay key store unavailable: {e}");
                false
            }
        })
        .await
        .unwrap_or(false);
        if !paired {
            info!("No phone is paired; the relay connects when one is");
            return;
        }
        if let Err(e) = ensure_client(&app).await {
            error!("Relay client did not start: {e}");
        }
    });
}

/// The running relay client, started now if there is none.
async fn ensure_client(app: &AppHandle) -> Result<RelayClient, String> {
    if let Some(client) = client() {
        return Ok(client);
    }
    let settings = super::store::get(app);
    let store = open_store(app).map_err(|e| e.to_string())?;
    let config = client_config(&settings);
    let (client, events) = RelayClient::start(config, store).map_err(|e| e.to_string())?;
    let existing = {
        let mut slot = CLIENT.lock().unwrap();
        match slot.as_ref() {
            Some(existing) => Some(existing.clone()),
            None => {
                *slot = Some(client.clone());
                None
            }
        }
    };
    if let Some(existing) = existing {
        // Another caller started one meanwhile: keep that one.
        client.shutdown().await;
        return Ok(existing);
    }
    let generation = CLIENT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    watch_for_wake(client.clone(), generation);
    let (app, looped) = (app.clone(), client.clone());
    tauri::async_runtime::spawn(async move { event_loop(app, looped, events).await });
    Ok(client)
}

fn forget_client() {
    *CLIENT.lock().unwrap() = None;
    CLIENT_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// Disconnects when nothing needs the relay: no phone paired and no pairing
/// code open (spec 5.3, PRIV-04).
async fn disconnect_if_unneeded() {
    let Some(client) = client() else {
        return;
    };
    match client.status().await {
        Ok(status) if status.phones.is_empty() && !status.pairing_active => {
            info!("No phone is paired any more; closing the relay connection");
            forget_client();
            client.shutdown().await;
        }
        _ => {}
    }
}

/// DESK-60: reconnect right after sleep. A wall-clock jump between ticks of
/// a steady timer means the machine was asleep.
fn watch_for_wake(client: RelayClient, generation: u64) {
    std::thread::spawn(move || {
        let tick = Duration::from_secs(5);
        let mut last = SystemTime::now();
        loop {
            std::thread::sleep(tick);
            if CLIENT_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let now = SystemTime::now();
            if now.duration_since(last).unwrap_or_default() > tick * 3 {
                info!("Woke from sleep; reconnecting to the relay");
                client.reconnect_now();
            }
            last = now;
        }
    });
}

fn emit_phones_changed(app: &AppHandle) {
    let _ = app.emit("wt-phones-changed", ());
}

async fn event_loop(
    app: AppHandle,
    client: RelayClient,
    mut events: UnboundedReceiver<RelayEvent>,
) {
    let dictations = Arc::new(Dictations::default());
    watch_dictations(app.clone(), client.clone(), Arc::downgrade(&dictations));
    while let Some(event) = events.recv().await {
        // Training takes (the fine-tuning workbench) are handled before anything else and never
        // become dictations: no model, pill, transcription, clipboard or history.
        if training_event(&app, &event) {
            continue;
        }
        match event {
            RelayEvent::Connected { .. } | RelayEvent::RoomCreated { .. } => {
                let _ = app.emit("wt-relay-status", true);
                emit_phones_changed(&app);
            }
            RelayEvent::Disconnected { reason, .. } => {
                info!("Relay disconnected: {reason}");
                let _ = app.emit("wt-relay-status", false);
            }
            RelayEvent::RoomReset { .. } | RelayEvent::RoomDeleted => emit_phones_changed(&app),
            RelayEvent::PhonePaired { phone, name, .. } => {
                // DESK-62: shown whether or not the phone sent a name.
                let label = Source::Phone {
                    device_id: phone.to_b64u(),
                    name: name.clone().unwrap_or_default(),
                }
                .label();
                if let Some(name) = name {
                    NAMES.lock().unwrap().insert(phone, name);
                }
                super::notify::phone_joined(&app, &label);
                let _ = app.emit(
                    "wt-phone-joined",
                    PhoneJoined {
                        id: phone.to_b64u(),
                        name: label,
                    },
                );
                emit_phones_changed(&app);
            }
            RelayEvent::PhoneInfo { phone, name, .. } => {
                NAMES.lock().unwrap().insert(phone, name);
                emit_phones_changed(&app);
            }
            RelayEvent::PhoneRejected { phone, reason } => {
                warn!("Refused a phone ({phone:?}): {reason:?}");
                emit_phones_changed(&app);
            }
            RelayEvent::PairingExpired { .. } => {
                let _ = app.emit("wt-pairing-expired", ());
                tauri::async_runtime::spawn(disconnect_if_unneeded());
            }
            RelayEvent::PhoneLeft { phone } | RelayEvent::PhoneRemoved { phone } => {
                NAMES.lock().unwrap().remove(&phone);
                // Its dictations end with it (DESK-58).
                if let Some(showed_pill) = dictations.forget_phone(&phone) {
                    let_go(&app, &dictations, showed_pill);
                }
                emit_phones_changed(&app);
                tauri::async_runtime::spawn(disconnect_if_unneeded());
            }
            RelayEvent::PeerStatus { .. } => emit_phones_changed(&app),
            RelayEvent::AudioStart { phone, session, .. } => {
                on_audio_start(&app, &dictations, phone, session);
            }
            RelayEvent::AudioChunk {
                phone,
                session,
                index,
                pcm,
            } => {
                let found = dictations.for_block(&(phone, session), Instant::now());
                if let Some((dictation, resumed)) = found {
                    if resumed {
                        on_resumed(&app, &dictations, &dictation);
                    }
                    let mut d = dictation.lock().unwrap();
                    let ready = d.audio.add(index, &pcm);
                    if !ready.is_empty() {
                        if let Some(levels) = &d.levels {
                            levels.push(&ready);
                        }
                        if let Some(side) = &d.side {
                            side.feed(ready);
                        }
                    }
                }
            }
            RelayEvent::AudioEnd {
                phone,
                session,
                chunks,
                ..
            } => {
                // Receiving, or gone silent and its rest arriving late.
                if let Some(dictation) = dictations.end(&(phone, session)) {
                    {
                        let mut d = dictation.lock().unwrap();
                        d.audio.end(chunks);
                        d.stop_levels();
                    }
                    // DESK-27: the place in the output order is taken now.
                    let ticket = super::sequence::take_ticket();
                    let (app, client) = (app.clone(), client.clone());
                    let dictations = Arc::clone(&dictations);
                    tauri::async_runtime::spawn(async move {
                        finish_phone_dictation(
                            app, client, dictations, phone, session, dictation, ticket,
                        )
                        .await;
                    });
                }
            }
            RelayEvent::AudioCancel { phone, session } => {
                if let Some(showed_pill) = dictations.cancel(&(phone, session)) {
                    let_go(&app, &dictations, showed_pill);
                }
            }
            // Handled by training_event above.
            RelayEvent::TrainingStart { .. } => {}
            RelayEvent::PresenceQuery { query, .. } => {
                let (seconds, locked) = super::presence::current();
                if let Err(e) = client.answer_presence(query, seconds, locked).await {
                    warn!("Presence answer failed: {e}");
                }
            }
            RelayEvent::RelayError { code, message } => warn!("Relay error {code}: {message}"),
        }
    }
}

/// WalkieTalkey (training): hands a relay event to the training session first; `true` when it
/// was a training take's (PROTOCOL.md 8.4). Phone status also reaches it, so the phone gets
/// its prompt again when it is back.
fn training_event(app: &AppHandle, event: &RelayEvent) -> bool {
    use RelayEvent as E;
    if let E::TrainingStart {
        phone,
        session,
        training: id,
        prompt,
        microphone,
    } = event
    {
        let trainer = training::trainer_for(app);
        trainer.on_start(*phone, *session, *id, prompt.clone(), microphone.clone());
        return true;
    }
    let Some(trainer) = training::trainer() else {
        return false;
    };
    match event {
        E::AudioChunk {
            phone,
            session,
            index,
            pcm,
        } => trainer.on_chunk(&(*phone, *session), *index, pcm),
        E::AudioEnd {
            phone,
            session,
            chunks,
            ..
        } => trainer.on_end((*phone, *session), *chunks),
        E::AudioCancel { phone, session } => trainer.on_cancel(&(*phone, *session)),
        E::PeerStatus { phone, online } => {
            trainer.on_phone(*phone, *online);
            false
        }
        E::Connected { members, .. } => {
            for m in members {
                trainer.on_phone(m.id, m.online);
            }
            false
        }
        E::PhoneLeft { phone } | E::PhoneRemoved { phone } => {
            trainer.forget_phone(phone);
            false
        }
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct PhoneJoined {
    pub id: String,
    pub name: String,
}

fn on_audio_start(
    app: &AppHandle,
    dictations: &Arc<Dictations>,
    phone: DeviceId,
    session: SessionId,
) {
    let paused = super::tray::is_paused();
    // DESK-87: a phone recording warms the cleanup connection too.
    super::cleanup::warm(app);
    let side = if paused {
        None
    } else {
        app.try_state::<Arc<TranscriptionManager>>().map(|tm| {
            tm.initiate_model_load();
            tm.start_side_stream()
        })
    };
    // DESK-58: the menu bar icon shows that a phone recording is coming in,
    // and the pill too (on by default), its waveform moving with the
    // phone's audio.
    let pill = phone_pill(app);
    let levels = pill.then(|| levels::PhoneLevels::start(app));
    dictations.start(
        (phone, session),
        PhoneDictation::new(side, paused, levels, Instant::now()),
    );
    show_receiving(app, dictations, pill);
}

/// The menu bar pulses while a phone dictation is receiving, and the pill
/// shows when it is the phone's (DESK-58).
fn show_receiving(app: &AppHandle, dictations: &Arc<Dictations>, pill: bool) {
    crate::tray::set_tray_state(app, crate::tray::TrayIconState::Recording);
    if pill {
        crate::overlay::show_recording_overlay(app);
    }
    let dictations = Arc::clone(dictations);
    super::tray::pulse_while(app.clone(), move || dictations.is_receiving());
}

/// A dictation that went silent receives again (a resend after the phone's
/// reconnect, PHONE-32, or frames the relay held for this computer): the
/// pill and the menu bar come back. Its live decode does not; it is
/// transcribed whole at its end.
fn on_resumed(app: &AppHandle, dictations: &Arc<Dictations>, dictation: &Dictation) {
    info!("A phone dictation that went silent is receiving again");
    let pill = phone_pill(app);
    {
        let mut d = dictation.lock().unwrap();
        d.pill = pill;
        if pill && d.levels.is_none() {
            d.levels = Some(levels::PhoneLevels::start(app));
        }
    }
    show_receiving(app, dictations, pill);
}

fn key_recording(app: &AppHandle) -> bool {
    app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>()
        .is_some_and(|rm| rm.is_recording())
}

/// DESK-58: the pill for phone dictations, when that setting is on and the
/// pill is not hidden. A key dictation owns the pill while it records, and
/// while paused (DESK-96) phone dictations show none.
fn pill_for_phone(
    settings: &super::settings::WtSettings,
    key_recording: bool,
    paused: bool,
) -> bool {
    settings.pill_for_phone && !settings.pill_hidden && !key_recording && !paused
}

fn phone_pill(app: &AppHandle) -> bool {
    pill_for_phone(
        &super::store::get(app),
        key_recording(app),
        super::tray::is_paused(),
    )
}

/// Phone dictations stopped receiving (silent, cancelled, too long, or their
/// phone left): the menu bar goes idle once none is busy, and the pill hides
/// when it was theirs and no other phone dictation or key dictation has it.
fn let_go(app: &AppHandle, dictations: &Dictations, showed_pill: bool) {
    let key = key_recording(app);
    if !dictations.busy() && !key {
        crate::tray::set_tray_state(app, crate::tray::TrayIconState::Idle);
    }
    if showed_pill && !dictations.pill_in_use() && !key {
        crate::utils::hide_recording_overlay(app);
    }
}

/// The watchdog (DESK-58): about once a second, phone dictations that went
/// silent let go of the pill and the menu bar, ones past the 5-minute limit
/// are answered `too_long`, and silent ones kept too long are forgotten in
/// the relay client too (see `dictations`). Ends with its event loop.
fn watch_dictations(app: AppHandle, client: RelayClient, weak: Weak<Dictations>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(dictations::WATCH_EVERY).await;
            let Some(dictations) = weak.upgrade() else {
                return;
            };
            let watched = dictations.watch(Instant::now());
            if !watched.silent.is_empty() {
                info!("A phone dictation went silent; waiting for the rest");
            }
            for &((phone, session), _) in &watched.over_limit {
                warn!("A phone dictation ran past the 5-minute limit");
                let outcome = ResultOutcome::Failed(ResultReason::TooLong);
                if let Err(e) = client.send_result(phone, session, outcome).await {
                    warn!("Could not send the result to the phone: {e}");
                }
            }
            if watched.stopped_any() {
                let_go(&app, &dictations, watched.showed_pill());
            }
            for (phone, session) in watched.dropped {
                client.forget_session(phone, session);
            }
        }
    });
}

async fn finish_phone_dictation(
    app: AppHandle,
    client: RelayClient,
    dictations: Arc<Dictations>,
    phone: DeviceId,
    session: SessionId,
    dictation: Dictation,
    ticket: super::sequence::Ticket,
) {
    crate::tray::set_tray_state(&app, crate::tray::TrayIconState::Transcribing);
    let pill = phone_pill(&app);
    dictation.lock().unwrap().pill = pill;
    if pill {
        crate::overlay::show_transcribing_overlay(&app);
    }
    // DESK-61: wait up to 5 s for the phone's resend of missing blocks.
    let deadline = Instant::now() + RESEND_WAIT;
    while !dictation.lock().unwrap().audio.is_complete() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    dictations.ended(&(phone, session));
    let (side, audio, paused, too_long) = {
        let mut d = dictation.lock().unwrap();
        let rest = d.audio.give_up_on_gaps();
        if let Some(side) = &d.side {
            if !rest.is_empty() {
                side.feed(rest);
            }
        }
        // Counted in audio: a dictation that went silent and arrived late
        // (PHONE-24, PHONE-32) is not too long for being late.
        let too_long = d.audio.duration() > TOO_LONG;
        (d.side.take(), d.audio.audio().to_vec(), d.paused, too_long)
    };
    let outcome = if paused {
        ResultOutcome::Failed(ResultReason::Paused)
    } else if too_long {
        if let Some(side) = side {
            side.cancel();
        }
        ResultOutcome::Failed(ResultReason::TooLong)
    } else {
        transcribe_and_deliver(&app, phone, side, audio, ticket).await
    };
    crate::tray::set_tray_state(&app, crate::tray::TrayIconState::Idle);
    if pill && phone_pill(&app) {
        let end = match outcome {
            ResultOutcome::Ok => Some(super::output::PillEnd::Clipboard),
            ResultOutcome::Failed(ResultReason::NoSpeech) => Some(super::output::PillEnd::NoSpeech),
            _ => None,
        };
        match end {
            Some(end) => {
                let handle = app.clone();
                super::pill::finish(&app, end, move || phone_pill(&handle));
            }
            None => crate::utils::hide_recording_overlay(&app),
        }
    }
    if let Err(e) = client.send_result(phone, session, outcome).await {
        warn!("Could not send the result to the phone: {e}");
    }
}

async fn transcribe_and_deliver(
    app: &AppHandle,
    phone: DeviceId,
    side: Option<SideStream>,
    audio: Vec<f32>,
    ticket: super::sequence::Ticket,
) -> ResultOutcome {
    let Some(tm) = app
        .try_state::<Arc<TranscriptionManager>>()
        .map(|tm| Arc::clone(&tm))
    else {
        return ResultOutcome::Failed(ResultReason::Error);
    };
    // DESK-64: no model chosen, or its file not here yet (still downloading).
    let selected = crate::settings::get_settings(app).selected_model;
    let downloaded = app
        .try_state::<Arc<crate::managers::model::ModelManager>>()
        .and_then(|mm| mm.get_model_info(&selected))
        .is_some_and(|m| m.is_downloaded);
    if selected.is_empty() || !downloaded {
        return ResultOutcome::Failed(ResultReason::ModelNotReady);
    }
    let audio_file = keep_phone_audio(app, &audio);
    let transcribed = tauri::async_runtime::spawn_blocking(move || match side {
        Some(side) => tm.transcribe_side(side, audio),
        None => tm.transcribe(audio),
    })
    .await;
    let text = match transcribed {
        Ok(Ok(text)) => text,
        Ok(Err(e)) => {
            error!("Phone dictation failed: {e}");
            return ResultOutcome::Failed(ResultReason::Error);
        }
        Err(e) => {
            error!("Phone dictation task failed: {e}");
            return ResultOutcome::Failed(ResultReason::Error);
        }
    };
    let finished = super::dictation::process(app, &text, false, false).await;
    if finished.final_text.trim().is_empty() {
        return ResultOutcome::Failed(ResultReason::NoSpeech);
    }
    // DESK-27: after earlier dictations' output.
    let ticket = ticket.wait_turn_async().await;
    let name = NAMES
        .lock()
        .unwrap()
        .get(&phone)
        .cloned()
        .unwrap_or_default();
    let source = Source::Phone {
        device_id: phone.to_b64u(),
        name,
    };
    // DESK-52: phone dictations always go to the clipboard.
    if let Err(e) = crate::clipboard::write_text(app, &finished.final_text) {
        error!("Could not put the phone dictation on the clipboard: {e}");
        return ResultOutcome::Failed(ResultReason::Error);
    }
    let history_id = super::dictation::save_history(app, &finished, &source, audio_file.as_deref());
    let settings = super::store::get(app);
    super::notify::text_ready(
        app,
        super::output::notification_body(&finished.final_text, settings.show_text_in_notifications),
        history_id,
    );
    drop(ticket);
    ResultOutcome::Ok
}

/// Keeps a phone recording as it arrived (16 kHz mono) when "Gem lyd til fejlfinding" is on
/// (DESK-92), like a key dictation's, and returns its file name for the history item.
fn keep_phone_audio(app: &AppHandle, audio: &[f32]) -> Option<String> {
    if audio.is_empty() || !super::store::get(app).keep_audio_for_debugging {
        return None;
    }
    let hm = app.try_state::<Arc<crate::managers::history::HistoryManager>>()?;
    let file_name = format!(
        "walkietalkey-phone-{}.wav",
        chrono::Utc::now().timestamp_millis()
    );
    match crate::audio_toolkit::save_wav_file(hm.recordings_dir().join(&file_name), audio) {
        Ok(()) => Some(file_name),
        Err(e) => {
            warn!("Could not keep the phone recording: {e}");
            None
        }
    }
}

// ---- Commands support -------------------------------------------------

/// The pairing window's data (spec 5.3, DESK-16).
#[derive(Debug, Clone, Serialize, Type)]
pub struct PairingView {
    /// The QR code as SVG; the URL itself stays in the backend.
    pub qr_svg: String,
    /// Unix milliseconds when the code expires (10 minutes, SEC-02).
    pub expires_at_ms: f64,
}

pub fn qr_svg(url: &str) -> anyhow::Result<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::M)?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .dark_color(svg::Color("#1b1a19"))
        .light_color(svg::Color("#faf8f4"))
        .build())
}

pub async fn start_pairing(app: &AppHandle) -> Result<PairingView, String> {
    if !super::store::get(app).allow_phone_pairing {
        return Err("Telefonparring er slået fra af din organisation.".into());
    }
    let client = ensure_client(app).await?;
    // A connection that is still being made gets a moment (the first
    // pairing also creates the room).
    let deadline = Instant::now() + CONNECT_WAIT;
    let ticket = loop {
        match client.start_pairing().await {
            Ok(ticket) => break ticket,
            Err(ClientError::NotConnected) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Err(ClientError::NotConnected) => {
                return Err("Ingen forbindelse til relæet. Prøv igen.".into());
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let expires_at_ms = ticket
        .expires_at
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64;
    Ok(PairingView {
        qr_svg: qr_svg(&ticket.url).map_err(|e| e.to_string())?,
        expires_at_ms,
    })
}

/// A paired phone as Indstillinger › Telefon lists it.
#[derive(Debug, Clone, Serialize, Type)]
pub struct PhoneView {
    pub id: String,
    pub name: String,
    pub platform: Option<String>,
    pub online: bool,
    /// Days since 1970-01-01 UTC ("sidst set"); `None` when never seen.
    pub last_seen_day: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct RelayView {
    pub enabled: bool,
    pub connected: bool,
    pub phones: Vec<PhoneView>,
    pub pairing_active: bool,
    /// Phones paired before v0.2.0 must pair again: this computer has a new
    /// identity, because v0.1's keys were in the keychain (run 5).
    pub pair_again: bool,
}

/// Whether the phones paired with the previous identity still have to pair again.
fn must_pair_again(app: &AppHandle) -> bool {
    state_dirs(app).is_ok_and(|(dir, _)| keystore::pair_again(&dir))
}

pub async fn status(app: &AppHandle) -> RelayView {
    let enabled = super::store::get(app).allow_phone_pairing;
    let pair_again = enabled && must_pair_again(app);
    let Some(client) = client() else {
        return RelayView {
            enabled,
            connected: false,
            phones: Vec::new(),
            pairing_active: false,
            pair_again,
        };
    };
    match client.status().await {
        Ok(status) => RelayView {
            pair_again: pair_again && status.phones.is_empty(),
            enabled,
            connected: status.connected,
            phones: status
                .phones
                .into_iter()
                .map(|p| PhoneView {
                    id: p.id.to_b64u(),
                    name: Source::Phone {
                        device_id: p.id.to_b64u(),
                        name: p.name.unwrap_or_default(),
                    }
                    .label(),
                    platform: p.platform,
                    online: p.online,
                    last_seen_day: p.last_seen_day,
                })
                .collect(),
            pairing_active: status.pairing_active,
        },
        Err(e) => {
            warn!("Relay status unavailable: {e}");
            RelayView {
                enabled,
                connected: false,
                phones: Vec::new(),
                pairing_active: false,
                pair_again,
            }
        }
    }
}

/// "Fjern" (SEC-04): revoke at the relay and delete the pair keys here.
/// The pairing window closed: the code is cancelled, and the connection
/// closes again if no phone is paired.
pub async fn cancel_pairing() -> Result<(), String> {
    let Some(client) = client() else {
        return Ok(());
    };
    client.cancel_pairing().await.map_err(|e| e.to_string())?;
    disconnect_if_unneeded().await;
    Ok(())
}

pub async fn remove_phone(id: &str) -> Result<(), String> {
    let client = client().ok_or("Ingen forbindelse til relæet endnu.")?;
    let phone = DeviceId::from_b64u(id).map_err(|e| e.to_string())?;
    client.revoke_phone(phone).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The owner's v1 state: a confirmed room on v1's address, one phone.
    fn v1_room() -> wt_relay_client::StoredRoom {
        wt_relay_client::StoredRoom {
            relay_url: super::super::settings::V1_RELAY_URL.into(),
            room_id: wt_relay_client::wt_protocol::RoomId([7; 16]),
            salt: wt_relay_client::wt_protocol::Salt([8; 16]),
            created: true,
        }
    }

    #[test]
    fn a_v1_room_stays_the_room_after_the_move_to_walkietalkey_com() {
        // DESK-60, RELAY-03: the migration moves the relay address, and the
        // client counts the v1 room as this relay's, so it authenticates to
        // it with the paired phone (crates/wt-relay-client/tests/same_relay.rs
        // drives that against a fake relay) instead of making a new room.
        use super::super::settings::{WtSettings, DEFAULT_RELAY_URL, V1_RELAY_URL};
        let mut wt = WtSettings {
            relay_url: V1_RELAY_URL.into(),
            settings_version: 0,
            ..WtSettings::default()
        };
        let mut handy = crate::settings::get_default_settings();
        super::super::migrate::upgrade(&mut handy, &mut wt, true);
        assert_eq!(wt.relay_url, DEFAULT_RELAY_URL);

        let config = client_config(&wt);
        assert_eq!(config.relay_url, DEFAULT_RELAY_URL);
        assert!(config.is_same_relay(&v1_room().relay_url));
        // A user who never saved settings has the new default too.
        assert!(client_config(&WtSettings::default()).is_same_relay(V1_RELAY_URL));
        // Someone who keeps v1's address keeps a room made on the new one.
        let kept = WtSettings {
            relay_url: V1_RELAY_URL.into(),
            ..WtSettings::default()
        };
        assert!(client_config(&kept).is_same_relay(DEFAULT_RELAY_URL));
    }

    #[test]
    fn a_company_relay_has_no_aliases() {
        // A managed RelayUrl is another relay: a room there is new, as before.
        use super::super::settings::{WtSettings, DEFAULT_RELAY_URL, V1_RELAY_URL};
        let company = WtSettings {
            relay_url: "wss://relae.firma.dk".into(),
            ..WtSettings::default()
        };
        let config = client_config(&company);
        assert!(config.relay_aliases.is_empty());
        assert!(!config.is_same_relay(V1_RELAY_URL));
        assert!(!config.is_same_relay(DEFAULT_RELAY_URL));
        assert_eq!(
            relay_aliases(&format!("{DEFAULT_RELAY_URL}/")),
            vec![V1_RELAY_URL]
        );
    }

    #[test]
    fn the_pairing_qr_is_an_svg_in_brand_colours() {
        let svg = qr_svg("https://app.walkietalkey.com/p#eyJ2IjoxfQ").unwrap();
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
        assert!(svg.contains("#1b1a19"));
        // The secret part of the URL is never in the SVG as text.
        assert!(!svg.contains("eyJ2IjoxfQ"));
    }

    #[test]
    fn no_phone_pill_while_paused() {
        // DESK-96: "Sæt på pause" answers phone dictations with `paused`;
        // the pill does not show for them (DESK-58).
        use super::super::settings::WtSettings;
        let on = WtSettings::default();
        assert!(on.pill_for_phone, "on by default");
        assert!(pill_for_phone(&on, false, false));
        assert!(!pill_for_phone(&on, false, true), "paused");
        assert!(!pill_for_phone(&on, true, false), "a key dictation has it");
        let hidden = WtSettings {
            pill_hidden: true,
            ..WtSettings::default()
        };
        assert!(!pill_for_phone(&hidden, false, false));
        let off = WtSettings {
            pill_for_phone: false,
            ..WtSettings::default()
        };
        assert!(!pill_for_phone(&off, false, false));
    }
}
