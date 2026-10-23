//! The end of a dictation (spec 6.4 steps 6-8): the user's replacements, the
//! optional AI cleanup, history, and delivery. Key dictations come here from
//! Handy's transcribe action; phone dictations from the relay module.

use std::sync::Arc;

use log::{error, warn};
use tauri::{AppHandle, Manager};

use super::cleanup::{self, CleanupOutcome};
use super::history::{self, CleanupRecord};
use super::output::{self, Delivery, Source};
use super::store;
use crate::managers::history::HistoryManager;

/// A dictation's text after steps 6 and 7.
#[derive(Debug, Clone, PartialEq)]
pub struct Finished {
    /// The text that goes out.
    pub final_text: String,
    /// The text after the local steps, before cleanup.
    pub local_text: String,
    pub cleanup: Option<CleanupRecord>,
    /// A guardrail fired; the local text is used (DESK-84).
    pub cleanup_fell_back: bool,
}

impl Finished {
    pub fn cleaned(&self) -> bool {
        self.final_text != self.local_text
    }
}

/// Steps 6 and 7 for a recognised text. A key dictation's cleanup may have
/// run chunk by chunk already (DESK-47).
pub async fn process(app: &AppHandle, transcription: &str, key_dictation: bool, shift_held: bool) -> Finished {
    let settings = store::get(app);
    let local_text = output::local_text(transcription, &settings);
    if local_text.trim().is_empty() {
        return Finished {
            final_text: String::new(),
            local_text,
            cleanup: None,
            cleanup_fell_back: false,
        };
    }
    match cleanup::clean(app, &local_text, key_dictation, shift_held).await {
        CleanupOutcome::NotUsed => Finished {
            final_text: local_text.clone(),
            local_text,
            cleanup: None,
            cleanup_fell_back: false,
        },
        CleanupOutcome::Cleaned { text, record } => Finished {
            final_text: text,
            local_text,
            cleanup: record,
            cleanup_fell_back: false,
        },
        CleanupOutcome::FellBack => Finished {
            final_text: local_text.clone(),
            local_text,
            cleanup: None,
            cleanup_fell_back: true,
        },
    }
}

/// Saves the dictation to history (DESK-90) unless retention is "Gem ikke",
/// then applies retention. `audio_file` is set only when "Gem lyd til
/// fejlfinding" kept the recording (DESK-92).
pub fn save_history(app: &AppHandle, finished: &Finished, source: &Source, audio_file: Option<&str>) {
    let settings = store::get(app);
    let Some(hm) = app.try_state::<Arc<HistoryManager>>() else {
        return;
    };
    if settings.history_retention.days() == Some(0) || finished.final_text.trim().is_empty() {
        return;
    }
    let cleaned = finished.cleaned();
    let entry = match hm.save_entry(
        audio_file.unwrap_or_default().to_string(),
        finished.local_text.clone(),
        cleaned,
        cleaned.then(|| finished.final_text.clone()),
        None,
    ) {
        Ok(entry) => entry,
        Err(e) => {
            error!("Failed to save history entry: {e}");
            return;
        }
    };
    let Ok(dir) = crate::portable::app_data_dir(app) else {
        return;
    };
    let (db_path, recordings) = history::paths(&dir);
    match history::open(&db_path) {
        Ok(conn) => {
            if let Err(e) = history::save_meta(&conn, entry.id, &source.label(), finished.cleanup.as_ref()) {
                warn!("Failed to save history details: {e}");
            }
            let now = chrono::Utc::now().timestamp();
            if let Err(e) = history::apply_retention(&conn, &recordings, settings.history_retention, now) {
                warn!("History retention failed: {e}");
            }
        }
        Err(e) => warn!("Failed to open history database: {e}"),
    }
    let _ = tauri::Emitter::emit(app, "wt-history-changed", ());
}

/// Whether a key dictation may paste: macOS needs Accessibility (DESK-14).
pub async fn can_paste() -> bool {
    #[cfg(target_os = "macos")]
    {
        tauri_plugin_macos_permissions::check_accessibility_permission().await
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Delivers a key dictation's text: paste, or clipboard (DESK-50, DESK-51).
/// Returns how it went out; a failed paste falls back to the clipboard.
pub fn deliver(app: &AppHandle, text: String, delivery: Delivery) -> Result<Delivery, String> {
    match delivery {
        Delivery::Paste => match crate::utils::paste(text.clone(), app.clone()) {
            Ok(()) => Ok(Delivery::Paste),
            Err(e) => {
                warn!("Paste failed ({e}); the text goes to the clipboard");
                crate::clipboard::write_text(app, &text).map(|_| Delivery::Clipboard)
            }
        },
        Delivery::Clipboard => crate::clipboard::write_text(app, &text).map(|_| Delivery::Clipboard),
    }
}
