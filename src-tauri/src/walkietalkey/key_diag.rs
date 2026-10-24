//! Key diagnostics for macOS, on only when `WT_KEY_DIAG` is set (run 2, the dead `fn` key).
//!
//! Logs the keyboard backend, the permission state (`AXIsProcessTrusted`,
//! `CGPreflightListenEventAccess`, `CGPreflightPostEventAccess`) whenever it changes, and every
//! `flagsChanged` event that carries the fn flag, seen from two pass-through taps: one at the HID
//! level and one at the end of the session level (after Handy's own tap). `WT_FN_CONSUME=hid` or
//! `WT_FN_CONSUME=session` makes that tap swallow fn-only events, to test whether doing so stops
//! the Globe key's own action. Ordinary typing is never logged: only fn, the dictation key and
//! keys macOS reports above the character range.

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::atomic::{AtomicPtr, Ordering};
    use std::thread;
    use std::time::Duration;

    use log::{info, warn};
    use tauri::AppHandle;

    // The event-tap calls and constants are shared with the fn tap.
    use crate::walkietalkey::fn_key::ffi::*;
    use crate::walkietalkey::fn_key::{
        FLAG_FN as FLAG_SECONDARY_FN, FLAG_OTHER_MODIFIERS, KEYCODE_FUNCTION, KEYCODE_GLOBE,
    };

    struct Tap {
        name: &'static str,
        consume: bool,
        port: AtomicPtr<c_void>,
    }

    fn permissions() -> (bool, bool, bool) {
        // SAFETY: plain queries without arguments.
        unsafe {
            (
                AXIsProcessTrusted(),
                CGPreflightListenEventAccess(),
                CGPreflightPostEventAccess(),
            )
        }
    }

    extern "C" fn callback(
        _proxy: *mut c_void,
        kind: u32,
        event: *mut c_void,
        user_info: *mut c_void,
    ) -> *mut c_void {
        // SAFETY: user_info is the leaked `Tap` handed to CGEventTapCreate.
        let tap = unsafe { &*(user_info as *const Tap) };
        if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER_INPUT {
            info!(
                "key-diag[{}]: tap disabled by macOS (type {kind:#x}); re-enabling",
                tap.name
            );
            let port = tap.port.load(Ordering::Acquire);
            if !port.is_null() {
                // SAFETY: the port stays alive for the life of the process.
                unsafe { CGEventTapEnable(port, true) };
            }
            return event;
        }
        // SAFETY: `event` is the live event macOS passes to the callback.
        let (flags, keycode) = unsafe {
            (
                CGEventGetFlags(event),
                CGEventGetIntegerValueField(event, FIELD_KEYCODE),
            )
        };
        let has_fn = flags & FLAG_SECONDARY_FN != 0;
        match kind {
            FLAGS_CHANGED if has_fn || keycode == KEYCODE_FUNCTION => {
                let fn_only = keycode == KEYCODE_FUNCTION && flags & FLAG_OTHER_MODIFIERS == 0;
                let swallow = tap.consume && fn_only;
                info!(
                    "key-diag[{}]: flagsChanged keycode={keycode:#x} flags={flags:#010x} fn={} {}",
                    tap.name,
                    if has_fn { "down" } else { "up" },
                    if swallow { "SWALLOWED" } else { "passed" }
                );
                if swallow {
                    return ptr::null_mut();
                }
            }
            KEY_DOWN | KEY_UP if keycode >= 0xA0 || keycode == KEYCODE_FUNCTION => {
                // 0xB3 is the Globe key's own event, sent after a quick fn tap; macOS acts on it.
                let swallow =
                    tap.consume && keycode == KEYCODE_GLOBE && flags & FLAG_OTHER_MODIFIERS == 0;
                info!(
                    "key-diag[{}]: {} keycode={keycode:#x} flags={flags:#010x} {}",
                    tap.name,
                    if kind == KEY_DOWN { "keyDown" } else { "keyUp" },
                    if swallow { "SWALLOWED" } else { "passed" }
                );
                if swallow {
                    return ptr::null_mut();
                }
            }
            KEY_DOWN | KEY_UP if has_fn => {
                info!(
                    "key-diag[{}]: {} of another key while fn is held",
                    tap.name,
                    if kind == KEY_DOWN { "keyDown" } else { "keyUp" }
                );
            }
            _ => {}
        }
        event
    }

    fn run_tap(name: &'static str, location: u32, placement: u32, consume: bool) {
        let mask = (1u64 << KEY_DOWN) | (1u64 << KEY_UP) | (1u64 << FLAGS_CHANGED);
        let tap = Box::leak(Box::new(Tap {
            name,
            consume,
            port: AtomicPtr::new(ptr::null_mut()),
        }));
        let mut attempts = 0u32;
        let port = loop {
            // SAFETY: the callback and the leaked context live for the whole process.
            let port = unsafe {
                CGEventTapCreate(
                    location,
                    placement,
                    OPTION_DEFAULT,
                    mask,
                    callback,
                    tap as *mut Tap as *mut c_void,
                )
            };
            if !port.is_null() {
                break port;
            }
            if attempts == 0 {
                warn!("key-diag[{name}]: CGEventTapCreate failed; retrying every 2 s");
            }
            attempts += 1;
            thread::sleep(Duration::from_secs(2));
        };
        tap.port.store(port, Ordering::Release);
        info!(
            "key-diag[{name}]: tap created after {attempts} failed attempt(s): location={}, placement={}, options=active (kCGEventTapOptionDefault), swallow fn-only={consume}",
            if location == HID_EVENT_TAP { "kCGHIDEventTap" } else { "kCGSessionEventTap" },
            if placement == HEAD_INSERT { "head" } else { "tail" },
        );
        // SAFETY: standard run-loop wiring for a mach-port event tap, on this thread.
        unsafe {
            let source = CFMachPortCreateRunLoopSource(ptr::null(), port, 0);
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(port, true);
            CFRunLoopRun();
        }
    }

    pub fn start(app: &AppHandle) {
        if std::env::var_os("WT_KEY_DIAG").is_none() {
            return;
        }
        let settings = crate::settings::get_settings(app);
        info!(
            "key-diag: keyboard backend = {:?} (handy-keys taps kCGSessionEventTap, head, active), transcribe key = {:?}, activation = {:?}",
            settings.keyboard_implementation,
            settings.bindings.get("transcribe").map(|b| b.current_binding.clone()),
            settings.shortcut_activation
        );
        let consume = std::env::var("WT_FN_CONSUME").unwrap_or_default();
        thread::spawn(|| {
            let mut last = None;
            loop {
                let now = permissions();
                if last != Some(now) {
                    info!(
                        "key-diag: AXIsProcessTrusted={} CGPreflightListenEventAccess={} CGPreflightPostEventAccess={}",
                        now.0, now.1, now.2
                    );
                    last = Some(now);
                }
                thread::sleep(Duration::from_secs(1));
            }
        });
        let hid = consume == "hid";
        let session = consume == "session";
        thread::spawn(move || run_tap("hid", HID_EVENT_TAP, HEAD_INSERT, hid));
        thread::spawn(move || run_tap("session", SESSION_EVENT_TAP, TAIL_APPEND, session));
    }
}

#[cfg(target_os = "macos")]
pub use imp::start;

#[cfg(not(target_os = "macos"))]
pub fn start(_app: &tauri::AppHandle) {}
