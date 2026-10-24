//! Whether the app may use the microphone, in the three states the Mikrofon step needs
//! (DESK-12, run 5): macOS asks only while the answer is `NotDetermined`; after a "no" (or a
//! profile that restricts it) only System Settings can change it, so the step's one button
//! must open the pane at once instead of asking again in vain.
//!
//! macOS: `AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio`, a query that
//! never shows anything. Elsewhere: `Granted` (Windows has its own privacy check).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicAccess {
    /// Never asked: the system's question shows on request.
    NotDetermined,
    /// The user said no: only System Settings can change it.
    Denied,
    /// A profile or parental control forbids it.
    Restricted,
    Granted,
}

impl MicAccess {
    /// From `AVAuthorizationStatus` (0 not determined, 1 restricted, 2 denied, 3 authorized).
    pub fn from_status(status: isize) -> Self {
        match status {
            0 => MicAccess::NotDetermined,
            1 => MicAccess::Restricted,
            2 => MicAccess::Denied,
            _ => MicAccess::Granted,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            MicAccess::NotDetermined => "not_determined",
            MicAccess::Denied => "denied",
            MicAccess::Restricted => "restricted",
            MicAccess::Granted => "granted",
        }
    }
}

/// The current answer; `None` when it cannot be read (no AVFoundation).
pub fn access() -> Option<MicAccess> {
    imp::access()
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;
    use objc2_foundation::NSString;

    use super::MicAccess;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    pub fn access() -> Option<MicAccess> {
        let class = AnyClass::get(c"AVCaptureDevice")?;
        // AVMediaTypeAudio's value.
        let audio = NSString::from_str("soun");
        // SAFETY: a class method that takes an NSString and returns an NSInteger.
        let status: isize = unsafe { msg_send![class, authorizationStatusForMediaType: &*audio] };
        Some(MicAccess::from_status(status))
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::MicAccess;

    pub fn access() -> Option<MicAccess> {
        Some(MicAccess::Granted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_the_three_answers() {
        assert_eq!(MicAccess::from_status(0), MicAccess::NotDetermined);
        assert_eq!(MicAccess::from_status(1), MicAccess::Restricted);
        assert_eq!(MicAccess::from_status(2), MicAccess::Denied);
        assert_eq!(MicAccess::from_status(3), MicAccess::Granted);
        assert_eq!(MicAccess::Denied.as_str(), "denied");
    }

    /// The query never shows a dialog and always has an answer on a Mac.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_mac_answers_without_asking() {
        assert!(access().is_some());
    }
}
