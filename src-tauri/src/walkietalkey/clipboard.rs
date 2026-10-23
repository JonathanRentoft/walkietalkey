//! Clipboard privacy (DESK-54). Unless "Del med mine andre enheder" is on,
//! the text is written for this computer only: on macOS with NSPasteboard's
//! current-host-only option, so Universal Clipboard does not send it to the
//! user's other Apple devices. (Windows: the history and cloud exclusion
//! formats, in the native crate.)

use tauri::AppHandle;

/// Writes `text` privately when privacy applies. `None` means "not handled
/// here": the caller writes it the ordinary way.
pub fn write_private(app: &AppHandle, text: &str) -> Option<Result<(), String>> {
    if super::store::get(app).share_clipboard_with_devices {
        return None;
    }
    write_this_computer_only(text)
}

#[cfg(target_os = "macos")]
fn write_this_computer_only(text: &str) -> Option<Result<(), String>> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardContentsOptions, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    // Clears the pasteboard and marks the new contents as this Mac's only.
    pasteboard.prepareForNewContentsWithOptions(NSPasteboardContentsOptions::CurrentHostOnly);
    // SAFETY: NSPasteboardTypeString is a read-only framework static.
    let written =
        pasteboard.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
    Some(if written {
        Ok(())
    } else {
        Err("NSPasteboard did not accept the text".to_string())
    })
}

/// Windows: the formats that keep the text out of Clipboard History and the
/// Cloud Clipboard.
#[cfg(target_os = "windows")]
fn write_this_computer_only(text: &str) -> Option<Result<(), String>> {
    Some(wt_native::clipboard_windows::write_text(text).map_err(|e| e.to_string()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn write_this_computer_only(_text: &str) -> Option<Result<(), String>> {
    None
}
