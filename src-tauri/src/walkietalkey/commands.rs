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
    store::update(&app, settings)
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
    match super::relay::client() {
        Some(client) => client.cancel_pairing().await.map_err(|e| e.to_string()),
        None => Ok(()),
    }
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
