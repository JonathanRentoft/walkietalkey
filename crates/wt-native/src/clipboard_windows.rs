//! Clipboard privacy on Windows (DESK-54). [`write_text`] puts the text on the clipboard
//! together with the registered formats that keep an entry out of Clipboard History
//! (Win+V) and Cloud Clipboard sync, and ask clipboard monitors to leave it alone:
//!
//! | Format | Data |
//! |---|---|
//! | `CanIncludeInClipboardHistory` | DWORD 0 |
//! | `CanUploadToCloudClipboard` | DWORD 0 |
//! | `ExcludeClipboardContentFromMonitorProcessing` | any (DWORD 0) |
//! | `CF_UNICODETEXT` | the text, UTF-16, NUL-terminated |
//!
//! [`write_text_shared`] writes only `CF_UNICODETEXT`, for the setting "Del med mine andre
//! enheder". On macOS the app writes with NSPasteboard's current-host-only option itself
//! (`src-tauri/src/walkietalkey/clipboard.rs`); off Windows both functions return
//! [`ClipboardError::Unsupported`].
//!
//! Text after an interior NUL character is cut off, as for any `CF_UNICODETEXT` reader.

/// Why the clipboard could not be written.
#[derive(Debug, thiserror::Error)]
pub enum ClipboardError {
    #[error("the clipboard is held by another application")]
    Busy,
    #[error("clipboard error: {0}")]
    Platform(String),
    #[error("this clipboard writer is for Windows only")]
    Unsupported,
}

/// `CanIncludeInClipboardHistory`: DWORD 0 keeps the entry out of Clipboard History.
pub const CAN_INCLUDE_IN_CLIPBOARD_HISTORY: &str = "CanIncludeInClipboardHistory";
/// `CanUploadToCloudClipboard`: DWORD 0 keeps the entry off the user's other devices.
pub const CAN_UPLOAD_TO_CLOUD_CLIPBOARD: &str = "CanUploadToCloudClipboard";
/// `ExcludeClipboardContentFromMonitorProcessing`: present means "monitors, ignore this".
pub const EXCLUDE_CLIPBOARD_CONTENT_FROM_MONITOR_PROCESSING: &str =
    "ExcludeClipboardContentFromMonitorProcessing";

/// Writes `text` for this computer only: not in Clipboard History, not synced (DESK-54).
pub fn write_text(text: &str) -> Result<(), ClipboardError> {
    imp::write(&entries(text, true))
}

/// Writes `text` as ordinary clipboard text, which Windows may keep in Clipboard History and
/// sync to the user's other devices ("Del med mine andre enheder").
pub fn write_text_shared(text: &str) -> Result<(), ClipboardError> {
    imp::write(&entries(text, false))
}

/// A clipboard format: a registered one by name, or `CF_UNICODETEXT`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Registered(&'static str),
    UnicodeText,
}

/// What goes on the clipboard, in order: the privacy formats first, then the text.
fn entries(text: &str, private: bool) -> Vec<(Format, Vec<u8>)> {
    let mut out = Vec::with_capacity(4);
    if private {
        for name in [
            CAN_INCLUDE_IN_CLIPBOARD_HISTORY,
            CAN_UPLOAD_TO_CLOUD_CLIPBOARD,
            EXCLUDE_CLIPBOARD_CONTENT_FROM_MONITOR_PROCESSING,
        ] {
            out.push((Format::Registered(name), 0u32.to_le_bytes().to_vec()));
        }
    }
    out.push((Format::UnicodeText, unicode_text(text)));
    out
}

/// `CF_UNICODETEXT` bytes: UTF-16LE with a terminating NUL.
fn unicode_text(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(windows)]
mod imp {
    use std::time::Duration;

    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows_core::{HSTRING, PCWSTR};

    use super::{ClipboardError, Format};

    const OPEN_ATTEMPTS: u32 = 20;
    const OPEN_RETRY: Duration = Duration::from_millis(5);

    fn platform(err: windows_core::Error) -> ClipboardError {
        ClipboardError::Platform(err.message())
    }

    /// Closes the clipboard when dropped, also on early returns.
    struct Open;

    impl Open {
        fn new() -> Result<Self, ClipboardError> {
            for attempt in 0..OPEN_ATTEMPTS {
                // SAFETY: no owner window; closed by Drop.
                if unsafe { OpenClipboard(None) }.is_ok() {
                    return Ok(Open);
                }
                if attempt + 1 < OPEN_ATTEMPTS {
                    std::thread::sleep(OPEN_RETRY);
                }
            }
            Err(ClipboardError::Busy)
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            // SAFETY: opened by Open::new on this thread.
            let _ = unsafe { CloseClipboard() };
        }
    }

    pub fn write(entries: &[(Format, Vec<u8>)]) -> Result<(), ClipboardError> {
        let _open = Open::new()?;
        // SAFETY: the clipboard is open on this thread.
        unsafe { EmptyClipboard() }.map_err(platform)?;
        for (format, data) in entries {
            let id = match format {
                Format::UnicodeText => u32::from(CF_UNICODETEXT.0),
                Format::Registered(name) => {
                    let name = HSTRING::from(*name);
                    // SAFETY: `name` is a NUL-terminated wide string that outlives the call.
                    let id = unsafe { RegisterClipboardFormatW(PCWSTR(name.as_ptr())) };
                    if id == 0 {
                        return Err(platform(windows_core::Error::from_win32()));
                    }
                    id
                }
            };
            set_data(id, data)?;
        }
        Ok(())
    }

    /// Copies `data` into a movable global block and hands it to the clipboard, which owns
    /// it from then on. On failure the block is freed here.
    fn set_data(format: u32, data: &[u8]) -> Result<(), ClipboardError> {
        // SAFETY: plain allocation; freed below unless the clipboard takes it.
        let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, data.len().max(1)) }.map_err(platform)?;
        // SAFETY: `memory` is a live movable block.
        let target = unsafe { GlobalLock(memory) };
        if target.is_null() {
            let err = windows_core::Error::from_win32();
            // SAFETY: allocated above and not handed to the clipboard.
            let _ = unsafe { GlobalFree(Some(memory)) };
            return Err(platform(err));
        }
        // SAFETY: the block holds at least `data.len()` bytes and does not overlap `data`.
        unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), target.cast::<u8>(), data.len()) };
        // SAFETY: locked above. Unlocking the last lock "fails" with NO_ERROR; ignore it.
        let _ = unsafe { GlobalUnlock(memory) };
        // SAFETY: the clipboard is open; on success it owns `memory`.
        match unsafe { SetClipboardData(format, Some(HANDLE(memory.0))) } {
            Ok(_) => Ok(()),
            Err(err) => {
                // SAFETY: the clipboard did not take the block.
                let _ = unsafe { GlobalFree(Some(memory)) };
                Err(platform(err))
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{ClipboardError, Format};

    pub fn write(_entries: &[(Format, Vec<u8>)]) -> Result<(), ClipboardError> {
        Err(ClipboardError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_text_carries_the_exclusion_formats_first() {
        let e = entries("Hej", true);
        let formats: Vec<Format> = e.iter().map(|(f, _)| *f).collect();
        assert_eq!(
            formats,
            vec![
                Format::Registered("CanIncludeInClipboardHistory"),
                Format::Registered("CanUploadToCloudClipboard"),
                Format::Registered("ExcludeClipboardContentFromMonitorProcessing"),
                Format::UnicodeText,
            ]
        );
        for (_, data) in &e[..3] {
            assert_eq!(data, &vec![0, 0, 0, 0], "DWORD 0");
        }
        assert_eq!(e[3].1, vec![b'H', 0, b'e', 0, b'j', 0, 0, 0]);
    }

    #[test]
    fn shared_text_is_plain_unicode_text() {
        let e = entries("æ", false);
        assert_eq!(e, vec![(Format::UnicodeText, vec![0xE6, 0x00, 0, 0])]);
    }

    #[test]
    fn unicode_text_is_utf16_with_a_terminator() {
        assert_eq!(unicode_text(""), vec![0, 0]);
        // A character outside the BMP is a surrogate pair.
        assert_eq!(unicode_text("😀"), vec![0x3D, 0xD8, 0x00, 0xDE, 0, 0]);
    }

    #[cfg(not(windows))]
    #[test]
    fn unsupported_off_windows() {
        assert!(matches!(write_text("x"), Err(ClipboardError::Unsupported)));
        assert!(matches!(write_text_shared("x"), Err(ClipboardError::Unsupported)));
    }
}
