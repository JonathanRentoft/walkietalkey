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
pub mod catalog;
pub mod cleanup;
pub mod clipboard;
pub mod commands;
pub mod dictation;
pub mod history;
pub mod keys;
pub mod limits;
pub mod managed;
pub mod models;
pub mod notify;
pub mod output;
pub mod pill;
pub mod presence;
pub mod punctuation;
pub mod relay;
pub mod secrets;
pub mod sequence;
pub mod settings;
pub mod speed;
pub mod store;
pub mod tray;
pub mod updates;
pub mod vocabulary;

static APP: once_cell::sync::OnceCell<AppHandle> = once_cell::sync::OnceCell::new();

/// The app handle, for the few places Handy's code reaches us without one.
pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Before Tauri starts: the organisation's managed settings, so every read
/// of the settings sees them (DESK-100).
pub fn early_init() {
    let values: managed::ManagedValues = wt_native::managed::read_managed()
        .into_iter()
        .map(|(key, value)| {
            let value = match value {
                wt_native::managed::ManagedValue::Text(t) => managed::ManagedValue::Text(t),
                wt_native::managed::ManagedValue::Bool(b) => managed::ManagedValue::Bool(b),
                wt_native::managed::ManagedValue::Int(i) => managed::ManagedValue::Int(i),
            };
            (key, value)
        })
        .collect();
    store::set_managed_values(values);
}

pub fn startup(app: &AppHandle) {
    let _ = APP.set(app.clone());
    notify::init(app);
    select_default_model(app);
    updates::start(app);
    relay::start(app);
    vocabulary::start(app);
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

/// Edda is the default model (DESK-30): picked when nothing is selected yet
/// and its file is installed (downloaded, or imported with "Importér
/// modelfil").
fn select_default_model(app: &AppHandle) {
    let mut settings = get_settings(app);
    if !settings.selected_model.is_empty() {
        return;
    }
    let Some(mm) = app.try_state::<Arc<crate::managers::model::ModelManager>>() else {
        return;
    };
    if mm
        .get_model_info(catalog::DEFAULT_MODEL_ID)
        .is_some_and(|model| model.is_downloaded)
    {
        info!("Selecting {} as the default model", catalog::DEFAULT_MODEL_ID);
        settings.selected_model = catalog::DEFAULT_MODEL_ID.to_string();
        crate::settings::write_settings(app, settings);
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
    fn edda_is_in_the_catalog_and_ranked_first() {
        let edda = crate::catalog::CATALOG
            .iter()
            .find(|m| m.id == super::catalog::DEFAULT_MODEL_ID)
            .expect("Edda in the catalog");
        assert!(edda.recommended);
        assert_eq!(edda.recommended_rank, Some(0));
        // Handy's own models are still offered under "Andre modeller" (DESK-34).
        assert!(crate::catalog::CATALOG
            .iter()
            .any(|m| m.id.starts_with("handy-computer/whisper-large-v3-turbo-gguf/")));
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
