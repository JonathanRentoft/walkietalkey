//! Receiving from the phone (spec 5, 6.8): one relay connection for this
//! computer's room (DESK-60), pairing with a QR (5.3), "Var det dig?" for
//! every new phone (DESK-62), phone dictations fed into a live chunked decode
//! as they arrive (DESK-61) and answered with a result that never carries the
//! text (DESK-64), and presence answers (DESK-63).

pub mod headless;
pub mod keystore;
pub mod session;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::{error, info, warn};
use once_cell::sync::Lazy;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::UnboundedReceiver;
use wt_relay_client::wt_protocol::{ComputerOs, DeviceId, ResultOutcome, ResultReason, SessionId};
use wt_relay_client::{ClientConfig, ClientError, KeyStore, RelayClient, RelayEvent};

use self::session::{SessionAudio, RESEND_WAIT};
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

/// A phone dictation in progress.
struct PhoneDictation {
    audio: SessionAudio,
    side: Option<SideStream>,
    started: Instant,
    paused: bool,
}

type Sessions = Arc<Mutex<HashMap<(DeviceId, SessionId), Arc<Mutex<PhoneDictation>>>>>;

/// Dictations whose `audio_end` came, while they wait up to 5 s for the
/// phone's resend of missing blocks (DESK-61): resent blocks still land here.
static ENDING: Lazy<Mutex<HashMap<(DeviceId, SessionId), Arc<Mutex<PhoneDictation>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// The dictation a block belongs to: one still recording, or one waiting
/// after its `audio_end` for resent blocks (DESK-61).
fn dictation_for_audio(
    sessions: &Sessions,
    key: &(DeviceId, SessionId),
) -> Option<Arc<Mutex<PhoneDictation>>> {
    let recording = sessions.lock().unwrap().get(key).cloned();
    recording.or_else(|| ENDING.lock().unwrap().get(key).cloned())
}

/// A phone dictation longer than this is answered `too_long` (PHONE-29: the
/// phone itself stops at 5:00).
const TOO_LONG: Duration = Duration::from_secs(5 * 60 + 15);

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

/// Opens the key store: keys in the keychain, the rest in the data folder.
fn open_store(app: &AppHandle) -> anyhow::Result<Arc<dyn KeyStore>> {
    let dir = crate::portable::app_data_dir(app)?.join("relay");
    let store = keystore::DesktopKeyStore::open(&dir).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(Arc::new(store))
}

/// Starts the relay connection when a phone is paired. Without one, nothing
/// connects (spec 5.3, PRIV-04): "Par en telefon" connects and creates the
/// room. Nothing connects when the phone feature is turned off (managed
/// `AllowPhonePairing`).
pub fn start(app: &AppHandle) {
    let settings = super::store::get(app);
    if !settings.allow_phone_pairing {
        info!("Phone pairing is turned off; no relay connection");
        return;
    }
    let paired = match open_store(app) {
        Ok(store) => store.load_phones().map(|p| !p.is_empty()).unwrap_or(false),
        Err(e) => {
            error!("Relay key store unavailable: {e}");
            return;
        }
    };
    if !paired {
        info!("No phone is paired; the relay connects when one is");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
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
    let config = ClientConfig::new(
        settings.relay_url.clone(),
        settings.phone_app_url.clone(),
        computer_name(),
        computer_os(),
    );
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
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    while let Some(event) = events.recv().await {
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
                emit_phones_changed(&app);
                tauri::async_runtime::spawn(disconnect_if_unneeded());
            }
            RelayEvent::PeerStatus { .. } => emit_phones_changed(&app),
            RelayEvent::AudioStart { phone, session, .. } => {
                on_audio_start(&app, &sessions, phone, session);
            }
            RelayEvent::AudioChunk {
                phone,
                session,
                index,
                pcm,
            } => {
                if let Some(dictation) = dictation_for_audio(&sessions, &(phone, session)) {
                    let mut d = dictation.lock().unwrap();
                    let ready = d.audio.add(index, &pcm);
                    if !ready.is_empty() {
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
                let dictation = sessions.lock().unwrap().remove(&(phone, session));
                if let Some(dictation) = dictation {
                    dictation.lock().unwrap().audio.end(chunks);
                    ENDING
                        .lock()
                        .unwrap()
                        .insert((phone, session), Arc::clone(&dictation));
                    // DESK-27: the place in the output order is taken now.
                    let ticket = super::sequence::take_ticket();
                    let (app, client) = (app.clone(), client.clone());
                    tauri::async_runtime::spawn(async move {
                        finish_phone_dictation(app, client, phone, session, dictation, ticket)
                            .await;
                    });
                }
            }
            RelayEvent::AudioCancel { phone, session } => {
                if let Some(dictation) = sessions.lock().unwrap().remove(&(phone, session)) {
                    if let Some(side) = dictation.lock().unwrap().side.take() {
                        side.cancel();
                    }
                }
                listening_ended(&app, &sessions);
            }
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

#[derive(Debug, Clone, Serialize, Type)]
pub struct PhoneJoined {
    pub id: String,
    pub name: String,
}

fn on_audio_start(app: &AppHandle, sessions: &Sessions, phone: DeviceId, session: SessionId) {
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
    sessions.lock().unwrap().insert(
        (phone, session),
        Arc::new(Mutex::new(PhoneDictation {
            audio: SessionAudio::new(),
            side,
            started: Instant::now(),
            paused,
        })),
    );
    // DESK-58: the menu bar icon shows that a phone recording is coming in,
    // and the pill too when that is chosen.
    crate::tray::set_tray_state(app, crate::tray::TrayIconState::Recording);
    if phone_pill(app) {
        crate::overlay::show_recording_overlay(app);
    }
    let sessions = Arc::clone(sessions);
    super::tray::pulse_while(app.clone(), move || !sessions.lock().unwrap().is_empty());
}

/// DESK-58: the pill for phone dictations, when that setting is on and the
/// pill is not hidden. A key dictation owns the pill while it records.
fn phone_pill(app: &AppHandle) -> bool {
    let wt = super::store::get(app);
    let key_recording = app
        .try_state::<Arc<crate::managers::audio::AudioRecordingManager>>()
        .is_some_and(|rm| rm.is_recording());
    wt.pill_for_phone && !wt.pill_hidden && !key_recording
}

fn listening_ended(app: &AppHandle, sessions: &Sessions) {
    if sessions.lock().unwrap().is_empty() {
        crate::tray::set_tray_state(app, crate::tray::TrayIconState::Idle);
    }
}

async fn finish_phone_dictation(
    app: AppHandle,
    client: RelayClient,
    phone: DeviceId,
    session: SessionId,
    dictation: Arc<Mutex<PhoneDictation>>,
    ticket: super::sequence::Ticket,
) {
    crate::tray::set_tray_state(&app, crate::tray::TrayIconState::Transcribing);
    let pill = phone_pill(&app);
    if pill {
        crate::overlay::show_transcribing_overlay(&app);
    }
    // DESK-61: wait up to 5 s for the phone's resend of missing blocks.
    let deadline = Instant::now() + RESEND_WAIT;
    while !dictation.lock().unwrap().audio.is_complete() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    ENDING.lock().unwrap().remove(&(phone, session));
    let (side, audio, paused, too_long) = {
        let mut d = dictation.lock().unwrap();
        let rest = d.audio.give_up_on_gaps();
        if let Some(side) = &d.side {
            if !rest.is_empty() {
                side.feed(rest);
            }
        }
        let too_long =
            d.audio.duration() > TOO_LONG || d.started.elapsed() > TOO_LONG + RESEND_WAIT;
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
        return Err("Telefonparring er slået fra af din organisation.".into()); // TODO(copy)
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
                return Err("Ingen forbindelse til relæet. Prøv igen.".into()); // TODO(copy)
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
}

pub async fn status(app: &AppHandle) -> RelayView {
    let enabled = super::store::get(app).allow_phone_pairing;
    let Some(client) = client() else {
        return RelayView {
            enabled,
            connected: false,
            phones: Vec::new(),
            pairing_active: false,
        };
    };
    match client.status().await {
        Ok(status) => RelayView {
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
    let client = client().ok_or("Ingen forbindelse til relæet endnu.")?; // TODO(copy)
    let phone = DeviceId::from_b64u(id).map_err(|e| e.to_string())?;
    client.revoke_phone(phone).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pairing_qr_is_an_svg_in_brand_colours() {
        let svg = qr_svg("https://walkietalkey-app.pages.dev/p#eyJ2IjoxfQ").unwrap();
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
        assert!(svg.contains("#1b1a19"));
        // The secret part of the URL is never in the SVG as text.
        assert!(!svg.contains("eyJ2IjoxfQ"));
    }

    fn dictation() -> Arc<Mutex<PhoneDictation>> {
        Arc::new(Mutex::new(PhoneDictation {
            audio: SessionAudio::new(),
            side: None,
            started: Instant::now(),
            paused: false,
        }))
    }

    #[test]
    fn blocks_resent_after_audio_end_still_reach_the_dictation() {
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        let key = (DeviceId([7; 16]), SessionId([9; 16]));
        let d = dictation();
        sessions.lock().unwrap().insert(key, Arc::clone(&d));
        assert!(dictation_for_audio(&sessions, &key).is_some(), "recording");
        // audio_end: out of the recording map, into the waiting one (DESK-61).
        let ended = sessions.lock().unwrap().remove(&key).unwrap();
        ENDING.lock().unwrap().insert(key, ended);
        let found = dictation_for_audio(&sessions, &key).expect("a resend is still accepted");
        assert!(Arc::ptr_eq(&found, &d));
        ENDING.lock().unwrap().remove(&key);
        assert!(
            dictation_for_audio(&sessions, &key).is_none(),
            "after the wait"
        );
    }
}
