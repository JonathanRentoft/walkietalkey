//! Presence (DESK-63): seconds since the last keyboard or mouse input and
//! whether the screen is locked, sent only as an answer to a phone's
//! presence_query. The lock state comes from the native module; until it is
//! linked in, only the idle time is measured (macOS).

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
}

/// `(seconds since input, screen locked)`.
pub fn current() -> (u32, bool) {
    (seconds_since_input(), false)
}

#[cfg(target_os = "macos")]
fn seconds_since_input() -> u32 {
    // kCGEventSourceStateCombinedSessionState = 0, kCGAnyInputEventType = !0.
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    if seconds.is_finite() && seconds >= 0.0 {
        seconds.min(f64::from(u32::MAX)) as u32
    } else {
        u32::MAX
    }
}

#[cfg(not(target_os = "macos"))]
fn seconds_since_input() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    #[test]
    fn idle_time_is_measured() {
        let (seconds, _) = super::current();
        assert!(seconds < u32::MAX);
    }
}
