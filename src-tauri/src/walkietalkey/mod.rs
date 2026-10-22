//! WalkieTalkey's own desktop features, kept out of Handy's modules so monthly
//! upstream merges stay small (DESK-05). Handy's code calls in through a few
//! narrow hooks: `startup` from `initialize_core_logic`, and the settings
//! overlay from `settings::get_settings`.

use std::sync::Arc;

use log::info;
use tauri::{AppHandle, Manager};

use crate::managers::transcription::TranscriptionManager;
use crate::settings::get_settings;

/// Runs once the managers exist. Loads the speech model right away, so the
/// first dictation after starting is as fast as the rest (DESK-45).
pub fn startup(app: &AppHandle) {
    let settings = get_settings(app);
    if !settings.selected_model.is_empty() {
        if let Some(tm) = app.try_state::<Arc<TranscriptionManager>>() {
            info!(
                "Loading speech model '{}' at start (DESK-45)",
                settings.selected_model
            );
            tm.initiate_model_load();
        }
    }
}
