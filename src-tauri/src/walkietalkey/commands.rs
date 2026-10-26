//! Tauri commands for WalkieTalkey's own settings screens.

use tauri::AppHandle;

use super::settings::WtSettings;
use super::store::{self, WtSettingsView};

/// The WalkieTalkey settings in effect, with the managed locks.
#[tauri::command]
#[specta::specta]
pub fn wt_get_settings(app: AppHandle) -> WtSettingsView {
    store::view(&app)
}

/// Stores the user's WalkieTalkey settings; locked fields are ignored.
#[tauri::command]
#[specta::specta]
pub fn wt_update_settings(app: AppHandle, settings: WtSettings) -> Result<WtSettingsView, String> {
    let before = store::get(&app);
    let view = store::update(&app, settings)?;
    let after = store::get(&app);
    // A shorter retention or audio switched off applies at once (DESK-91, DESK-92).
    if before.history_retention != after.history_retention
        || before.keep_audio_for_debugging != after.keep_audio_for_debugging
    {
        super::dictation::run_retention(&app);
    }
    Ok(view)
}

/// "Importér modelfil" (DESK-32): installs a model file the user already
/// has, if its SHA-256 matches a known model. Returns the model id.
#[tauri::command]
#[specta::specta]
pub async fn wt_import_model_file(app: AppHandle, path: String) -> Result<String, String> {
    use std::sync::Arc;
    use tauri::Manager;

    let models_dir = crate::portable::app_data_dir(&app)
        .map_err(|e| e.to_string())?
        .join("models");
    let source = std::path::PathBuf::from(path);
    let model_id = tauri::async_runtime::spawn_blocking(move || {
        super::models::import_model_file(&source, &models_dir)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if model_id == super::models::PUNCTUATION_ID {
        // Ekko PnC: whatever did not come with the file is fetched.
        super::punctuation::ensure(&app);
        return Ok(model_id);
    }
    if let Some(mm) = app.try_state::<Arc<crate::managers::model::ModelManager>>() {
        mm.rescan_local_models().map_err(|e| e.to_string())?;
    }
    let mut settings = crate::settings::get_settings(&app);
    if settings.selected_model.is_empty() {
        settings.selected_model = model_id.clone();
        crate::settings::write_settings(&app, settings);
    }
    let _ = tauri::Emitter::emit(&app, "model-download-complete", &model_id);
    Ok(model_id)
}

/// Indstillinger › Telefon › "Par en telefon": a new pairing code as a QR.
#[tauri::command]
#[specta::specta]
pub async fn wt_pairing_start(app: AppHandle) -> Result<super::relay::PairingView, String> {
    super::relay::start_pairing(&app).await
}

/// The pairing window was closed: cancel the code (spec 5.3 step 1).
#[tauri::command]
#[specta::specta]
pub async fn wt_pairing_cancel() -> Result<(), String> {
    super::relay::cancel_pairing().await
}

/// Connection state and the paired phones.
#[tauri::command]
#[specta::specta]
pub async fn wt_relay_status(app: AppHandle) -> super::relay::RelayView {
    super::relay::status(&app).await
}

/// "Fjern" next to a phone (SEC-04).
#[tauri::command]
#[specta::specta]
pub async fn wt_phone_remove(id: String) -> Result<(), String> {
    super::relay::remove_phone(&id).await
}

/// Stores the user's own API key for a cleanup provider in the keychain
/// (DESK-81). An empty key removes it.
#[tauri::command]
#[specta::specta]
pub fn wt_set_cleanup_key(provider: String, key: String) -> Result<(), String> {
    super::cleanup::keys::set(&provider, &key)
}

/// Whether a key is stored for a provider (the key itself never goes to the UI).
#[tauri::command]
#[specta::specta]
pub fn wt_has_cleanup_key(provider: String) -> bool {
    super::cleanup::keys::has(&provider)
}

fn history_db(app: &AppHandle) -> Result<(rusqlite::Connection, std::path::PathBuf), String> {
    let dir = crate::portable::app_data_dir(app).map_err(|e| e.to_string())?;
    let (db, recordings) = super::history::paths(&dir);
    Ok((
        super::history::open(&db).map_err(|e| e.to_string())?,
        recordings,
    ))
}

/// History, newest first, optionally searched (DESK-93).
#[tauri::command]
#[specta::specta]
pub fn wt_history_list(
    app: AppHandle,
    query: Option<String>,
) -> Result<Vec<super::history::HistoryItem>, String> {
    let (conn, _) = history_db(&app)?;
    super::history::list(&conn, query.as_deref(), 500).map_err(|e| e.to_string())
}

/// Deletes one history item, or everything with `id` = None ("Slet al historik").
#[tauri::command]
#[specta::specta]
pub fn wt_history_delete(app: AppHandle, id: Option<i64>) -> Result<usize, String> {
    let (conn, recordings) = history_db(&app)?;
    let ids = id.map(|id| vec![id]);
    let deleted =
        super::history::delete(&conn, &recordings, ids.as_deref()).map_err(|e| e.to_string())?;
    let _ = tauri::Emitter::emit(&app, "wt-history-changed", ());
    crate::tray::update_tray_menu(&app);
    Ok(deleted)
}

/// Copies a history item, privately like every clipboard write (DESK-54).
#[tauri::command]
#[specta::specta]
pub fn wt_history_copy(app: AppHandle, id: i64) -> Result<(), String> {
    let (conn, _) = history_db(&app)?;
    let text = super::history::text_of(&conn, id)
        .map_err(|e| e.to_string())?
        .ok_or("Teksten findes ikke længere.")?;
    crate::clipboard::write_text(&app, &text)
}

/// Pause or resume (DESK-96), for the settings window.
#[tauri::command]
#[specta::specta]
pub fn wt_set_paused(app: AppHandle, paused: bool) {
    super::tray::set_paused(&app, paused);
}

/// "Genstart nu" in the settings: installs a downloaded update and restarts
/// (DESK-111), as the menu's "Genstart nu" does.
#[tauri::command]
#[specta::specta]
pub fn wt_restart_now(app: AppHandle) {
    super::updates::restart_now(&app);
}

/// Ekko PnC's state for Indstillinger › Model (DESK-41).
#[tauri::command]
#[specta::specta]
pub fn wt_punctuation_status(app: AppHandle) -> super::punctuation::PncStatus {
    super::punctuation::status(&app)
}

/// "Prøv igen" for the punctuation model's download.
#[tauri::command]
#[specta::specta]
pub fn wt_punctuation_download(app: AppHandle) {
    super::punctuation::download(&app);
}

/// Whether dictation is paused, for a window that opens while it is.
#[tauri::command]
#[specta::specta]
pub fn wt_is_paused() -> bool {
    super::tray::is_paused()
}

/// Announces the pill's text to VoiceOver (spec 6.17); the overlay calls it
/// when its text changes.
#[tauri::command]
#[specta::specta]
pub fn wt_announce(app: AppHandle, text: String) {
    super::a11y::announce(&app, &text);
}

/// Checks for an update now ("Søg efter opdateringer").
#[tauri::command]
#[specta::specta]
pub fn wt_check_updates(app: AppHandle) {
    super::updates::check_now(&app);
}

/// DESK-31: transcribes the bundled 10-second Danish clip with the selected
/// model (warm) and says whether to offer the fast model.
#[tauri::command]
#[specta::specta]
pub async fn wt_measure_speed(app: AppHandle) -> Result<super::speed::SpeedVerdict, String> {
    use std::sync::Arc;
    use tauri::Manager;

    let clip = app
        .path()
        .resolve(
            "resources/speed-check/da-fleurs-10s.wav",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;
    let samples = crate::audio_toolkit::read_wav_samples(&clip).map_err(|e| e.to_string())?;
    let tm = app
        .try_state::<Arc<crate::managers::transcription::TranscriptionManager>>()
        .map(|tm| Arc::clone(&tm))
        .ok_or("Talemodellen er ikke klar endnu")?;
    let seconds = tauri::async_runtime::spawn_blocking(move || -> Result<f64, String> {
        let model = crate::settings::get_settings(&app).selected_model;
        if !tm.is_model_loaded() {
            tm.load_model(&model).map_err(|e| e.to_string())?;
        }
        // The first run warms the GPU; the second is the one measured.
        tm.transcribe(samples.clone()).map_err(|e| e.to_string())?;
        let started = std::time::Instant::now();
        tm.transcribe(samples).map_err(|e| e.to_string())?;
        Ok(started.elapsed().as_secs_f64())
    })
    .await
    .map_err(|e| e.to_string())??;
    let fast_model = crate::catalog::CATALOG
        .iter()
        .any(|m| m.id.starts_with("walkietalkey/ekko-v1-tiny-gguf/"));
    Ok(super::speed::verdict(seconds, fast_model))
}

/// Notification permission for onboarding (DESK-15): "granted", "denied" or
/// "not_determined"; "unavailable" outside a bundled app.
#[tauri::command]
#[specta::specta]
pub fn wt_notification_permission() -> String {
    use wt_native::notification_permission::{check, PermissionState};
    match check() {
        Ok(PermissionState::Granted) => "granted",
        Ok(PermissionState::Denied) => "denied",
        Ok(PermissionState::NotDetermined) => "not_determined",
        Err(_) => "unavailable",
    }
    .to_string()
}

/// The Mikrofon step's one button (DESK-12, run 5): "not_determined" (macOS
/// asks), "denied" or "restricted" (only System Settings can change it, so
/// the button opens the pane at once), "granted", or "unknown".
#[tauri::command]
#[specta::specta]
pub fn wt_microphone_access() -> String {
    wt_native::microphone::access()
        .map_or("unknown", |a| a.as_str())
        .to_string()
}

/// Asks for notification permission (DESK-15); true when granted.
#[tauri::command]
#[specta::specta]
pub async fn wt_request_notification_permission() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        wt_native::notifications::request_permission().unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// "Ret det for mig" (DESK-20): whether fn is the key and the Globe key
/// still has an action of its own.
#[tauri::command]
#[specta::specta]
pub fn wt_globe_key_status(app: AppHandle) -> super::globe::GlobeKeyStatus {
    super::globe::current(&app)
}

/// "Ret det for mig" (DESK-20): sets the Globe key to "Do Nothing" while fn
/// is the dictation key, saving the previous value to restore later.
#[tauri::command]
#[specta::specta]
pub fn wt_globe_key_fix(app: AppHandle) -> Result<super::globe::GlobeKeyStatus, String> {
    super::globe::fix_now(&app)
}

/// Whether the key listener runs (DESK-13), the same as the last
/// `wt-key-listener` event, for a window that opened after it.
#[tauri::command]
#[specta::specta]
pub fn wt_key_listener_status() -> super::key_listener::KeyListenerStatus {
    super::key_listener::status()
}

/// Accessibility was granted before and is gone now (DESK-13), the same as
/// the `wt-accessibility-lost` event, for a window that opened after it.
#[tauri::command]
#[specta::specta]
pub fn wt_accessibility_lost() -> bool {
    super::key_listener::is_accessibility_lost()
}

/// Repairs a grant macOS dropped after an update (DESK-13): resets the
/// app's own Accessibility entry and shows macOS's own dialog. Returns
/// whether the app is trusted now; the key starts by itself once it is.
#[tauri::command]
#[specta::specta]
pub fn wt_accessibility_repair(app: AppHandle) -> bool {
    super::key_listener::repair(&app)
}

/// The silent-microphone notice (DESK-59), the same as the last
/// `wt-mic-check` event, for a window that opened after it.
#[tauri::command]
#[specta::specta]
pub fn wt_mic_check_status() -> super::mic::MicCheck {
    super::mic::status()
}

/// "Brug {navn}" (DESK-59): records from that input from now on.
#[tauri::command]
#[specta::specta]
pub async fn wt_mic_use(app: AppHandle, name: String) -> Result<(), String> {
    super::mic::use_input(&app, name).await
}

/// "Tjek igen" (DESK-59): listens to the silent input again, and probes the
/// others if it is still silent. The answer comes as `wt-mic-check`.
#[tauri::command]
#[specta::specta]
pub fn wt_mic_recheck(app: AppHandle) {
    super::mic::recheck(&app)
}
