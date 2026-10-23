//! The menu bar and tray additions (DESK-95..97): "Seneste" (the last five
//! dictations; a click copies), "Par en telefon", "Sæt på pause", "Genstart
//! nu" once an update is ready, and the listening pulse.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use log::{info, warn};
use tauri::{AppHandle, Emitter};

/// "Sæt på pause" (DESK-96): the key does nothing and phone dictations are
/// answered with `paused`, until "Genoptag" or the next start of the app.
static PAUSED: AtomicBool = AtomicBool::new(false);

/// An update has been downloaded and installs on restart (DESK-111).
static UPDATE_READY: AtomicBool = AtomicBool::new(false);

/// Which of the two listening frames the icon shows (DESK-95 pulse).
static PULSE_PHASE: AtomicBool = AtomicBool::new(false);
static PULSING: AtomicBool = AtomicBool::new(false);

pub fn is_paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

pub fn set_paused(app: &AppHandle, paused: bool) {
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

/// Pulses the listening icon while `is_listening` holds.
pub fn pulse_while<F>(app: AppHandle, is_listening: F)
where
    F: Fn() -> bool + Send + 'static,
{
    if PULSING.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        while is_listening() {
            thread::sleep(Duration::from_millis(700));
            PULSE_PHASE.fetch_xor(true, Ordering::Relaxed);
            crate::tray::refresh_tray_icon(&app);
        }
        PULSE_PHASE.store(false, Ordering::Relaxed);
        PULSING.store(false, Ordering::SeqCst);
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
    fn pause_is_a_runtime_flag_that_starts_off() {
        assert!(!is_paused(), "every start of the app is unpaused");
    }
}
