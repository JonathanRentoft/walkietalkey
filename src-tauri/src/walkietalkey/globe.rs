//! "Ret det for mig" (DESK-13, DESK-20): the Globe key's own action.
//!
//! On macOS 26 a quick tap of fn fires "Press 🌐 key to" (Change Input
//! Source, Show Emoji & Symbols, Start Dictation) upstream of every event
//! tap, so swallowing fn (`fn_key`) cannot stop it (run 2 Phase 0). While fn
//! is the dictation key, the app offers one button that sets
//! `com.apple.HIToolbox AppleFnUsageType` to 0 ("Do Nothing") the way Phase 0
//! verified (`defaults write`, effective at once, no logout). The previous
//! value is saved in our settings and put back when fn stops being the key.
//!
//! Values: 0 Do Nothing, 1 Change Input Source, 2 Show Emoji & Symbols,
//! 3 Start Dictation. An unset key means macOS's own default, which is an
//! action too. On Windows there is no Globe key: fn is never the key.

use serde::Serialize;
use specta::Type;
use tauri::AppHandle;

/// `AppleFnUsageType` for "Do Nothing".
pub const DO_NOTHING: i64 = 0;

/// What the UI shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub struct GlobeKeyStatus {
    /// fn is the dictation key (macOS only).
    pub fn_is_key: bool,
    /// The current `AppleFnUsageType`, `None` when unset or unreadable.
    pub usage: Option<i64>,
    /// fn is the key and the Globe key still does something of its own.
    pub needs_fix: bool,
}

/// Where `AppleFnUsageType` lives. Tests use a fake; the app uses
/// `/usr/bin/defaults`.
pub trait DefaultsStore {
    fn read(&self) -> Result<Option<i64>, String>;
    fn write(&self, value: i64) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// What we saved before the fix (`WtSettings::globe_key_fixed`, `_previous`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Saved {
    pub fixed: bool,
    /// The value before the fix; `None` when it was unset.
    pub previous: Option<i64>,
}

pub fn status(fn_is_key: bool, usage: Option<i64>) -> GlobeKeyStatus {
    GlobeKeyStatus {
        fn_is_key,
        usage,
        // Unset is macOS's own default, which acts too (Change Input Source
        // or Show Emoji & Symbols), so only an explicit 0 is left alone.
        needs_fix: fn_is_key && usage != Some(DO_NOTHING),
    }
}

/// Sets "Do Nothing", saving the previous value the first time. Returns the
/// status after it and what to keep in the settings.
pub fn fix(
    store: &dyn DefaultsStore,
    fn_is_key: bool,
    saved: Saved,
) -> Result<(GlobeKeyStatus, Saved), String> {
    let usage = store.read()?;
    if !fn_is_key || usage == Some(DO_NOTHING) {
        return Ok((status(fn_is_key, usage), saved));
    }
    // A second fix (the user changed it back in System Settings) keeps the
    // value from before our first one.
    let saved = if saved.fixed {
        saved
    } else {
        Saved {
            fixed: true,
            previous: usage,
        }
    };
    store.write(DO_NOTHING)?;
    let now = store.read()?;
    Ok((status(fn_is_key, now), saved))
}

/// fn is no longer the key: puts back what was there before the fix.
/// Returns what to keep in the settings (nothing once restored).
pub fn restore(store: &dyn DefaultsStore, fn_is_key: bool, saved: Saved) -> Result<Saved, String> {
    if fn_is_key || !saved.fixed {
        return Ok(saved);
    }
    match saved.previous {
        Some(value) => store.write(value)?,
        None => store.delete()?,
    }
    Ok(Saved::default())
}

/// Whether the dictation key is `fn` alone on this computer.
pub fn fn_is_key(app: &AppHandle) -> bool {
    cfg!(target_os = "macos")
        && crate::settings::get_settings(app)
            .bindings
            .iter()
            .filter(|(id, _)| crate::transcription_coordinator::is_transcribe_binding(id))
            .any(|(_, binding)| super::fn_key::is_fn_alone(&binding.current_binding))
}

#[cfg(target_os = "macos")]
mod system {
    use std::process::Command;

    const DEFAULTS: &str = "/usr/bin/defaults";
    const DOMAIN: &str = "com.apple.HIToolbox";
    const KEY: &str = "AppleFnUsageType";

    pub struct SystemDefaults;

    impl super::DefaultsStore for SystemDefaults {
        fn read(&self) -> Result<Option<i64>, String> {
            let out = Command::new(DEFAULTS)
                .args(["read", DOMAIN, KEY])
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                // "does not exist": the key is unset.
                return Ok(None);
            }
            Ok(String::from_utf8_lossy(&out.stdout).trim().parse().ok())
        }

        fn write(&self, value: i64) -> Result<(), String> {
            run(&["write", DOMAIN, KEY, "-int", &value.to_string()])
        }

        fn delete(&self) -> Result<(), String> {
            run(&["delete", DOMAIN, KEY])
        }
    }

    fn run(args: &[&str]) -> Result<(), String> {
        let out = Command::new(DEFAULTS)
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
}

fn saved(app: &AppHandle) -> Saved {
    let (wt, _) = super::store::stored_user_settings(app);
    Saved {
        fixed: wt.globe_key_fixed,
        previous: wt.globe_key_previous,
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn keep(app: &AppHandle, saved: Saved) -> Result<(), String> {
    super::store::update_internal(app, |wt| {
        wt.globe_key_fixed = saved.fixed;
        wt.globe_key_previous = saved.previous;
    })
}

/// `wt_globe_key_status`.
pub fn current(app: &AppHandle) -> GlobeKeyStatus {
    #[cfg(target_os = "macos")]
    {
        use DefaultsStore as _;
        let usage = system::SystemDefaults.read().unwrap_or_else(|e| {
            log::warn!("Could not read the Globe key setting: {e}");
            None
        });
        status(fn_is_key(app), usage)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        status(false, None)
    }
}

/// `wt_globe_key_fix`.
pub fn fix_now(app: &AppHandle) -> Result<GlobeKeyStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let (status, saved) = fix(&system::SystemDefaults, fn_is_key(app), saved(app))?;
        keep(app, saved)?;
        log::info!(
            "Globe key set to Do Nothing (was {:?}) while fn dictates",
            saved.previous
        );
        Ok(status)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(current(app))
    }
}

/// After the key changed (and at start): fn no longer the key puts the
/// user's Globe key setting back.
pub fn reconcile(app: &AppHandle) {
    let before = saved(app);
    if !before.fixed {
        return;
    }
    #[cfg(target_os = "macos")]
    match restore(&system::SystemDefaults, fn_is_key(app), before) {
        Ok(after) if after != before => {
            log::info!("fn is no longer the key; the Globe key setting is restored");
            if let Err(e) = keep(app, after) {
                log::warn!("Could not save the Globe key state: {e}");
            }
        }
        Ok(_) => {}
        Err(e) => log::warn!("Could not restore the Globe key setting: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A `defaults` domain in memory.
    struct FakeDefaults {
        value: RefCell<Option<i64>>,
        writes: RefCell<Vec<Option<i64>>>,
    }

    impl FakeDefaults {
        fn with(value: Option<i64>) -> Self {
            Self {
                value: RefCell::new(value),
                writes: RefCell::new(Vec::new()),
            }
        }
    }

    impl DefaultsStore for FakeDefaults {
        fn read(&self) -> Result<Option<i64>, String> {
            Ok(*self.value.borrow())
        }
        fn write(&self, value: i64) -> Result<(), String> {
            *self.value.borrow_mut() = Some(value);
            self.writes.borrow_mut().push(Some(value));
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            *self.value.borrow_mut() = None;
            self.writes.borrow_mut().push(None);
            Ok(())
        }
    }

    #[test]
    fn the_globe_key_needs_fixing_only_while_fn_is_the_key() {
        // DESK-20: Change Input Source, Emoji, Dictation, or macOS's default.
        for usage in [Some(1), Some(2), Some(3), None] {
            assert!(status(true, usage).needs_fix, "{usage:?}");
            assert!(!status(false, usage).needs_fix, "{usage:?}");
        }
        assert!(!status(true, Some(0)).needs_fix, "Do Nothing");
    }

    #[test]
    fn the_fix_saves_the_previous_value_and_sets_do_nothing() {
        let store = FakeDefaults::with(Some(1));
        let (after, saved) = fix(&store, true, Saved::default()).unwrap();
        assert_eq!(
            after,
            GlobeKeyStatus {
                fn_is_key: true,
                usage: Some(0),
                needs_fix: false
            }
        );
        assert_eq!(
            saved,
            Saved {
                fixed: true,
                previous: Some(1)
            }
        );
    }

    #[test]
    fn a_second_fix_keeps_the_value_from_before_the_first() {
        let store = FakeDefaults::with(Some(2));
        let (_, saved) = fix(&store, true, Saved::default()).unwrap();
        // The user set Emoji again in System Settings, then fixed again.
        *store.value.borrow_mut() = Some(2);
        let (_, again) = fix(&store, true, saved).unwrap();
        assert_eq!(again.previous, Some(2));
        *store.value.borrow_mut() = Some(1);
        let (_, third) = fix(&store, true, again).unwrap();
        assert_eq!(third.previous, Some(2), "the very first value wins");
    }

    #[test]
    fn nothing_is_written_when_fn_is_not_the_key_or_already_fixed() {
        let store = FakeDefaults::with(Some(1));
        let (after, saved) = fix(&store, false, Saved::default()).unwrap();
        assert!(!after.needs_fix);
        assert_eq!(saved, Saved::default());
        let done = FakeDefaults::with(Some(0));
        fix(&done, true, Saved::default()).unwrap();
        assert!(store.writes.borrow().is_empty());
        assert!(done.writes.borrow().is_empty());
    }

    #[test]
    fn the_old_value_comes_back_when_fn_stops_being_the_key() {
        let store = FakeDefaults::with(Some(1));
        let (_, saved) = fix(&store, true, Saved::default()).unwrap();
        // Still the key: nothing changes.
        assert_eq!(restore(&store, true, saved).unwrap(), saved);
        assert_eq!(*store.value.borrow(), Some(0));
        // The key changed to Right Option.
        let cleared = restore(&store, false, saved).unwrap();
        assert_eq!(cleared, Saved::default());
        assert_eq!(*store.value.borrow(), Some(1));
    }

    #[test]
    fn an_unset_value_is_unset_again_on_restore() {
        let store = FakeDefaults::with(None);
        let (after, saved) = fix(&store, true, Saved::default()).unwrap();
        assert_eq!(after.usage, Some(0));
        assert_eq!(
            saved,
            Saved {
                fixed: true,
                previous: None
            }
        );
        restore(&store, false, saved).unwrap();
        assert_eq!(*store.value.borrow(), None);
        assert_eq!(*store.writes.borrow(), vec![Some(0), None]);
    }

    #[test]
    fn nothing_saved_means_nothing_restored() {
        let store = FakeDefaults::with(Some(2));
        assert_eq!(
            restore(&store, false, Saved::default()).unwrap(),
            Saved::default()
        );
        assert!(store.writes.borrow().is_empty());
    }
}
