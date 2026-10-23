//! Presence (DESK-63): what the app answers a phone's `presence_query` with. Nothing here
//! needs a permission prompt, and nothing is sent unasked.
//!
//! - **macOS**: `CGEventSourceSecondsSinceLastEventType` for any input in the combined session
//!   state; the screen counts as locked when `CGSessionCopyCurrentDictionary` reports
//!   `CGSSessionScreenIsLocked`, or when this session is not on the console (another user is
//!   switched in).
//! - **Windows**: `GetLastInputInfo` against `GetTickCount64`; the session's lock state from
//!   `WTSQuerySessionInformationW(WTSSessionInfoEx)`, a session that is not the active one
//!   counting as locked, with a fallback to "is the input desktop Winlogon's".
//! - Elsewhere: `0` and `false`.

/// Whole seconds since the last keyboard, mouse or trackpad input in this user session.
pub fn seconds_since_input() -> u32 {
    imp::seconds_since_input()
}

/// Whether the screen is locked (or this session is not the one at the screen).
pub fn screen_locked() -> bool {
    imp::screen_locked()
}

/// Rounds an idle time down to whole seconds; NaN and negatives are `0`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn whole_seconds(seconds: f64) -> u32 {
    if seconds.is_nan() || seconds <= 0.0 {
        0
    } else {
        // `as` saturates at u32::MAX.
        seconds as u32
    }
}

/// Windows: `GetLastInputInfo` reports a 32-bit tick count (wrapping every 49.7 days), so the
/// difference is taken in that domain.
#[cfg_attr(not(windows), allow(dead_code))]
fn idle_seconds(now_ms: u64, last_input_ms: u32) -> u32 {
    (now_ms as u32).wrapping_sub(last_input_ms) / 1000
}

/// Windows: the lock state from a `WTSINFOEX_LEVEL1_W`. `None` when Windows does not know.
#[cfg_attr(not(windows), allow(dead_code))]
fn session_locked(connect_state: i32, session_flags: i32) -> Option<bool> {
    const WTS_ACTIVE: i32 = 0;
    const WTS_SESSIONSTATE_LOCK: i32 = 0;
    const WTS_SESSIONSTATE_UNLOCK: i32 = 1;
    if connect_state != WTS_ACTIVE {
        // Disconnected, or switched away from: nobody is at this session.
        return Some(true);
    }
    match session_flags {
        WTS_SESSIONSTATE_LOCK => Some(true),
        WTS_SESSIONSTATE_UNLOCK => Some(false),
        _ => None,
    }
}

/// Windows: the lock screen, the secure attention screen and UAC prompts run on Winlogon's
/// desktop.
#[cfg_attr(not(windows), allow(dead_code))]
fn desktop_name_means_locked(name: &str) -> bool {
    name.eq_ignore_ascii_case("Winlogon")
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2_core_foundation::{CFBoolean, CFDictionary, CFRetained, CFString, CFType};
    use objc2_core_graphics::{
        CGEventSource, CGEventSourceStateID, CGEventType, CGSessionCopyCurrentDictionary,
    };

    /// `kCGAnyInputEventType` (`~0`), which the bindings do not name.
    const ANY_INPUT: CGEventType = CGEventType(u32::MAX);

    pub fn seconds_since_input() -> u32 {
        super::whole_seconds(CGEventSource::seconds_since_last_event_type(
            CGEventSourceStateID::CombinedSessionState,
            ANY_INPUT,
        ))
    }

    pub fn screen_locked() -> bool {
        let Some(session) = CGSessionCopyCurrentDictionary() else {
            // No window server session (ssh, launchd job): nobody can be at this screen.
            return true;
        };
        // SAFETY: the session dictionary has CFString keys; CFType accepts any value.
        let session =
            unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFType>>(session) };
        locked_from_session(&session)
    }

    pub fn locked_from_session(session: &CFDictionary<CFString, CFType>) -> bool {
        let flag = |key: &str| {
            session
                .get(&CFString::from_str(key))
                .and_then(|value| value.downcast_ref::<CFBoolean>().map(CFBoolean::as_bool))
        };
        let locked = flag("CGSSessionScreenIsLocked").unwrap_or(false);
        // kCGSessionOnConsoleKey
        let on_console = flag("kCGSSessionOnConsoleKey").unwrap_or(true);
        locked || !on_console
    }
}

#[cfg(windows)]
mod imp {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::RemoteDesktop::{
        WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
        WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
    };
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
        DESKTOP_READOBJECTS, UOI_NAME,
    };
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    pub fn seconds_since_input() -> u32 {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: `info` is a valid LASTINPUTINFO with cbSize set.
        if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            return 0;
        }
        // SAFETY: no arguments.
        let now = unsafe { GetTickCount64() };
        super::idle_seconds(now, info.dwTime)
    }

    pub fn screen_locked() -> bool {
        wts_locked().unwrap_or_else(input_desktop_is_winlogon)
    }

    fn wts_locked() -> Option<bool> {
        let mut buffer = PWSTR::null();
        let mut bytes = 0u32;
        // SAFETY: out-pointers are valid; the buffer is freed with WTSFreeMemory below.
        unsafe {
            WTSQuerySessionInformationW(
                Some(WTS_CURRENT_SERVER_HANDLE),
                WTS_CURRENT_SESSION,
                WTSSessionInfoEx,
                &mut buffer,
                &mut bytes,
            )
        }
        .ok()?;
        if buffer.is_null() {
            return None;
        }
        let result = if bytes as usize >= std::mem::size_of::<WTSINFOEXW>() {
            // SAFETY: for WTSSessionInfoEx the buffer holds one WTSINFOEXW.
            let info = unsafe { &*(buffer.0 as *const WTSINFOEXW) };
            if info.Level == 1 {
                // SAFETY: Level 1 means the union holds WTSInfoExLevel1.
                let level1 = unsafe { info.Data.WTSInfoExLevel1 };
                super::session_locked(level1.SessionState.0, level1.SessionFlags)
            } else {
                None
            }
        } else {
            None
        };
        // SAFETY: the buffer came from WTSQuerySessionInformationW.
        unsafe { WTSFreeMemory(buffer.0.cast()) };
        result
    }

    fn input_desktop_is_winlogon() -> bool {
        // SAFETY: plain call; the handle is closed below.
        let desktop =
            match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) }
            {
                Ok(desktop) => desktop,
                // A normal user cannot open Winlogon's secure desktop.
                Err(_) => return true,
            };
        let mut name = [0u16; 64];
        let mut needed = 0u32;
        // SAFETY: `name` is writable for its full byte length.
        let named = unsafe {
            GetUserObjectInformationW(
                HANDLE(desktop.0),
                UOI_NAME,
                Some(name.as_mut_ptr().cast()),
                std::mem::size_of_val(&name) as u32,
                Some(&mut needed),
            )
        };
        // SAFETY: opened above.
        let _ = unsafe { CloseDesktop(desktop) };
        if named.is_err() {
            return false;
        }
        let len = name
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(name.len());
        super::desktop_name_means_locked(&String::from_utf16_lossy(&name[..len]))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    pub fn seconds_since_input() -> u32 {
        0
    }

    pub fn screen_locked() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_times_round_down_and_saturate() {
        assert_eq!(whole_seconds(0.0), 0);
        assert_eq!(whole_seconds(-3.0), 0);
        assert_eq!(whole_seconds(f64::NAN), 0);
        assert_eq!(whole_seconds(59.99), 59);
        assert_eq!(whole_seconds(1e12), u32::MAX);
    }

    #[test]
    fn windows_idle_time_survives_the_tick_wrap() {
        assert_eq!(idle_seconds(10_500, 500), 10);
        // GetTickCount wrapped after the last input: now is past 2^32 ms.
        let now = (1u64 << 32) + 2_000;
        let last = u32::MAX - 999;
        assert_eq!(idle_seconds(now, last), 3);
        // Days of uptime, input a minute ago.
        let now = 5 * 86_400_000u64;
        assert_eq!(idle_seconds(now, (now - 60_000) as u32), 60);
    }

    #[test]
    fn windows_session_states() {
        assert_eq!(session_locked(0, 0), Some(true), "active, locked");
        assert_eq!(session_locked(0, 1), Some(false), "active, unlocked");
        assert_eq!(session_locked(0, -1), None, "unknown");
        assert_eq!(session_locked(4, 1), Some(true), "disconnected");
        assert!(desktop_name_means_locked("Winlogon"));
        assert!(desktop_name_means_locked("winlogon"));
        assert!(!desktop_name_means_locked("Default"));
    }

    #[test]
    fn live_values_are_sane() {
        // Whoever runs the tests has touched the machine within the last year, and the
        // lock state is a plain answer either way.
        let idle = seconds_since_input();
        let locked = screen_locked();
        eprintln!("seconds since input: {idle}, screen locked: {locked}");
        assert!(idle < 365 * 86_400);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_session_dictionary() {
        use objc2_core_foundation::{CFBoolean, CFDictionary, CFString, CFType};

        fn session(
            pairs: &[(&str, bool)],
        ) -> objc2_core_foundation::CFRetained<CFDictionary<CFString, CFType>> {
            let keys: Vec<_> = pairs.iter().map(|(k, _)| CFString::from_str(k)).collect();
            let key_refs: Vec<&CFString> = keys.iter().map(|k| &**k).collect();
            let values: Vec<&CFType> = pairs
                .iter()
                .map(|(_, v)| CFBoolean::new(*v).as_ref())
                .collect();
            CFDictionary::from_slices(&key_refs, &values)
        }

        use super::imp::locked_from_session;
        assert!(!locked_from_session(&session(&[(
            "kCGSSessionOnConsoleKey",
            true
        )])));
        assert!(locked_from_session(&session(&[
            ("kCGSSessionOnConsoleKey", true),
            ("CGSSessionScreenIsLocked", true)
        ])));
        assert!(locked_from_session(&session(&[(
            "kCGSSessionOnConsoleKey",
            false
        )])));
        assert!(!locked_from_session(&session(&[])));
    }
}
