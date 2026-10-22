//! Key dictation rules on top of Handy's coordinator (spec 6.3).
//!
//! Recording starts as soon as the key goes down (DESK-23), so the first word
//! is never cut. What waits is everything the user would notice: the pill and
//! the start sound only appear once the key has been held for the threshold,
//! a shorter hold is dropped silently (the coordinator's Discard effect), and
//! a dictation started with a modifier-only key (`fn`, Right Ctrl) is
//! cancelled silently when another key goes down, because the user was typing
//! a shortcut such as fn+Delete or fn+arrow (DESK-26).

use std::thread;
use std::time::{Duration, Instant};

use log::{debug, info, warn};
use tauri::AppHandle;

use crate::settings::{AppSettings, ShortcutActivation};

/// How long the key must be held before the pill and the start sound appear
/// (DESK-23). `None` when they appear at once (tap mode, or no threshold).
pub fn reveal_delay(settings: &AppSettings) -> Option<Duration> {
    (settings.shortcut_activation == ShortcutActivation::PushToTalk
        && settings.hold_threshold_ms > 0)
        .then(|| Duration::from_millis(settings.hold_threshold_ms))
}

/// Whether a hotkey has no key of its own (fn, Right Ctrl, option): such a
/// key is also a modifier, so another key pressed with it is a shortcut.
pub fn is_modifier_only(hotkey: &str) -> bool {
    hotkey
        .parse::<handy_keys::Hotkey>()
        .map(|hotkey| hotkey.key.is_none())
        .unwrap_or(false)
}

/// Runs `reveal` once the key has been held until `at`, if the same
/// recording is still going then (`is_current`). Quick taps never reveal.
pub fn reveal_at<C, R>(at: Instant, is_current: C, reveal: R)
where
    C: Fn() -> bool + Send + 'static,
    R: FnOnce() + Send + 'static,
{
    thread::spawn(move || {
        thread::sleep(at.saturating_duration_since(Instant::now()));
        if is_current() {
            reveal();
        }
    });
}

/// Watches the keyboard while a dictation started with a modifier-only key
/// is recording, and cancels it silently when any other key goes down
/// (DESK-26). Stops watching as soon as the recording is no longer current.
pub fn cancel_on_other_key<C>(app: AppHandle, is_current: C)
where
    C: Fn() -> bool + Send + 'static,
{
    thread::spawn(move || {
        let listener = match handy_keys::KeyboardListener::new() {
            Ok(listener) => listener,
            Err(e) => {
                warn!("Cannot watch for shortcut keys during dictation: {e}");
                return;
            }
        };
        while is_current() {
            let Ok(event) = listener.recv_timeout(Duration::from_millis(50)) else {
                continue;
            };
            if is_shortcut_key(&event) {
                if is_current() {
                    info!("Another key went down with the dictation key; cancelling silently");
                    crate::utils::cancel_current_operation(&app);
                }
                return;
            }
        }
        debug!("Dictation ended; stopped watching for shortcut keys");
    });
}

/// A key (not a modifier) going down.
fn is_shortcut_key(event: &handy_keys::KeyEvent) -> bool {
    event.is_key_down && event.key.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;

    #[test]
    fn hold_mode_reveals_after_the_threshold() {
        let settings = get_default_settings();
        assert_eq!(reveal_delay(&settings), Some(Duration::from_millis(300)));
    }

    #[test]
    fn tap_mode_reveals_at_once() {
        let mut settings = get_default_settings();
        settings.shortcut_activation = ShortcutActivation::Toggle;
        assert_eq!(reveal_delay(&settings), None);
        settings.shortcut_activation = ShortcutActivation::PushToTalk;
        settings.hold_threshold_ms = 0;
        assert_eq!(reveal_delay(&settings), None);
    }

    #[test]
    fn modifier_only_keys_are_recognised() {
        assert!(is_modifier_only("fn"));
        assert!(is_modifier_only("ctrl_right"));
        assert!(is_modifier_only("option"));
        assert!(!is_modifier_only("option+space"));
        assert!(!is_modifier_only("f13"));
        assert!(!is_modifier_only("not a key"));
    }

    #[test]
    fn only_a_key_going_down_counts_as_a_shortcut() {
        use handy_keys::{Key, KeyEvent, Modifiers};
        let event = |key: Option<Key>, down: bool| KeyEvent {
            modifiers: Modifiers::FN,
            key,
            is_key_down: down,
            changed_modifier: None,
        };
        assert!(is_shortcut_key(&event(Some(Key::Delete), true)));
        assert!(!is_shortcut_key(&event(Some(Key::Delete), false)));
        assert!(!is_shortcut_key(&event(None, true)), "fn itself is a modifier");
    }

    #[test]
    fn a_reveal_runs_only_for_the_current_recording() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let revealed = Arc::new(AtomicBool::new(false));
        let r = Arc::clone(&revealed);
        reveal_at(Instant::now(), || false, move || r.store(true, Ordering::SeqCst));
        let shown = Arc::new(AtomicBool::new(false));
        let s = Arc::clone(&shown);
        reveal_at(Instant::now(), || true, move || s.store(true, Ordering::SeqCst));
        thread::sleep(Duration::from_millis(50));
        assert!(!revealed.load(Ordering::SeqCst), "a finished tap never reveals");
        assert!(shown.load(Ordering::SeqCst));
    }
}
