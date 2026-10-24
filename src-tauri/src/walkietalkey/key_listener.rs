//! The key listener's lifecycle (DESK-13, DESK-20).
//!
//! Run 1's dead `fn` key: the listener was started before Accessibility was
//! granted, its tap could not be created, yet the start reported success and
//! every later start was a no-op, so the key stayed dead until a restart. The
//! rules here:
//!
//! - a start only counts once the backend reports that it really runs; a
//!   failed start leaves nothing marked, so the next attempt tries again;
//! - on macOS the backend is only tried while `AXIsProcessTrusted` holds
//!   (Accessibility alone covers active event taps; Input Monitoring is never
//!   asked for), and a watcher polls it about once a second while it does
//!   not, so the listener starts the moment the user grants it, without a
//!   restart, and the UI hears `wt-key-listener` `{ "running": true }`.
//!
//! - Accessibility granted once is remembered. Until the app is signed with
//!   a Developer ID, every update changes its signature and macOS silently
//!   drops the grant (System Settings still shows it on). When the app
//!   starts without the grant it once had, the UI hears
//!   `wt-accessibility-lost` and can offer `wt_accessibility_repair`: it
//!   resets the app's own Accessibility entry (`tccutil reset Accessibility
//!   <bundle id>`, no admin needed) and asks macOS to show its own dialog, so
//!   a fresh entry appears; the watcher starts the key once it is switched on.
//!
//! The decisions sit behind small seams (a permission probe, a backend
//! factory, the repair's system calls), so tests drive them without a Tauri
//! app, a real event tap or `tccutil`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use log::{info, warn};
use once_cell::sync::Lazy;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

/// How often the watcher checks for the grant while it is missing.
pub const WATCH_INTERVAL: Duration = Duration::from_secs(1);

/// The error `initialize_shortcuts` returns while Accessibility is missing.
pub const NOT_TRUSTED: &str = "accessibility-not-granted";

/// Whether the OS lets this app see and swallow key events.
pub trait PermissionProbe: Send + Sync {
    fn trusted(&self) -> bool;
}

/// Starts the real key listener. `Ok` only once it really runs.
pub trait ListenerBackend: Send + Sync {
    fn start(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Started {
    /// This call started it.
    Now,
    /// It was already running.
    Already,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartError {
    /// Accessibility is not granted yet (macOS).
    NotTrusted,
    /// The backend could not start.
    Failed(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::NotTrusted => f.write_str(NOT_TRUSTED),
            StartError::Failed(e) => write!(f, "key listener did not start: {e}"),
        }
    }
}

/// Running or not, and whether a watcher is waiting for the grant.
#[derive(Default)]
pub struct Lifecycle {
    running: Mutex<bool>,
    watching: AtomicBool,
}

impl Lifecycle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_running(&self) -> bool {
        *self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Starts the listener unless it runs already. The lock is held across
    /// the start, so the watcher and the `initialize_shortcuts` command never
    /// start two listeners. A failure is never remembered as running.
    pub fn ensure(
        &self,
        probe: &dyn PermissionProbe,
        backend: &dyn ListenerBackend,
    ) -> Result<Started, StartError> {
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        if *running {
            return Ok(Started::Already);
        }
        if !probe.trusted() {
            return Err(StartError::NotTrusted);
        }
        backend.start().map_err(StartError::Failed)?;
        *running = true;
        Ok(Started::Now)
    }

    /// Tries every `interval` until the listener runs, then calls
    /// `on_started` (only when this watcher started it). One watcher at a
    /// time: a second call while one waits returns at once.
    pub fn watch<F>(
        self: &Arc<Self>,
        probe: Arc<dyn PermissionProbe>,
        backend: Arc<dyn ListenerBackend>,
        interval: Duration,
        on_started: F,
    ) where
        F: FnOnce() + Send + 'static,
    {
        if self.is_running() || self.watching.swap(true, Ordering::SeqCst) {
            return;
        }
        let lifecycle = Arc::clone(self);
        thread::spawn(move || {
            let mut reported = false;
            let started = loop {
                match lifecycle.ensure(probe.as_ref(), backend.as_ref()) {
                    Ok(Started::Now) => break true,
                    Ok(Started::Already) => break false,
                    Err(StartError::NotTrusted) => {}
                    Err(e) => {
                        if !reported {
                            warn!("{e}; trying again");
                            reported = true;
                        }
                    }
                }
                thread::sleep(interval);
            };
            lifecycle.watching.store(false, Ordering::SeqCst);
            if started {
                on_started();
            }
        });
    }
}

/// At start: the app had Accessibility before and has lost it (DESK-13).
pub fn accessibility_lost(granted_once: bool, trusted: bool) -> bool {
    granted_once && !trusted
}

/// The system calls behind "repair Accessibility".
pub trait AccessibilityRepair {
    /// Removes the app's own (stale) Accessibility entry.
    fn reset_entry(&self) -> Result<(), String>;
    /// Asks macOS to show its own Accessibility dialog (a fresh entry).
    fn prompt(&self);
    fn trusted(&self) -> bool;
}

/// Resets the stale entry and prompts, unless the grant is there already.
/// Returns whether the app is trusted now (normally not until the user
/// switches it on; the watcher then starts the key by itself).
pub fn repair_with(system: &dyn AccessibilityRepair) -> bool {
    if system.trusted() {
        return true;
    }
    if let Err(e) = system.reset_entry() {
        warn!("Could not reset the Accessibility entry: {e}");
    }
    system.prompt();
    system.trusted()
}

/// `wt-key-listener`: whether the key listener runs.
#[derive(Debug, Clone, Copy, Serialize, Type)]
pub struct KeyListenerStatus {
    pub running: bool,
}

static LIFECYCLE: Lazy<Arc<Lifecycle>> = Lazy::new(|| Arc::new(Lifecycle::new()));

/// The grant was lost (see [`accessibility_lost`]) and not given back yet.
static ACCESSIBILITY_LOST: AtomicBool = AtomicBool::new(false);

/// Accessibility on macOS; nothing to grant elsewhere.
pub fn permission_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        handy_keys::check_accessibility()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

struct SystemProbe;

impl PermissionProbe for SystemProbe {
    fn trusted(&self) -> bool {
        permission_granted()
    }
}

/// Handy's shortcut backends (handy-keys, and our own fn tap for `fn`).
struct ShortcutBackend {
    app: AppHandle,
}

impl ListenerBackend for ShortcutBackend {
    fn start(&self) -> Result<(), String> {
        crate::shortcut::init_shortcuts(&self.app)?;
        self.app.manage(crate::commands::ShortcutsInitialized);
        crate::secure_input::reconcile_fallback(&self.app);
        Ok(())
    }
}

fn emit_status(app: &AppHandle, running: bool) {
    let _ = app.emit("wt-key-listener", KeyListenerStatus { running });
}

fn on_started(app: &AppHandle) {
    info!("Key listener started");
    ACCESSIBILITY_LOST.store(false, Ordering::SeqCst);
    remember_grant(app);
    emit_status(app, true);
}

/// The listener only starts with Accessibility on macOS: remember that it
/// was granted, once.
fn remember_grant(app: &AppHandle) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let (wt, _) = super::store::stored_user_settings(app);
    if wt.accessibility_granted_once {
        return;
    }
    if let Err(e) = super::store::update_internal(app, |wt| wt.accessibility_granted_once = true) {
        warn!("Could not remember the Accessibility grant: {e}");
    }
}

fn watch(app: &AppHandle) {
    let handle = app.clone();
    LIFECYCLE.watch(
        Arc::new(SystemProbe),
        Arc::new(ShortcutBackend { app: app.clone() }),
        WATCH_INTERVAL,
        move || on_started(&handle),
    );
}

/// Starts the listener now, or as soon as Accessibility is granted. Called
/// at start (so the key works without the UI's help) and by the
/// `initialize_shortcuts` command, which reports the outcome.
pub fn ensure(app: &AppHandle) -> Result<(), String> {
    let backend = ShortcutBackend { app: app.clone() };
    match LIFECYCLE.ensure(&SystemProbe, &backend) {
        Ok(Started::Now) => {
            on_started(app);
            Ok(())
        }
        Ok(Started::Already) => Ok(()),
        Err(e) => {
            if e == StartError::NotTrusted {
                info!("Accessibility is not granted yet; the key listener starts once it is");
            } else {
                warn!("{e}");
            }
            emit_status(app, false);
            watch(app);
            Err(e.to_string())
        }
    }
}

/// At start of the app.
pub fn start(app: &AppHandle) {
    let (wt, _) = super::store::stored_user_settings(app);
    if accessibility_lost(wt.accessibility_granted_once, permission_granted()) {
        warn!("Accessibility was granted before but is not now (the app's signature changed?)");
        ACCESSIBILITY_LOST.store(true, Ordering::SeqCst);
        let _ = app.emit("wt-accessibility-lost", true);
        // The app usually runs hidden in the menu bar, and a dead key shows no
        // pill: open the main window so the notice and its repair button are seen.
        crate::show_main_window(app);
    }
    let _ = ensure(app);
}

/// Whether the grant was lost and not given back, for a window that opened
/// after `wt-accessibility-lost`.
pub fn is_accessibility_lost() -> bool {
    ACCESSIBILITY_LOST.load(Ordering::SeqCst)
}

#[cfg(target_os = "macos")]
struct SystemRepair {
    bundle_id: String,
}

#[cfg(target_os = "macos")]
impl AccessibilityRepair for SystemRepair {
    fn reset_entry(&self) -> Result<(), String> {
        // Only the app's own entry; works without admin rights.
        let out = std::process::Command::new("/usr/bin/tccutil")
            .args(["reset", "Accessibility", &self.bundle_id])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    fn prompt(&self) {
        tauri::async_runtime::block_on(
            tauri_plugin_macos_permissions::request_accessibility_permission(),
        );
    }

    fn trusted(&self) -> bool {
        permission_granted()
    }
}

/// `wt_accessibility_repair`: true when the app is trusted now.
pub fn repair(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    let trusted = repair_with(&SystemRepair {
        bundle_id: app.config().identifier.clone(),
    });
    #[cfg(not(target_os = "macos"))]
    let trusted = true;
    // Starts the key now, or makes sure the watcher waits for the switch.
    let _ = ensure(app);
    trusted
}

/// Whether the listener runs, for a UI that missed the event.
pub fn status() -> KeyListenerStatus {
    KeyListenerStatus {
        running: LIFECYCLE.is_running(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    #[derive(Default)]
    struct FakeProbe(AtomicBool);

    impl PermissionProbe for FakeProbe {
        fn trusted(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    /// Fails like handy-keys does without Accessibility, unless `works`.
    #[derive(Default)]
    struct FakeBackend {
        works: AtomicBool,
        starts: AtomicUsize,
    }

    impl ListenerBackend for FakeBackend {
        fn start(&self) -> Result<(), String> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            if self.works.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("Accessibility permission not granted".into())
            }
        }
    }

    fn wait_for(condition: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        condition()
    }

    #[test]
    fn fails_while_untrusted_without_touching_the_backend() {
        // DESK-13: no tap is attempted before Accessibility is granted.
        let lifecycle = Lifecycle::new();
        let probe = FakeProbe::default();
        let backend = FakeBackend::default();
        assert_eq!(
            lifecycle.ensure(&probe, &backend),
            Err(StartError::NotTrusted)
        );
        assert!(!lifecycle.is_running());
        assert_eq!(backend.starts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_failed_start_is_never_marked_running() {
        // Run 1's bug (DESK-13, DESK-20): the start failed but counted as done.
        let lifecycle = Lifecycle::new();
        let probe = FakeProbe(AtomicBool::new(true));
        let backend = FakeBackend::default();
        assert!(matches!(
            lifecycle.ensure(&probe, &backend),
            Err(StartError::Failed(_))
        ));
        assert!(!lifecycle.is_running());
    }

    #[test]
    fn a_second_call_after_a_failure_retries() {
        let lifecycle = Lifecycle::new();
        let probe = FakeProbe(AtomicBool::new(true));
        let backend = FakeBackend::default();
        assert!(lifecycle.ensure(&probe, &backend).is_err());
        backend.works.store(true, Ordering::SeqCst);
        assert_eq!(lifecycle.ensure(&probe, &backend), Ok(Started::Now));
        assert_eq!(backend.starts.load(Ordering::SeqCst), 2, "tried again");
        assert!(lifecycle.is_running());
        assert_eq!(lifecycle.ensure(&probe, &backend), Ok(Started::Already));
        assert_eq!(backend.starts.load(Ordering::SeqCst), 2, "started once");
    }

    #[test]
    fn the_watcher_starts_the_listener_once_accessibility_is_granted() {
        // DESK-13: the grant starts the key by itself, no restart.
        let lifecycle = Arc::new(Lifecycle::new());
        let probe = Arc::new(FakeProbe::default());
        let backend = Arc::new(FakeBackend::default());
        backend.works.store(true, Ordering::SeqCst);
        let announced = Arc::new(AtomicUsize::new(0));
        let a = Arc::clone(&announced);
        lifecycle.watch(
            probe.clone(),
            backend.clone(),
            Duration::from_millis(5),
            move || {
                a.fetch_add(1, Ordering::SeqCst);
            },
        );
        thread::sleep(Duration::from_millis(40));
        assert!(!lifecycle.is_running(), "still waiting for the grant");
        assert_eq!(backend.starts.load(Ordering::SeqCst), 0);

        probe.0.store(true, Ordering::SeqCst);
        assert!(wait_for(|| announced.load(Ordering::SeqCst) == 1));
        assert!(lifecycle.is_running());
        assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
        assert!(wait_for(|| !lifecycle.watching.load(Ordering::SeqCst)));
    }

    #[test]
    fn the_watcher_keeps_retrying_a_backend_that_fails_after_the_grant() {
        let lifecycle = Arc::new(Lifecycle::new());
        let probe = Arc::new(FakeProbe(AtomicBool::new(true)));
        let backend = Arc::new(FakeBackend::default());
        let announced = Arc::new(AtomicBool::new(false));
        let a = Arc::clone(&announced);
        lifecycle.watch(
            probe.clone(),
            backend.clone(),
            Duration::from_millis(5),
            move || a.store(true, Ordering::SeqCst),
        );
        assert!(wait_for(|| backend.starts.load(Ordering::SeqCst) >= 3));
        assert!(!lifecycle.is_running());
        backend.works.store(true, Ordering::SeqCst);
        assert!(wait_for(|| announced.load(Ordering::SeqCst)));
        assert!(lifecycle.is_running());
    }

    #[test]
    fn a_lost_grant_is_told_apart_from_a_first_run() {
        assert!(accessibility_lost(true, false), "granted before, gone now");
        assert!(
            !accessibility_lost(false, false),
            "first run: onboarding asks"
        );
        assert!(!accessibility_lost(true, true));
        assert!(!accessibility_lost(false, true));
    }

    /// Records what the repair asked of the system.
    struct FakeSystem {
        trusted_before: bool,
        trusted_after_prompt: bool,
        reset_fails: bool,
        calls: std::sync::Mutex<Vec<&'static str>>,
        prompted: AtomicBool,
    }

    impl FakeSystem {
        fn new(trusted_before: bool, trusted_after_prompt: bool) -> Self {
            Self {
                trusted_before,
                trusted_after_prompt,
                reset_fails: false,
                calls: std::sync::Mutex::new(Vec::new()),
                prompted: AtomicBool::new(false),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl AccessibilityRepair for FakeSystem {
        fn reset_entry(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("reset");
            if self.reset_fails {
                Err("tccutil failed".into())
            } else {
                Ok(())
            }
        }
        fn prompt(&self) {
            self.calls.lock().unwrap().push("prompt");
            self.prompted.store(true, Ordering::SeqCst);
        }
        fn trusted(&self) -> bool {
            if self.prompted.load(Ordering::SeqCst) {
                self.trusted_after_prompt
            } else {
                self.trusted_before
            }
        }
    }

    #[test]
    fn the_repair_resets_the_stale_entry_then_prompts() {
        let system = FakeSystem::new(false, false);
        assert!(
            !repair_with(&system),
            "trusted only once the user switches it on"
        );
        assert_eq!(system.calls(), vec!["reset", "prompt"]);
    }

    #[test]
    fn the_repair_leaves_a_working_grant_alone() {
        let system = FakeSystem::new(true, true);
        assert!(repair_with(&system));
        assert!(system.calls().is_empty(), "nothing reset while it works");
    }

    #[test]
    fn the_repair_still_prompts_when_the_reset_fails() {
        let mut system = FakeSystem::new(false, true);
        system.reset_fails = true;
        assert!(repair_with(&system));
        assert_eq!(system.calls(), vec!["reset", "prompt"]);
    }

    #[test]
    fn one_watcher_at_a_time() {
        let lifecycle = Arc::new(Lifecycle::new());
        let probe = Arc::new(FakeProbe::default());
        let backend = Arc::new(FakeBackend::default());
        backend.works.store(true, Ordering::SeqCst);
        let announced = Arc::new(AtomicUsize::new(0));
        for _ in 0..3 {
            let a = Arc::clone(&announced);
            lifecycle.watch(
                probe.clone(),
                backend.clone(),
                Duration::from_millis(5),
                move || {
                    a.fetch_add(1, Ordering::SeqCst);
                },
            );
        }
        probe.0.store(true, Ordering::SeqCst);
        assert!(wait_for(|| lifecycle.is_running()));
        thread::sleep(Duration::from_millis(30));
        assert_eq!(announced.load(Ordering::SeqCst), 1);
        assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
    }
}
