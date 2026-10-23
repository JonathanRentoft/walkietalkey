//! The WalkieTalkey desktop app's small native platform layer, kept out of `src-tauri` so it
//! has no Tauri dependency, compiles fast, and its Windows code can be type-checked on a Mac.
//!
//! | Module | Spec | macOS | Windows |
//! |---|---|---|---|
//! | [`secrets`] | SEC-09, SEC-10, DESK-81 | login Keychain generic passwords, never synchronizable | Credential Manager, `CRED_PERSIST_LOCAL_MACHINE` |
//! | [`clipboard_windows`] | DESK-54 | (not used; the app writes with NSPasteboard current-host-only) | clipboard formats that keep text out of Clipboard History and Cloud Clipboard |
//! | [`notifications`] | DESK-56, DESK-57 | `UNUserNotificationCenter` with a delegate | toasts with an `Activated` handler |
//! | [`notification_permission`] | DESK-15 | `getNotificationSettings` | the toast notifier's setting |
//! | [`managed`] | DESK-100..102, Appendix B | forced `CFPreferences` values of `com.walkietalkey.app` | `HKLM\SOFTWARE\Policies\WalkieTalkey` |
//! | [`presence`] | DESK-63 | seconds since input, screen lock | the same |
//! | [`elevation`] | DESK-50 | always `false` | is the foreground window elevated above us? |
//! | [`keyboard`] | DESK-80 | (the app asks CoreGraphics itself) | is Shift held? |
//!
//! Every function is safe to call on platforms it does not cover: it returns a neutral value
//! or an `Unsupported` error, so the app needs no `cfg` at the call sites.

pub mod clipboard_windows;
pub mod elevation;
pub mod keyboard;
pub mod managed;
pub mod notification_permission;
pub mod notifications;
pub mod presence;
pub mod secrets;

pub use managed::{read_managed, ManagedValue};
