//! Whether Shift is held right now, for "Kun når jeg holder Shift med" (DESK-80). The app
//! asks at the moment a dictation ends. macOS answers this in the app itself through
//! CoreGraphics; this module covers Windows and returns `false` elsewhere.

/// Whether a Shift key is down at this moment.
pub fn shift_down() -> bool {
    imp::shift_down()
}

#[cfg(windows)]
mod imp {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};

    pub fn shift_down() -> bool {
        // SAFETY: takes a virtual-key code and returns the key's state; no pointers.
        let state = unsafe { GetAsyncKeyState(i32::from(VK_SHIFT.0)) };
        (state as u16) & 0x8000 != 0
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn shift_down() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn answers_without_panicking() {
        let _ = super::shift_down();
    }
}
