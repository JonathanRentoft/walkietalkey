//! Receiving from the phone (spec 5, 6.8): one relay connection for this
//! computer's room (DESK-60), pairing with a QR (5.3), "Var det dig?" for
//! every new phone (DESK-62), phone dictations fed into a live chunked decode
//! as they arrive (DESK-61) and answered with a result that never carries the
//! text (DESK-64), and presence answers (DESK-63).

pub mod headless;
pub mod keystore;
pub mod session;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::{error, info, warn};
use once_cell::sync::Lazy;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::UnboundedReceiver;
use wt_relay_client::wt_protocol::{ComputerOs, DeviceId, ResultOutcome, ResultReason, SessionId};
use wt_relay_client::{ClientConfig, KeyStore, RelayClient, RelayEvent};

use self::session::{SessionAudio, RESEND_WAIT};
use super::output::Source;
use crate::managers::transcription::{SideStream, TranscriptionManager};

static CLIENT: Lazy<Mutex<Option<RelayClient>>> = Lazy::new(|| Mutex::new(None));

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

/// Starts the relay connection, unless the phone feature is turned off
/// (managed `AllowPhonePairing`).
pub fn start(app: &AppHandle) {
    let settings = super::store::get(app);
    if !settings.allow_phone_pairing {
        info!("Phone pairing is turned off; no relay connection");
        return;
    }
    let store = match open_store(app) {
        Ok(store) => store,
        Err(e) => {
            error!("Relay key store unavailable: {e}");
            return;
        }
    };
    let config = ClientConfig::new(
        settings.relay_url.clone(),
        settings.phone_app_url.clone(),
        computer_name(),
        computer_os(),
    );
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (client, events) = match RelayClient::start(config, store) {
            Ok(started) => started,
            Err(e) => {
                error!("Relay client did not start: {e}");
                return;
            }
        };
        *CLIENT.lock().unwrap() = Some(client.clone());
        watch_for_wake(client.clone());
        event_loop(app, client, events).await;
    });
}

/// DESK-60: reconnect right after sleep. A wall-clock jump between ticks of
/// a steady timer means the machine was asleep.
fn watch_for_wake(client: RelayClient) {
    std::thread::spawn(move || {
        let tick = Duration::from_secs(5);
        let mut last = SystemTime::now();
        loop {
            std::thread::sleep(tick);
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
            }
            RelayEvent::PhoneLeft { phone } | RelayEvent::PhoneRemoved { phone } => {
                NAMES.lock().unwrap().remove(&phone);
                emit_phones_changed(&app);
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
                let dictation = sessions.lock().unwrap().get(&(phone, session)).cloned();
                if let Some(dictation) = dictation {
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
    // DESK-58: the menu bar icon shows that a phone recording is coming in.
    crate::tray::set_tray_state(app, crate::tray::TrayIconState::Recording);
    let sessions = Arc::clone(sessions);
    super::tray::pulse_while(app.clone(), move || !sessions.lock().unwrap().is_empty());
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
    // DESK-61: wait up to 5 s for the phone's resend of missing blocks.
    let deadline = Instant::now() + RESEND_WAIT;
    while !dictation.lock().unwrap().audio.is_complete() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
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
    if crate::settings::get_settings(app).selected_model.is_empty() {
        return ResultOutcome::Failed(ResultReason::ModelNotReady);
    }
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
    super::dictation::save_history(app, &finished, &source, None);
    let settings = super::store::get(app);
    super::notify::text_ready(
        app,
        super::output::notification_body(&finished.final_text, settings.show_text_in_notifications),
        None,
    );
    drop(ticket);
    ResultOutcome::Ok
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
    let client = client().ok_or("Ingen forbindelse til relæet endnu.")?; // TODO(copy)
    let ticket = client.start_pairing().await.map_err(|e| e.to_string())?;
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
}
