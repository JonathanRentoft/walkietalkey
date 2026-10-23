//! System notifications (DESK-56, DESK-57, Appendix A). Posting and the click
//! handler (which opens the history with the item selected) are native code:
//! a UNUserNotificationCenter delegate on macOS and a toast activation handler
//! on Windows. Until that module is linked in, notifications go to the app's
//! own window as `wt-notify` events.

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Type)]
pub struct Notice {
    pub title: String,
    pub body: String,
    /// The history item a click opens (DESK-57).
    pub history_id: Option<i64>,
}

fn post(app: &AppHandle, notice: Notice) {
    log::info!("Notification: {}", notice.title);
    let _ = app.emit("wt-notify", notice);
}

/// A phone dictation is on the clipboard (DESK-56).
pub fn text_ready(app: &AppHandle, body: String, history_id: Option<i64>) {
    post(
        app,
        Notice {
            title: "Tekst klar til at indsætte".to_string(),
            body,
            history_id,
        },
    );
}

/// "Ny telefon parret: {navn}. Var det dig?" (DESK-62).
pub fn phone_joined(app: &AppHandle, name: &str) {
    post(
        app,
        Notice {
            title: format!("Ny telefon parret: {name}. Var det dig?"),
            body: String::new(),
            history_id: None,
        },
    );
}

/// "Opdatering klar. Genstart for at installere" (DESK-111).
pub fn update_ready(app: &AppHandle) {
    post(
        app,
        Notice {
            title: "Opdatering klar. Genstart for at installere".to_string(),
            body: String::new(),
            history_id: None,
        },
    );
}
