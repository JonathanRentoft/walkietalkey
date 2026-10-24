//! Plug-and-play `fn` on macOS (DESK-20, DESK-26).
//!
//! When the dictation key is `fn` alone, WalkieTalkey's own active event tap
//! at the head of `kCGHIDEventTap` drives it, instead of handy-keys (which
//! keeps every other binding). The tap needs Accessibility only. It
//!
//! - turns fn going down and up into presses and releases of the binding,
//!   through the same path as every other key (`handle_shortcut_event`);
//! - swallows fn-only events (`flagsChanged` keycode 0x3F with no Shift,
//!   Control, Option or Command held) and the stray Globe key event that
//!   macOS sends after a quick tap (`keyDown`/`keyUp` keycode 0xB3), so other
//!   apps and the Globe key's emoji picker do not see them;
//! - passes fn combined with other keys through untouched (fn+arrow is still
//!   Home, fn+Delete still deletes forward), and reports the first other key
//!   pressed while fn is down, which cancels the dictation silently;
//! - re-enables itself when macOS disables it (timeout, user input), and
//!   catches up on a release it missed meanwhile.
//!
//! Swallowing does not stop the Globe key's "Change Input Source" on macOS 26
//! (it fires upstream of every tap, run 2 Phase 0), which is what
//! `walkietalkey::globe` ("Ret det for mig") is for.
//!
//! The decisions are in [`FnTracker`], a pure state machine fed with the
//! event sequences seen on the owner's Mac; the macOS shell only moves events
//! in and out of it. Typed keys are never logged.

/// `flagsChanged` keycode of the fn (Globe) key.
pub const KEYCODE_FUNCTION: i64 = 0x3F;
/// The Globe key's own `keyDown`/`keyUp`, sent after a quick fn tap.
pub const KEYCODE_GLOBE: i64 = 0xB3;
/// `kCGEventFlagMaskSecondaryFn`.
pub const FLAG_FN: u64 = 0x0080_0000;
/// Shift, Control, Option, Command (`kCGEventFlagMask*`).
pub const FLAG_OTHER_MODIFIERS: u64 = 0x0002_0000 | 0x0004_0000 | 0x0008_0000 | 0x0010_0000;

/// What the tap sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TapEvent {
    FlagsChanged { keycode: i64, flags: u64 },
    KeyDown { keycode: i64, flags: u64 },
    KeyUp { keycode: i64, flags: u64 },
}

/// What the dictation key did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// fn went down alone.
    Pressed,
    /// The fn that went down alone came up.
    Released,
    /// Another key went down while fn was held: a shortcut, not dictation.
    OtherKey,
}

/// The tap's answer for one event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    /// Drop the event so no app (and not the Globe key's picker) sees it.
    pub swallow: bool,
    pub signal: Option<Signal>,
}

impl Decision {
    const PASS: Self = Self {
        swallow: false,
        signal: None,
    };

    fn swallow(signal: Option<Signal>) -> Self {
        Self {
            swallow: true,
            signal,
        }
    }

    fn pass(signal: Option<Signal>) -> Self {
        Self {
            swallow: false,
            signal,
        }
    }
}

/// fn's state as the tap has seen it.
#[derive(Debug, Default)]
pub struct FnTracker {
    /// fn went down alone and has not come up yet.
    down: bool,
    /// The other key of this press has been reported.
    other_key: bool,
}

impl FnTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_down(&self) -> bool {
        self.down
    }

    pub fn on_event(&mut self, event: TapEvent) -> Decision {
        match event {
            TapEvent::FlagsChanged { keycode, flags } if keycode == KEYCODE_FUNCTION => {
                let fn_held = flags & FLAG_FN != 0;
                let alone = flags & FLAG_OTHER_MODIFIERS == 0;
                match (fn_held, self.down) {
                    // fn alone: the dictation key.
                    (true, false) if alone => {
                        self.down = true;
                        self.other_key = false;
                        Decision::swallow(Some(Signal::Pressed))
                    }
                    // Shift (or another modifier) was held first: Shift+fn
                    // belongs to someone else.
                    (true, false) => Decision::PASS,
                    // A repeated down while held.
                    (true, true) => Decision::swallow(None),
                    // Its down was swallowed, so its up is too, even with
                    // Shift held by now ("Kun når jeg holder Shift med").
                    (false, true) => {
                        self.down = false;
                        Decision::swallow(Some(Signal::Released))
                    }
                    (false, false) => Decision::PASS,
                }
            }
            // Another modifier changing; a modifier is not a shortcut key
            // (Shift during a dictation chooses cleanup, DESK-80). Its flags
            // are the real state, so a missed fn release shows here.
            TapEvent::FlagsChanged { flags, .. } => {
                if self.down && flags & FLAG_FN == 0 {
                    self.down = false;
                    Decision::pass(Some(Signal::Released))
                } else {
                    Decision::PASS
                }
            }
            TapEvent::KeyDown { keycode, flags } | TapEvent::KeyUp { keycode, flags }
                if keycode == KEYCODE_GLOBE =>
            {
                if flags & FLAG_OTHER_MODIFIERS == 0 {
                    Decision::swallow(None)
                } else {
                    Decision::PASS
                }
            }
            TapEvent::KeyDown { .. } => {
                if self.down && !self.other_key {
                    self.other_key = true;
                    Decision::pass(Some(Signal::OtherKey))
                } else {
                    Decision::PASS
                }
            }
            TapEvent::KeyUp { .. } => Decision::PASS,
        }
    }

    /// After macOS disabled the tap for a while: the modifier flags as they
    /// are now, so a release that happened meanwhile is not lost.
    pub fn sync(&mut self, flags: u64) -> Option<Signal> {
        if self.down && flags & FLAG_FN == 0 {
            self.down = false;
            Some(Signal::Released)
        } else {
            None
        }
    }
}

/// Whether `hotkey` is `fn` alone, the key this tap drives.
pub fn is_fn_alone(hotkey: &str) -> bool {
    hotkey
        .parse::<handy_keys::Hotkey>()
        .is_ok_and(|h| h.key.is_none() && h.modifiers == handy_keys::Modifiers::FN)
}

/// Whether this tap (and not handy-keys) handles `hotkey`.
pub fn claims(hotkey: &str) -> bool {
    cfg!(target_os = "macos") && is_fn_alone(hotkey)
}

#[cfg(target_os = "macos")]
pub(crate) mod ffi {
    //! The few CoreGraphics and CoreFoundation calls an event tap needs.
    use std::ffi::c_void;

    pub const HID_EVENT_TAP: u32 = 0;
    pub const SESSION_EVENT_TAP: u32 = 1;
    pub const HEAD_INSERT: u32 = 0;
    pub const TAIL_APPEND: u32 = 1;
    pub const OPTION_DEFAULT: u32 = 0;
    pub const KEY_DOWN: u32 = 10;
    pub const KEY_UP: u32 = 11;
    pub const FLAGS_CHANGED: u32 = 12;
    pub const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    pub const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    pub const FIELD_KEYCODE: u32 = 9;
    pub const HID_SYSTEM_STATE: i32 = 1;

    pub type Callback = extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: Callback,
            user_info: *mut c_void,
        ) -> *mut c_void;
        pub fn CGEventTapEnable(tap: *mut c_void, enable: bool);
        pub fn CGEventGetFlags(event: *mut c_void) -> u64;
        pub fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
        pub fn CGEventSourceFlagsState(state: i32) -> u64;
        pub fn CGPreflightListenEventAccess() -> bool;
        pub fn CGPreflightPostEventAccess() -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFMachPortCreateRunLoopSource(
            allocator: *const c_void,
            port: *mut c_void,
            order: isize,
        ) -> *mut c_void;
        pub fn CFRunLoopGetCurrent() -> *mut c_void;
        pub fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        pub fn CFRunLoopRun();
        pub static kCFRunLoopCommonModes: *const c_void;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::BTreeMap;
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
    use std::sync::mpsc::{self, Sender};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use log::{debug, info, warn};
    use once_cell::sync::{Lazy, OnceCell};

    use super::ffi::*;
    use super::{FnTracker, Signal, TapEvent};

    struct Inner {
        /// Bindings driven by fn: id -> hotkey string ("fn").
        bindings: BTreeMap<String, String>,
        tracker: FnTracker,
    }

    static INNER: Lazy<Mutex<Inner>> = Lazy::new(|| {
        Mutex::new(Inner {
            bindings: BTreeMap::new(),
            tracker: FnTracker::new(),
        })
    });
    static PORT: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
    static STARTED: AtomicBool = AtomicBool::new(false);
    static SIGNALS: OnceCell<Mutex<Sender<Signal>>> = OnceCell::new();

    fn lock() -> std::sync::MutexGuard<'static, Inner> {
        INNER.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn register(id: &str, hotkey: &str) -> Result<(), String> {
        lock().bindings.insert(id.to_string(), hotkey.to_string());
        start();
        debug!("fn tap drives '{id}'");
        Ok(())
    }

    pub fn unregister(id: &str) -> bool {
        let mut inner = lock();
        let removed = inner.bindings.remove(id).is_some();
        if inner.bindings.is_empty() {
            // Nothing listens: forget a press in progress, pass everything.
            inner.tracker = FnTracker::new();
        }
        removed
    }

    pub fn is_registered(id: &str) -> bool {
        lock().bindings.contains_key(id)
    }

    fn send(signal: Signal) {
        if let Some(tx) = SIGNALS.get() {
            let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(signal);
        }
    }

    extern "C" fn callback(
        _proxy: *mut c_void,
        kind: u32,
        event: *mut c_void,
        _user_info: *mut c_void,
    ) -> *mut c_void {
        if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER_INPUT {
            let port = PORT.load(Ordering::Acquire);
            if !port.is_null() {
                // SAFETY: the port lives for the life of the process.
                unsafe { CGEventTapEnable(port, true) };
            }
            // SAFETY: a plain query of the current modifier state.
            let flags = unsafe { CGEventSourceFlagsState(HID_SYSTEM_STATE) };
            let missed = lock().tracker.sync(flags);
            info!("fn tap was disabled by macOS (type {kind:#x}); re-enabled");
            if let Some(signal) = missed {
                send(signal);
            }
            return event;
        }
        // SAFETY: `event` is the live event macOS hands the callback.
        let (flags, keycode) = unsafe {
            (
                CGEventGetFlags(event),
                CGEventGetIntegerValueField(event, FIELD_KEYCODE),
            )
        };
        let tap_event = match kind {
            FLAGS_CHANGED => TapEvent::FlagsChanged { keycode, flags },
            KEY_DOWN => TapEvent::KeyDown { keycode, flags },
            KEY_UP => TapEvent::KeyUp { keycode, flags },
            _ => return event,
        };
        let decision = {
            let mut inner = lock();
            if inner.bindings.is_empty() {
                return event;
            }
            inner.tracker.on_event(tap_event)
        };
        if let Some(signal) = decision.signal {
            send(signal);
        }
        if decision.swallow {
            ptr::null_mut()
        } else {
            event
        }
    }

    /// The key's presses and releases go where every other key's go; another
    /// key with fn held cancels the dictation it started (DESK-26).
    fn dispatch(app: &tauri::AppHandle, signal: Signal) {
        let bindings: Vec<(String, String)> = lock()
            .bindings
            .iter()
            .map(|(id, hotkey)| (id.clone(), hotkey.clone()))
            .collect();
        match signal {
            Signal::Pressed | Signal::Released => {
                let pressed = signal == Signal::Pressed;
                for (id, hotkey) in bindings {
                    crate::shortcut::handler::handle_shortcut_event(app, &id, &hotkey, pressed);
                }
            }
            Signal::OtherKey => {
                use tauri::Manager;
                let recording = app
                    .try_state::<Arc<crate::managers::audio::AudioRecordingManager>>()
                    .is_some_and(|rm| rm.is_recording());
                if recording {
                    info!("Another key went down with fn; cancelling the dictation silently");
                    crate::utils::cancel_current_operation(app);
                }
            }
        }
    }

    fn start() {
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let (tx, rx) = mpsc::channel::<Signal>();
        let _ = SIGNALS.set(Mutex::new(tx));
        thread::spawn(move || {
            while let Ok(signal) = rx.recv() {
                match crate::walkietalkey::app() {
                    Some(app) => dispatch(app, signal),
                    None => warn!("fn tap: no app handle yet"),
                }
            }
        });
        thread::spawn(run_tap);
    }

    fn run_tap() {
        let mask = (1u64 << KEY_DOWN) | (1u64 << KEY_UP) | (1u64 << FLAGS_CHANGED);
        let mut attempts = 0u32;
        let port = loop {
            // SAFETY: the callback is a plain function and needs no context.
            let port = unsafe {
                CGEventTapCreate(
                    HID_EVENT_TAP,
                    HEAD_INSERT,
                    OPTION_DEFAULT,
                    mask,
                    callback,
                    ptr::null_mut(),
                )
            };
            if !port.is_null() {
                break port;
            }
            if attempts == 0 {
                // Only without Accessibility, which the key listener waits for.
                warn!("fn tap could not be created; trying again every second");
            }
            attempts += 1;
            thread::sleep(Duration::from_secs(1));
        };
        PORT.store(port, Ordering::Release);
        info!("fn tap created (kCGHIDEventTap, head, active) after {attempts} failed attempt(s)");
        // SAFETY: standard run-loop wiring for a mach-port event tap, on this thread.
        unsafe {
            let source = CFMachPortCreateRunLoopSource(ptr::null(), port, 0);
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(port, true);
            CFRunLoopRun();
        }
    }
}

/// Lets the tap drive `id` (whose hotkey is `fn`).
#[cfg(target_os = "macos")]
pub fn register(id: &str, hotkey: &str) -> Result<(), String> {
    imp::register(id, hotkey)
}

/// Stops driving `id`. Returns whether the tap was driving it.
#[cfg(target_os = "macos")]
pub fn unregister(id: &str) -> bool {
    imp::unregister(id)
}

#[cfg(target_os = "macos")]
pub fn is_registered(id: &str) -> bool {
    imp::is_registered(id)
}

#[cfg(not(target_os = "macos"))]
pub fn register(_id: &str, _hotkey: &str) -> Result<(), String> {
    Err("the fn tap exists on macOS only".into())
}

#[cfg(not(target_os = "macos"))]
pub fn unregister(_id: &str) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn is_registered(_id: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The flags seen on the owner's Mac (run 2 Phase 0): fn down carries
    /// 0x00800100, fn up 0x00000100 (0x100 is a device bit).
    const DEVICE: u64 = 0x100;
    const SHIFT: u64 = 0x0002_0000;
    const KEYCODE_SHIFT: i64 = 0x38;
    const KEYCODE_LEFT_ARROW: i64 = 0x7B;

    fn fn_down() -> TapEvent {
        TapEvent::FlagsChanged {
            keycode: KEYCODE_FUNCTION,
            flags: FLAG_FN | DEVICE,
        }
    }

    fn fn_up() -> TapEvent {
        TapEvent::FlagsChanged {
            keycode: KEYCODE_FUNCTION,
            flags: DEVICE,
        }
    }

    fn run(events: &[TapEvent]) -> Vec<Decision> {
        let mut tracker = FnTracker::new();
        events.iter().map(|e| tracker.on_event(*e)).collect()
    }

    fn swallowed(signal: Option<Signal>) -> Decision {
        Decision {
            swallow: true,
            signal,
        }
    }

    fn passed(signal: Option<Signal>) -> Decision {
        Decision {
            swallow: false,
            signal,
        }
    }

    #[test]
    fn a_quick_tap_is_a_press_and_a_release_and_the_globe_event_is_swallowed() {
        // DESK-20: what macOS sends for a quick tap, Globe event included.
        let globe_down = TapEvent::KeyDown {
            keycode: KEYCODE_GLOBE,
            flags: DEVICE,
        };
        let globe_up = TapEvent::KeyUp {
            keycode: KEYCODE_GLOBE,
            flags: DEVICE,
        };
        assert_eq!(
            run(&[fn_down(), fn_up(), globe_down, globe_up]),
            vec![
                swallowed(Some(Signal::Pressed)),
                swallowed(Some(Signal::Released)),
                swallowed(None),
                swallowed(None),
            ]
        );
    }

    #[test]
    fn a_long_hold_swallows_fn_and_reports_its_release() {
        let mut tracker = FnTracker::new();
        assert_eq!(
            tracker.on_event(fn_down()),
            swallowed(Some(Signal::Pressed))
        );
        assert!(tracker.is_down());
        // Typing elsewhere is not happening; a repeated down changes nothing.
        assert_eq!(tracker.on_event(fn_down()), swallowed(None));
        assert_eq!(tracker.on_event(fn_up()), swallowed(Some(Signal::Released)));
        assert!(!tracker.is_down());
    }

    #[test]
    fn fn_with_an_arrow_passes_through_and_cancels_once() {
        // DESK-26: fn+arrow is Home/End for the app, and no dictation.
        let arrow_flags = FLAG_FN | DEVICE | 0x0020_0000; // arrows carry NumericPad
        let arrow_down = TapEvent::KeyDown {
            keycode: KEYCODE_LEFT_ARROW,
            flags: arrow_flags,
        };
        let arrow_up = TapEvent::KeyUp {
            keycode: KEYCODE_LEFT_ARROW,
            flags: arrow_flags,
        };
        assert_eq!(
            run(&[fn_down(), arrow_down, arrow_up, arrow_down, fn_up()]),
            vec![
                swallowed(Some(Signal::Pressed)),
                passed(Some(Signal::OtherKey)),
                passed(None),
                passed(None),
                swallowed(Some(Signal::Released)),
            ]
        );
    }

    #[test]
    fn keys_typed_without_fn_never_cancel() {
        // A hands-free dictation keeps recording while the user types.
        let arrow = TapEvent::KeyDown {
            keycode: KEYCODE_LEFT_ARROW,
            // Arrow keys carry the fn flag even without fn held.
            flags: FLAG_FN | 0x0020_0000,
        };
        let letter = TapEvent::KeyDown {
            keycode: 0x00,
            flags: DEVICE,
        };
        assert_eq!(
            run(&[fn_down(), fn_up(), arrow, letter]),
            vec![
                swallowed(Some(Signal::Pressed)),
                swallowed(Some(Signal::Released)),
                passed(None),
                passed(None),
            ]
        );
    }

    #[test]
    fn fn_with_shift_held_first_belongs_to_someone_else() {
        let shift_down = TapEvent::FlagsChanged {
            keycode: KEYCODE_SHIFT,
            flags: SHIFT | DEVICE,
        };
        let fn_down_with_shift = TapEvent::FlagsChanged {
            keycode: KEYCODE_FUNCTION,
            flags: SHIFT | FLAG_FN | DEVICE,
        };
        let fn_up_with_shift = TapEvent::FlagsChanged {
            keycode: KEYCODE_FUNCTION,
            flags: SHIFT | DEVICE,
        };
        let shift_up = TapEvent::FlagsChanged {
            keycode: KEYCODE_SHIFT,
            flags: DEVICE,
        };
        assert_eq!(
            run(&[shift_down, fn_down_with_shift, fn_up_with_shift, shift_up]),
            vec![passed(None); 4]
        );
    }

    #[test]
    fn shift_during_a_dictation_does_not_cancel_it() {
        // DESK-80 "Kun når jeg holder Shift med": Shift joins a held fn.
        let shift_down = TapEvent::FlagsChanged {
            keycode: KEYCODE_SHIFT,
            flags: SHIFT | FLAG_FN | DEVICE,
        };
        let fn_up_with_shift = TapEvent::FlagsChanged {
            keycode: KEYCODE_FUNCTION,
            flags: SHIFT | DEVICE,
        };
        let shift_up = TapEvent::FlagsChanged {
            keycode: KEYCODE_SHIFT,
            flags: DEVICE,
        };
        assert_eq!(
            run(&[fn_down(), shift_down, fn_up_with_shift, shift_up]),
            vec![
                swallowed(Some(Signal::Pressed)),
                passed(None),
                swallowed(Some(Signal::Released)),
                passed(None),
            ]
        );
    }

    #[test]
    fn a_double_tap_is_two_presses_and_two_releases() {
        // Hold or tap: the first tap starts hands-free, the second stops it.
        assert_eq!(
            run(&[fn_down(), fn_up(), fn_down(), fn_up()]),
            vec![
                swallowed(Some(Signal::Pressed)),
                swallowed(Some(Signal::Released)),
                swallowed(Some(Signal::Pressed)),
                swallowed(Some(Signal::Released)),
            ]
        );
    }

    #[test]
    fn a_globe_event_with_a_modifier_passes() {
        let globe = TapEvent::KeyDown {
            keycode: KEYCODE_GLOBE,
            flags: SHIFT,
        };
        assert_eq!(run(&[globe]), vec![passed(None)]);
    }

    #[test]
    fn a_release_missed_while_the_tap_was_disabled_is_caught_up() {
        let mut tracker = FnTracker::new();
        assert_eq!(tracker.sync(DEVICE), None, "nothing was down");
        tracker.on_event(fn_down());
        assert_eq!(tracker.sync(FLAG_FN | DEVICE), None, "still held");
        assert_eq!(tracker.sync(DEVICE), Some(Signal::Released));
        assert!(!tracker.is_down());
        // A modifier event whose flags show fn gone does the same.
        tracker.on_event(fn_down());
        let shift = TapEvent::FlagsChanged {
            keycode: KEYCODE_SHIFT,
            flags: SHIFT,
        };
        assert_eq!(tracker.on_event(shift), passed(Some(Signal::Released)));
    }

    #[test]
    fn only_fn_alone_is_the_taps_key() {
        assert!(is_fn_alone("fn"));
        assert!(!is_fn_alone("fn+space"));
        assert!(!is_fn_alone("ctrl_right"));
        assert!(!is_fn_alone("option"));
        assert!(!is_fn_alone("not a key"));
        assert_eq!(claims("fn"), cfg!(target_os = "macos"));
        assert!(!claims("ctrl_right"));
    }
}
