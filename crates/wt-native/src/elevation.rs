//! Elevation (DESK-50). Windows blocks synthetic input (the auto-paste keystroke) into windows
//! of processes running at a higher integrity level, typically apps "run as administrator".
//! Before pasting, the app asks [`foreground_window_is_elevated_above_us`]; when it is true the
//! text goes to the clipboard (DESK-51) instead of disappearing.
//!
//! macOS and other platforms have no such barrier: the answer is always `false`.

/// True when the foreground window belongs to an elevated process and this process is not
/// elevated. A foreground process whose token cannot be read (access denied) counts as
/// elevated, so the app falls back to the clipboard rather than pasting into nothing.
pub fn foreground_window_is_elevated_above_us() -> bool {
    imp::foreground_window_is_elevated_above_us()
}

/// The decision, given the target's elevation (`None` = could not be read) and ours.
#[cfg_attr(not(windows), allow(dead_code))]
fn above_us(target_elevated: Option<bool>, we_are_elevated: bool) -> bool {
    !we_are_elevated && target_elevated.unwrap_or(true)
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    pub fn foreground_window_is_elevated_above_us() -> bool {
        // SAFETY: plain calls without pointers.
        let window = unsafe { GetForegroundWindow() };
        if window.is_invalid() {
            return false;
        }
        let mut pid = 0u32;
        // SAFETY: `pid` is a valid out-pointer.
        unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
        // SAFETY: no arguments.
        if pid == 0 || pid == unsafe { GetCurrentProcessId() } {
            return false;
        }
        // SAFETY: the pseudo handle needs no closing.
        let ours = token_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false);
        if ours {
            return false;
        }
        // SAFETY: the handle is closed below.
        let target = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(process) => {
                let elevated = token_elevated(process);
                // SAFETY: opened above.
                let _ = unsafe { CloseHandle(process) };
                elevated
            }
            Err(_) => None,
        };
        super::above_us(target, ours)
    }

    /// The process token's TokenElevation, or `None` when it cannot be read. Opening the
    /// token of an elevated process from a non-elevated one fails with access denied.
    fn token_elevated(process: HANDLE) -> Option<bool> {
        let mut token = HANDLE::default();
        // SAFETY: `token` is a valid out-pointer; closed below.
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        // SAFETY: the buffer is a TOKEN_ELEVATION of the size passed.
        let queried = unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            )
        };
        // SAFETY: opened above.
        let _ = unsafe { CloseHandle(token) };
        queried.ok()?;
        Some(elevation.TokenIsElevated != 0)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn foreground_window_is_elevated_above_us() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_higher_target_blocks_the_paste() {
        assert!(above_us(Some(true), false));
        assert!(!above_us(Some(false), false));
        assert!(!above_us(Some(true), true), "we are elevated too");
        assert!(!above_us(Some(false), true));
        // Unreadable target: assume elevated, unless we are.
        assert!(above_us(None, false));
        assert!(!above_us(None, true));
    }

    #[cfg(not(windows))]
    #[test]
    fn never_elevated_off_windows() {
        assert!(!foreground_window_is_elevated_above_us());
    }
}
