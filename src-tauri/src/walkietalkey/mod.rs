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
pub mod bench;
pub mod clipboard;
pub mod commands;
pub mod history;
pub mod keys;
pub mod managed;
pub mod output;
pub mod settings;
pub mod store;

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

#[cfg(test)]
mod tests {
    use crate::settings::{get_default_settings, ModelUnloadTimeout, ShortcutActivation};

    #[test]
    fn default_key_is_fn_on_mac_and_right_ctrl_on_windows() {
        let settings = get_default_settings();
        let binding = &settings.bindings["transcribe"];
        #[cfg(target_os = "macos")]
        assert_eq!(binding.current_binding, "fn", "DESK-20");
        #[cfg(target_os = "windows")]
        assert_eq!(binding.current_binding, "ctrl_right", "DESK-21");
        assert_eq!(binding.current_binding, binding.default_binding);
        assert!(binding.current_binding.parse::<handy_keys::Hotkey>().is_ok());
    }

    #[test]
    fn default_dictation_behaviour_follows_the_spec() {
        let settings = get_default_settings();
        assert_eq!(settings.shortcut_activation, ShortcutActivation::PushToTalk, "DESK-22");
        assert_eq!(settings.hold_threshold_ms, 300, "DESK-26");
        assert!(settings.audio_feedback, "DESK-23: sounds on by default");
        assert_eq!(settings.selected_language, "da", "DESK-70");
        assert_eq!(settings.app_language, "da", "DESK-03");
        assert_eq!(settings.model_unload_timeout, ModelUnloadTimeout::Never, "DESK-45");
        assert!(settings.long_form_chunking, "DESK-46");
        assert!(settings.filler_word_removal_enabled, "DESK-44");
        assert!(!settings.post_process_enabled, "cleanup is WalkieTalkey's own mode");
    }
}
