//! The menu bar and tray additions (DESK-95..97): "Seneste" (the last five
//! dictations; a click copies), "Par en telefon", "Sæt på pause", "Genstart
//! nu" once an update is ready, and the listening pulse.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use log::{info, warn};
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter, Manager};

/// "Sæt på pause" (DESK-96): the key does nothing and phone dictations are
/// answered with `paused`, until "Genoptag" or the next start of the app.
static PAUSED: AtomicBool = AtomicBool::new(false);

/// An update has been downloaded and installs on restart (DESK-111).
static UPDATE_READY: AtomicBool = AtomicBool::new(false);

/// Which of the two listening frames the icon shows (DESK-95 pulse).
static PULSE_PHASE: AtomicBool = AtomicBool::new(false);

type Listening = Box<dyn Fn() -> bool + Send>;

/// Everything that is listening now (a key dictation, phone dictations) and
/// whether the pulse thread runs. One lock, so a listener that joins just as
/// the last one ends still gets a pulse.
#[derive(Default)]
struct Listeners {
    list: Vec<Listening>,
    pulsing: bool,
}

impl Listeners {
    /// Adds a listener; true when the caller must start the pulse thread.
    fn join(&mut self, is_listening: Listening) -> bool {
        self.list.push(is_listening);
        !std::mem::replace(&mut self.pulsing, true)
    }

    /// Drops the listeners that ended; false (and the thread stops) when
    /// none is left.
    fn still_listening(&mut self) -> bool {
        self.list.retain(|is_listening| is_listening());
        self.pulsing = !self.list.is_empty();
        self.pulsing
    }
}

static LISTENERS: Lazy<Mutex<Listeners>> = Lazy::new(|| Mutex::new(Listeners::default()));

pub fn is_paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

pub fn set_paused(app: &AppHandle, paused: bool) {
    // A recording that is running when pausing would never be stopped by
    // the key, which pausing ignores: it is cancelled instead (DESK-96).
    if paused && !is_paused() {
        let recording = app
            .try_state::<std::sync::Arc<crate::managers::audio::AudioRecordingManager>>()
            .is_some_and(|rm| rm.is_recording());
        if recording {
            crate::utils::cancel_current_operation(app);
        }
    }
    PAUSED.store(paused, Ordering::SeqCst);
    info!("WalkieTalkey {}", if paused { "paused" } else { "resumed" });
    let _ = app.emit("wt-paused", paused);
    crate::tray::update_tray_menu(app);
}

pub fn update_ready() -> bool {
    UPDATE_READY.load(Ordering::SeqCst)
}

pub fn set_update_ready(app: &AppHandle) {
    UPDATE_READY.store(true, Ordering::SeqCst);
    crate::tray::update_tray_menu(app);
}

pub fn pulse_phase() -> bool {
    PULSE_PHASE.load(Ordering::Relaxed)
}

/// Pulses the listening icon while `is_listening` holds (DESK-58, DESK-95),
/// and as long as any other dictation still listens: a phone dictation that
/// outlasts a key dictation keeps the pulse going.
pub fn pulse_while<F>(app: AppHandle, is_listening: F)
where
    F: Fn() -> bool + Send + 'static,
{
    let start = LISTENERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .join(Box::new(is_listening));
    if !start {
        return;
    }
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(700));
            let listening = LISTENERS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .still_listening();
            if !listening {
                break;
            }
            PULSE_PHASE.fetch_xor(true, Ordering::Relaxed);
            crate::tray::refresh_tray_icon(&app);
        }
        PULSE_PHASE.store(false, Ordering::Relaxed);
        crate::tray::refresh_tray_icon(&app);
    });
}

/// A recent item's menu label: its first words, on one line.
pub fn recent_label(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 40 {
        flat
    } else {
        let cut: String = flat.chars().take(39).collect();
        format!("{}…", cut.trim_end())
    }
}

/// The last five dictations as `(history id, label)`.
pub fn recent_items(app: &AppHandle) -> Vec<(i64, String)> {
    let Ok(dir) = crate::portable::app_data_dir(app) else {
        return Vec::new();
    };
    let (db_path, _) = super::history::paths(&dir);
    if !db_path.exists() {
        return Vec::new();
    }
    match super::history::open(&db_path).and_then(|conn| super::history::list(&conn, None, 5)) {
        Ok(items) => items
            .into_iter()
            .map(|item| (item.id, recent_label(&item.text)))
            .collect(),
        Err(e) => {
            warn!("Could not read recent dictations: {e}");
            Vec::new()
        }
    }
}

/// Copies a recent item (DESK-96), privately like every clipboard write.
pub fn copy_recent(app: &AppHandle, id: i64) {
    let Ok(dir) = crate::portable::app_data_dir(app) else {
        return;
    };
    let (db_path, _) = super::history::paths(&dir);
    let text = super::history::open(&db_path).and_then(|conn| super::history::text_of(&conn, id));
    match text {
        Ok(Some(text)) => {
            if let Err(e) = crate::clipboard::write_text(app, &text) {
                warn!("Could not copy dictation {id}: {e}");
            }
        }
        Ok(None) => warn!("Dictation {id} is no longer in the history"),
        Err(e) => warn!("Could not read dictation {id}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_labels_are_short_single_lines() {
        assert_eq!(recent_label("Hej\nmed dig"), "Hej med dig");
        let long = "ord ".repeat(30);
        let label = recent_label(&long);
        assert_eq!(label.chars().count(), 40);
        assert!(label.ends_with('…'));
    }

    #[test]
    fn the_pulse_lasts_while_any_dictation_listens() {
        // DESK-58, DESK-95: a key dictation ends while a phone one streams.
        use std::sync::Arc;
        let key = Arc::new(AtomicBool::new(true));
        let phone = Arc::new(AtomicBool::new(true));
        let mut listeners = Listeners::default();
        let k = Arc::clone(&key);
        assert!(listeners.join(Box::new(move || k.load(Ordering::SeqCst))));
        let p = Arc::clone(&phone);
        assert!(
            !listeners.join(Box::new(move || p.load(Ordering::SeqCst))),
            "one pulse thread"
        );
        assert!(listeners.still_listening());
        key.store(false, Ordering::SeqCst);
        assert!(listeners.still_listening(), "the phone still streams");
        phone.store(false, Ordering::SeqCst);
        assert!(!listeners.still_listening());
        // The next dictation starts a new pulse.
        assert!(listeners.join(Box::new(|| true)));
    }

    #[test]
    fn pause_is_a_runtime_flag_that_starts_off() {
        assert!(!is_paused(), "every start of the app is unpaused");
    }
}
