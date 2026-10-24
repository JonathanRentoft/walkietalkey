//! System notifications (DESK-56, DESK-57, Appendix A): posted through the
//! native module (UNUserNotificationCenter on macOS, toasts on Windows); a
//! click opens the history with that item selected. When notifications are
//! unavailable (not a bundled app, or no permission yet) the app's own window
//! gets the same notice as a `wt-notify` event.

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

/// Starts the native notifications and routes clicks to the history.
pub fn init(app: &AppHandle) {
    if let Err(e) = wt_native::notifications::init("com.walkietalkey.app") {
        log::info!("System notifications unavailable: {e}");
        return;
    }
    let app = app.clone();
    wt_native::notifications::on_click(Box::new(move |history_id| {
        crate::show_main_window(&app);
        let _ = app.emit("wt-open-history", history_id);
    }));
}

fn post(app: &AppHandle, notice: Notice) {
    log::info!("Notification: {}", notice.title);
    let posted = wt_native::notifications::available()
        && wt_native::notifications::post(&notice.title, &notice.body, notice.history_id).is_ok();
    if !posted {
        let _ = app.emit("wt-notify", notice);
    }
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
