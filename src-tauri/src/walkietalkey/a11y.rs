//! Screen reader announcements for the pill (spec 6.17). The pill lives in a
//! panel that never takes focus, so VoiceOver does not read its live region;
//! the overlay asks for a native announcement whenever its text changes.
//! Windows relies on the live region and on Narrator reading notifications.

use tauri::AppHandle;

/// The longest text worth announcing; the pill's states are a few words.
const MAX_CHARS: usize = 200;

/// The text to announce, or `None` when there is nothing sensible to say.
fn announcement(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty() && text.chars().count() <= MAX_CHARS).then(|| text.to_string())
}

pub fn announce(app: &AppHandle, text: &str) {
    let Some(text) = announcement(text) else {
        return;
    };
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || macos::post(&handle, &text));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, text);
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSAccessibilityAnnouncementKey, NSAccessibilityAnnouncementRequestedNotification,
        NSAccessibilityPostNotificationWithUserInfo, NSAccessibilityPriorityKey,
        NSAccessibilityPriorityLevel, NSApplication,
    };
    use objc2_foundation::{MainThreadMarker, NSDictionary, NSNumber, NSString};
    use tauri::{AppHandle, Manager};

    /// Posts a high-priority VoiceOver announcement from the pill's panel
    /// (or the app when the panel is gone). Runs on the main thread.
    pub fn post(app: &AppHandle, text: &str) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let message = NSString::from_str(text);
        let priority = NSNumber::new_isize(NSAccessibilityPriorityLevel::High.0);
        let application = NSApplication::sharedApplication(mtm);
        let panel = app
            .get_webview_window("recording_overlay")
            .and_then(|w| w.ns_window().ok())
            .filter(|ptr| !ptr.is_null());
        // SAFETY: the statics are AppKit's constant strings; the panel pointer
        // is the live NSWindow Tauri owns, used on the main thread only.
        unsafe {
            let keys: [&NSString; 2] = [NSAccessibilityAnnouncementKey, NSAccessibilityPriorityKey];
            let values: [&AnyObject; 2] = [
                AsRef::<AnyObject>::as_ref(&*message),
                AsRef::<AnyObject>::as_ref(&*priority),
            ];
            let info = NSDictionary::<NSString, AnyObject>::from_slices(&keys, &values);
            let element: &AnyObject = match panel {
                Some(ptr) => &*(ptr as *const AnyObject),
                None => AsRef::<AnyObject>::as_ref(&*application),
            };
            NSAccessibilityPostNotificationWithUserInfo(
                element,
                NSAccessibilityAnnouncementRequestedNotification,
                Some(&info),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::announcement;

    #[test]
    fn only_short_non_empty_text_is_announced() {
        assert_eq!(announcement("  Indsat "), Some("Indsat".to_string()));
        assert_eq!(announcement("   "), None);
        assert_eq!(announcement(&"a".repeat(201)), None);
    }
}
