//! The DictationPill's last state (DESK-55): "Indsat", "Tekst klar til at
//! indsætte", "Hørte ikke noget" or "Brugte teksten uden oprydning", then the
//! pill hides 1.5 s after the end. The overlay window draws it from the
//! `wt-pill-end` event; screen readers hear it there (6.17).

use std::thread;
use std::time::Duration;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};

use super::output::{paste_shortcut, PillEnd};

/// How long the pill stays after the end.
pub const LINGER: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize, Type)]
pub struct PillEndEvent {
    pub state: PillEnd,
    /// "⌘V" or "Ctrl+V", for "Tekst klar til at indsætte".
    pub shortcut: String,
}

/// Shows the end state, then hides the pill after [`LINGER`] unless another
/// recording has taken it over (`still_ours`).
pub fn finish<F>(app: &AppHandle, state: PillEnd, still_ours: F)
where
    F: Fn() -> bool + Send + 'static,
{
    let _ = app.emit(
        "wt-pill-end",
        PillEndEvent {
            state,
            shortcut: paste_shortcut().to_string(),
        },
    );
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(LINGER);
        if still_ours() {
            crate::utils::hide_recording_overlay(&app);
        }
    });
}

/// "Talemodellen er ikke klar endnu" for a moment, when the key is held but
/// no model can transcribe yet (still downloading, or none chosen).
pub fn not_ready(app: &AppHandle) {
    if super::store::get(app).pill_hidden {
        return;
    }
    crate::overlay::show_transcribing_overlay(app);
    let _ = app.emit("wt-pill-not-ready", ());
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(LINGER);
        crate::utils::hide_recording_overlay(&app);
    });
}
