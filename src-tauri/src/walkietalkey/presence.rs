//! Presence (DESK-63): seconds since the last keyboard or mouse input and
//! whether the screen is locked, sent only as an answer to a phone's
//! presence_query.

/// `(seconds since input, screen locked)`.
pub fn current() -> (u32, bool) {
    (
        wt_native::presence::seconds_since_input(),
        wt_native::presence::screen_locked(),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn presence_is_measured() {
        let (seconds, _) = super::current();
        assert!(seconds < u32::MAX);
    }
}
