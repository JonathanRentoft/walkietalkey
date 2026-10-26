//! WalkieTalkey's own desktop features, in their own modules apart from the
//! desktop core (DESK-05). The core calls in through a few narrow hooks: `startup` from `initialize_core_logic`, and the settings
//! overlay from `settings::get_settings`.

use std::sync::Arc;

use log::info;
use tauri::{AppHandle, Manager};

use crate::managers::transcription::TranscriptionManager;
use crate::settings::get_settings;

/// Runs once the managers exist. Loads the speech model right away, so the
/// first dictation after starting is as fast as the rest (DESK-45).
pub mod a11y;
pub mod bench;
pub mod catalog;
pub mod cleanup;
pub mod clipboard;
pub mod commands;
pub mod dictation;
pub mod fn_key;
pub mod globe;
pub mod history;
pub mod key_diag;
pub mod key_listener;
pub mod keys;
pub mod limits;
pub mod managed;
pub mod mic;
pub mod migrate;
pub mod models;
pub mod move_app;
pub mod notify;
pub mod output;
pub mod pill;
pub mod pill_window;
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
pub mod versions;
pub mod vocabulary;

static APP: once_cell::sync::OnceCell<AppHandle> = once_cell::sync::OnceCell::new();

/// Set once `setup` has run to its end: every manager and every piece of
/// state a dictation touches exists (run 5).
static READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The end of `setup` (lib.rs): dictations may start from now on.
pub fn mark_ready() {
    READY.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Whether a dictation may start. Run 4: a remote-control flag arrived while
/// setup was still waiting for the keychain dialog, its start reached state
/// that did not exist yet, and the panic ended the coordinator thread. A
/// start before setup is done is now refused (and logged) instead.
pub fn is_ready() -> bool {
    READY.load(std::sync::atomic::Ordering::SeqCst)
}

/// The app handle, for the few places Handy's code reaches us without one.
pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Makes [`app`] available, and nothing else: for the headless paths
/// (`--transcribe-file`, `--phone-receive`), whose pipeline reads our
/// settings too (the Udviklerord pack in `vocabulary::for_run`).
pub fn set_app_handle(app: &AppHandle) {
    let _ = APP.set(app.clone());
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
    set_app_handle(app);
    // Before anything reads the key or pill settings.
    migrate::run(app);
    key_diag::start(app);
    // The key listener itself starts once Secure Input is set up
    // (`key_listener::start`, from lib.rs).
    globe::reconcile(app);
    notify::init(app);
    select_default_model(app);
    models::download_default_at_first_launch(app);
    updates::start(app);
    relay::start(app);
    vocabulary::start(app);
    dictation::start_retention(app);
    punctuation::ensure(app);
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
        info!(
            "Selecting {} as the default model",
            catalog::DEFAULT_MODEL_ID
        );
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
        assert!(binding
            .current_binding
            .parse::<handy_keys::Hotkey>()
            .is_ok());
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
        assert!(crate::catalog::CATALOG.iter().any(|m| m
            .id
            .starts_with("handy-computer/whisper-large-v3-turbo-gguf/")));
    }

    #[test]
    fn default_dictation_behaviour_follows_the_spec() {
        let settings = get_default_settings();
        assert_eq!(
            settings.shortcut_activation,
            ShortcutActivation::HoldOrToggle,
            "DESK-22: tap for hands-free, hold to talk"
        );
        assert_eq!(settings.hold_threshold_ms, 500, "DESK-22");
        assert!(settings.audio_feedback, "DESK-23: sounds on by default");
        assert_eq!(settings.selected_language, "da", "DESK-70");
        assert_eq!(settings.app_language, "da", "DESK-03");
        assert_eq!(
            settings.model_unload_timeout,
            ModelUnloadTimeout::Never,
            "DESK-45"
        );
        assert!(settings.long_form_chunking, "DESK-46");
        assert!(settings.filler_word_removal_enabled, "DESK-44");
        assert!(
            !settings.post_process_enabled,
            "cleanup is WalkieTalkey's own mode"
        );
    }

    /// Every source file under `dir` with one of `exts`, as (path, text).
    fn sources(dir: &std::path::Path, exts: &[&str], out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, exts, out);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| exts.contains(&e))
            {
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                out.push((path.display().to_string(), text));
            }
        }
    }

    /// Run 5: a new Mac user grants two permissions, Microphone and Accessibility (the active
    /// event tap for fn and pasting), and nothing else is ever asked for: no Input Monitoring,
    /// Screen Recording, system audio, Automation or keychain.
    #[test]
    fn only_microphone_and_accessibility_are_ever_asked_for() {
        // The usage strings macOS shows in its prompts: the microphone's only.
        let info = include_str!("../../Info.plist");
        assert!(info.contains("NSMicrophoneUsageDescription"));
        assert_eq!(info.matches("UsageDescription</key>").count(), 1, "{info}");
        // Entitlements: the microphone, nothing for Apple Events, keychain groups or more.
        let entitlements = include_str!("../../Entitlements.plist");
        assert_eq!(entitlements.matches("<key>").count(), 2, "{entitlements}");
        assert!(entitlements.contains("com.apple.security.device.microphone"));
        assert!(entitlements.contains("com.apple.security.device.audio-input"));

        // The calls that would make macOS ask for something else. Spelled in pieces, so this
        // test does not find itself.
        let forbidden = [
            concat!("CGRequest", "ListenEventAccess"),
            concat!("IOHID", "RequestAccess"),
            concat!("CGRequest", "ScreenCaptureAccess"),
            concat!("CGWindowList", "CreateImage"),
            concat!("SCShareable", "Content"),
            concat!("AudioHardware", "CreateProcessTap"),
            concat!("NSApple", "Script"),
            concat!("tell ", "application"),
            concat!("ListenOnly", "EventTap"),
            concat!("OPTION_", "LISTEN_ONLY"),
            concat!("request", "InputMonitoringPermission"),
            concat!("request_input_", "monitoring_permission"),
            concat!("request", "ScreenRecordingPermission"),
            concat!("request_screen_", "recording_permission"),
            // The keychain has its own checks (secrets.rs, wt-native's lib.rs).
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        sources(&root.join("src"), &["rs"], &mut files);
        sources(&root.join("../crates/wt-native/src"), &["rs"], &mut files);
        sources(&root.join("../src"), &["ts", "tsx"], &mut files);
        assert!(files.len() > 100, "the sources were found");
        for (path, text) in &files {
            for word in forbidden {
                assert!(!text.contains(word), "{path} uses {word}");
            }
            // The only osascript calls are Handy's mute ("set volume", a Standard Additions
            // command with no target app, so no Automation prompt), behind a setting
            // WalkieTalkey does not show.
            if text.contains("\"osascript\"") {
                assert!(path.ends_with("managers/audio.rs"), "{path} runs osascript");
            }
        }
    }

    /// DESK-11, run 5: the speech model starts downloading in `setup` (through `startup`),
    /// before the window is shown, so before the first click; and `relay::start`, which once
    /// waited for a keychain dialog, comes after it and no longer blocks (it reads on a worker).
    #[test]
    fn the_model_download_starts_before_the_window_shows() {
        let lib = include_str!("../lib.rs");
        let setup = lib.find(".setup(move |app| {").expect("setup");
        let core = setup
            + lib[setup..]
                .find("initialize_core_logic(&app_handle);")
                .unwrap();
        let shown = setup + lib[setup..].find("show_main_window(&app_handle);").unwrap();
        assert!(
            core < shown,
            "the core (and startup) runs before the window shows"
        );

        let this = include_str!("mod.rs");
        let startup = this.find("pub fn startup(app: &AppHandle) {").unwrap();
        let body = &this[startup..];
        let download = body
            .find("models::download_default_at_first_launch(app);")
            .unwrap();
        let relay = body.find("relay::start(app);").unwrap();
        assert!(download < relay);
    }

    #[test]
    fn kept_handy_defaults_cover_cancel_paste_restore_and_login() {
        let settings = get_default_settings();
        // DESK-25: Esc while recording cancels without output (Handy's binding).
        assert_eq!(settings.bindings["cancel"].current_binding, "escape");
        // DESK-53: auto-paste restores the previous clipboard afterwards.
        assert_eq!(
            settings.clipboard_handling,
            crate::settings::ClipboardHandling::DontModify
        );
        // DESK-97: off until onboarding finishes, which turns it on.
        assert!(!settings.autostart_enabled);
    }
}
