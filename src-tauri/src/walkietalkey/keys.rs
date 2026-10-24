//! Key dictation rules on top of Handy's coordinator (spec 6.3).
//!
//! Tap or hold (DESK-22, DESK-26): recording starts as soon as the key goes
//! down (DESK-23), so the first word is never cut. Released within the
//! hold threshold (0.5 s) it is hands-free and records until the next tap or
//! Esc; held longer it is push-to-talk and stops on release. What waits is
//! everything the user would notice: the pill and the start sound appear once
//! the key has been held for 300 ms, or at once when a tap turns the
//! recording hands-free, so `fn` shortcuts stay silent. A dictation started
//! with a modifier-only key (`fn`, Right Ctrl) is cancelled silently when
//! another key goes down while that key is held, because the user was typing
//! a shortcut such as fn+Delete or fn+arrow (DESK-26).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use log::{debug, info, warn};
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};

use crate::settings::{AppSettings, ShortcutActivation};

/// How long a key must be held before the pill and the start sound appear
/// (DESK-23). A push-to-talk hold shorter than this is dropped silently.
pub const REVEAL_DELAY: Duration = Duration::from_millis(300);

/// The hold-or-tap threshold (DESK-22): released within it, hands-free.
pub const DEFAULT_HOLD_THRESHOLD_MS: u64 = 500;

/// How long the key must be held before the pill and the start sound appear
/// (DESK-23). `None` when they appear at once (tap-to-toggle mode).
pub fn reveal_delay(settings: &AppSettings) -> Option<Duration> {
    (settings.shortcut_activation != ShortcutActivation::Toggle).then_some(REVEAL_DELAY)
}

type IsCurrent = Box<dyn Fn() -> bool + Send + Sync>;
type Show = Box<dyn FnOnce() + Send>;

/// The pill and the start sound of one key recording: shown once, when the
/// key has been held long enough or the recording turned hands-free, and
/// only while that recording is still the current one.
pub struct RevealGate {
    open: AtomicBool,
    is_current: IsCurrent,
    show: Mutex<Option<Show>>,
}

impl RevealGate {
    pub fn new<C, S>(is_current: C, show: S) -> Arc<Self>
    where
        C: Fn() -> bool + Send + Sync + 'static,
        S: FnOnce() + Send + 'static,
    {
        Arc::new(Self {
            open: AtomicBool::new(false),
            is_current: Box::new(is_current),
            show: Mutex::new(Some(Box::new(show))),
        })
    }

    /// Shows the pill now (once), if the recording is still current.
    pub fn open(&self) {
        if !(self.is_current)() || self.open.swap(true, Ordering::SeqCst) {
            return;
        }
        let show = self.show.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(show) = show {
            show();
        }
    }

    /// Shows the pill now, before recording has begun (tap-to-toggle).
    pub fn open_now(&self) {
        if self.open.swap(true, Ordering::SeqCst) {
            return;
        }
        let show = self.show.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(show) = show {
            show();
        }
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Waits until the gate opens, or `still_wanted` stops holding (the
    /// recording ended). Returns whether it opened. For the start sound.
    pub fn wait_open<W: Fn() -> bool>(&self, still_wanted: W) -> bool {
        while !self.is_open() {
            if !still_wanted() {
                return false;
            }
            thread::sleep(Duration::from_millis(10));
        }
        true
    }
}

/// The current key recording's gate, for the coordinator's hands-free notice.
static CURRENT_GATE: Lazy<Mutex<Option<Arc<RevealGate>>>> = Lazy::new(|| Mutex::new(None));

pub fn set_current_gate(gate: &Arc<RevealGate>) {
    *CURRENT_GATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(gate));
}

/// Opens `gate` at `at` (the key held for [`REVEAL_DELAY`]). A tap that ended
/// the recording before then never reveals.
pub fn reveal_at(at: Instant, gate: Arc<RevealGate>) {
    thread::spawn(move || {
        thread::sleep(at.saturating_duration_since(Instant::now()));
        gate.open();
    });
}

/// The coordinator turned the current key recording hands-free (DESK-22):
/// the pill shows at once, with its lock and "Tryk igen for at stoppe".
pub fn hands_free(app: &AppHandle, binding_id: &str) {
    info!("Dictation with '{binding_id}' is hands-free until the next press");
    let gate = CURRENT_GATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(gate) = gate {
        gate.open();
    }
    let _ = app.emit("wt-pill-handsfree", true);
}

/// Whether [`cancel_on_other_key`] must watch this key: modifier-only keys
/// that handy-keys drives. `fn` alone on macOS has its own tap, which does
/// the same (`fn_key`).
pub fn watches_other_keys(hotkey: &str) -> bool {
    is_modifier_only(hotkey) && !super::fn_key::claims(hotkey)
}

/// Whether a hotkey has no key of its own (fn, Right Ctrl, option): such a
/// key is also a modifier, so another key pressed with it is a shortcut.
pub fn is_modifier_only(hotkey: &str) -> bool {
    hotkey
        .parse::<handy_keys::Hotkey>()
        .map(|hotkey| hotkey.key.is_none())
        .unwrap_or(false)
}

/// Watches the keyboard while a dictation started with a modifier-only key
/// is recording, and cancels it silently when another key goes down while
/// the dictation key is still held (DESK-26). Once the dictation key goes up
/// (tap mode records on), other keys are ordinary typing and the watch ends;
/// it also ends as soon as the recording is no longer current.
pub fn cancel_on_other_key<C>(app: AppHandle, binding: &str, is_current: C)
where
    C: Fn() -> bool + Send + 'static,
{
    let held = binding
        .parse::<handy_keys::Hotkey>()
        .map(|h| h.modifiers)
        .unwrap_or_else(|_| handy_keys::Modifiers::empty());
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
            if released(&event, held) {
                debug!("The dictation key went up; other keys no longer cancel");
                return;
            }
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

/// The dictation key itself going up.
fn released(event: &handy_keys::KeyEvent, held: handy_keys::Modifiers) -> bool {
    !event.is_key_down
        && event.key.is_none()
        && event.changed_modifier.is_some_and(|m| held.intersects(m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;

    #[test]
    fn tap_or_hold_is_the_default_with_half_a_second() {
        // DESK-22: tap for hands-free, hold for push-to-talk.
        let settings = get_default_settings();
        assert_eq!(
            settings.shortcut_activation,
            ShortcutActivation::HoldOrToggle
        );
        assert_eq!(settings.hold_threshold_ms, DEFAULT_HOLD_THRESHOLD_MS);
        assert_eq!(DEFAULT_HOLD_THRESHOLD_MS, 500);
    }

    #[test]
    fn holds_reveal_after_300_ms_and_toggle_at_once() {
        // DESK-23: the pill waits 300 ms in both hold modes.
        let mut settings = get_default_settings();
        assert_eq!(reveal_delay(&settings), Some(Duration::from_millis(300)));
        settings.shortcut_activation = ShortcutActivation::PushToTalk;
        assert_eq!(reveal_delay(&settings), Some(REVEAL_DELAY));
        settings.shortcut_activation = ShortcutActivation::Toggle;
        assert_eq!(reveal_delay(&settings), None);
    }

    #[test]
    fn the_fn_tap_watches_fn_itself() {
        assert!(watches_other_keys("ctrl_right"));
        assert_eq!(watches_other_keys("fn"), !cfg!(target_os = "macos"));
        assert!(!watches_other_keys("f13"));
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
        assert!(
            !is_shortcut_key(&event(None, true)),
            "fn itself is a modifier"
        );
    }

    #[test]
    fn releasing_the_dictation_key_ends_the_watch() {
        use handy_keys::{KeyEvent, Modifiers};
        let fn_up = KeyEvent {
            modifiers: Modifiers::empty(),
            key: None,
            is_key_down: false,
            changed_modifier: Some(Modifiers::FN),
        };
        assert!(released(&fn_up, Modifiers::FN));
        let fn_down = KeyEvent {
            is_key_down: true,
            ..fn_up
        };
        assert!(!released(&fn_down, Modifiers::FN));
        let shift_up = KeyEvent {
            changed_modifier: Some(Modifiers::SHIFT_LEFT),
            ..fn_up
        };
        assert!(!released(&shift_up, Modifiers::FN), "another modifier");
        let held = "ctrl_right"
            .parse::<handy_keys::Hotkey>()
            .unwrap()
            .modifiers;
        let ctrl_up = KeyEvent {
            changed_modifier: Some(held),
            ..fn_up
        };
        assert!(released(&ctrl_up, held));
    }

    #[test]
    fn a_reveal_runs_only_for_the_current_recording() {
        use std::sync::atomic::AtomicUsize;
        let shown = Arc::new(AtomicUsize::new(0));
        let s = Arc::clone(&shown);
        let finished = RevealGate::new(
            || false,
            move || {
                s.fetch_add(1, Ordering::SeqCst);
            },
        );
        reveal_at(Instant::now(), Arc::clone(&finished));
        let s = Arc::clone(&shown);
        let current = RevealGate::new(
            || true,
            move || {
                s.fetch_add(1, Ordering::SeqCst);
            },
        );
        reveal_at(Instant::now(), Arc::clone(&current));
        thread::sleep(Duration::from_millis(50));
        assert!(!finished.is_open(), "a finished tap never reveals");
        assert!(current.is_open());
        assert_eq!(shown.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn hands_free_reveals_at_once_and_only_once() {
        // DESK-22: a tap that turns hands-free does not wait for 300 ms.
        use std::sync::atomic::AtomicUsize;
        let shown = Arc::new(AtomicUsize::new(0));
        let s = Arc::clone(&shown);
        let gate = RevealGate::new(
            || true,
            move || {
                s.fetch_add(1, Ordering::SeqCst);
            },
        );
        reveal_at(
            Instant::now() + Duration::from_millis(300),
            Arc::clone(&gate),
        );
        gate.open(); // the tap was classified at once
        assert_eq!(shown.load(Ordering::SeqCst), 1);
        thread::sleep(Duration::from_millis(350));
        assert_eq!(shown.load(Ordering::SeqCst), 1, "the timer adds nothing");
    }

    #[test]
    fn the_start_sound_waits_for_the_reveal_or_gives_up() {
        let gate = RevealGate::new(|| true, || {});
        let g = Arc::clone(&gate);
        let opener = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            g.open();
        });
        assert!(gate.wait_open(|| true));
        opener.join().unwrap();
        let never = RevealGate::new(|| true, || {});
        assert!(!never.wait_open(|| false), "the recording ended first");
    }
}
