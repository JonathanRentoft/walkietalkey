//! The notification permission for onboarding step 6 (DESK-15).
//!
//! - **macOS**: `UNUserNotificationCenter getNotificationSettings`, with the same bundle
//!   caveat as [`crate::notifications`]: outside a bundled `.app` the answer is
//!   [`NotifyError::NotBundled`]. Blocks for the few milliseconds the system takes to answer
//!   (at most 5 s).
//! - **Windows**: the toast notifier's setting for the app's AUMID (after
//!   [`crate::notifications::init`]). There is no prompt, so the answer is never
//!   `NotDetermined`.
//! - Elsewhere: [`NotifyError::Unsupported`].
//!
//! To ask, use [`crate::notifications::request_permission`].

pub use crate::notifications::NotifyError;

/// Whether the app may show notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionState {
    /// Notifications are delivered (on macOS also provisional or ephemeral delivery).
    Granted,
    /// The user (or a policy) turned them off.
    Denied,
    /// macOS: the user has not been asked yet.
    NotDetermined,
}

/// The current notification permission, without prompting.
pub fn check() -> Result<PermissionState, NotifyError> {
    crate::notifications::imp::permission_state()
}
