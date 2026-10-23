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
