//! The pill's window (run 4, DESK-55): large enough for the whole glow,
//! transparent with no window shadow, and click-through everywhere but the
//! pill itself.
//!
//! The owner saw the pill's glow cut off in a hard rectangle. The glow (the
//! halo's blur and the pill's drop shadow) reached 29 px beyond the pill in
//! WebKit, the Mac's engine, with the window leaving 32 px; a macOS window
//! shadow on the transparent panel can draw the window's rectangle as well.
//! Now the window leaves [`GLOW_MARGIN`] on every side
//! (`tests/walkietalkey/pill-glow.spec.ts` renders every pill state in WebKit
//! and Chromium at this size and checks that the window's edge stays fully
//! transparent), the shadow is switched off each time the pill shows, and
//! the window lets clicks through except over the pill: the page reports
//! the pill's rectangle ([`wt_pill_rect`]) and [`track_clicks`] follows the
//! cursor while the pill is shown.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};

/// The widest pill: about 220 px listening, up to 416 px with its longest text.
pub const PILL_MAX_WIDTH: f64 = 416.0;
/// The pill's height (DictationPill size "lg").
pub const PILL_HEIGHT: f64 = 56.0;
/// Room for the glow on every side of the pill. The listening halo's blur
/// reaches about 29 px in WebKit and 28 px in Chromium; the rest is margin.
/// `src/walkietalkey/pill/pill.css` keeps the pill within it
/// (`--wt-glow-margin`).
pub const GLOW_MARGIN: f64 = 48.0;
/// The overlay window: the widest pill and its glow.
pub const WINDOW_WIDTH: f64 = PILL_MAX_WIDTH + 2.0 * GLOW_MARGIN;
pub const WINDOW_HEIGHT: f64 = PILL_HEIGHT + 2.0 * GLOW_MARGIN;

/// How often the cursor is checked while the pill is shown.
const TRACK_INTERVAL: Duration = Duration::from_millis(40);
/// Slack around the pill, in CSS pixels, so its rounded edge catches clicks.
const SLACK: f64 = 1.0;

/// The pill's rectangle in the overlay page, in CSS pixels from the window's
/// top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct PillRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

static PILL_RECT: Mutex<Option<PillRect>> = Mutex::new(None);
static SHOWN: AtomicBool = AtomicBool::new(false);
static TRACKING: AtomicBool = AtomicBool::new(false);

/// The overlay page reports where the pill is whenever it moves or resizes.
#[tauri::command]
#[specta::specta]
pub fn wt_pill_rect(rect: PillRect) {
    *PILL_RECT.lock().unwrap_or_else(|e| e.into_inner()) = Some(rect);
}

/// Whether `point` (CSS pixels from the window's top-left) is over the pill.
pub fn over_pill(point: (f64, f64), rect: &PillRect) -> bool {
    let (x, y) = point;
    x >= rect.x - SLACK
        && x <= rect.x + rect.width + SLACK
        && y >= rect.y - SLACK
        && y <= rect.y + rect.height + SLACK
}

/// The cursor relative to the window's top-left, in CSS pixels. On the Mac
/// both are converted to points: tao reports the cursor in the primary
/// display's physical pixels and the window in its own display's.
pub fn cursor_in_window(
    cursor_physical: (f64, f64),
    cursor_scale: f64,
    window_physical: (f64, f64),
    window_scale: f64,
    css_per_point: f64,
) -> (f64, f64) {
    (
        (cursor_physical.0 / cursor_scale - window_physical.0 / window_scale) / css_per_point,
        (cursor_physical.1 / cursor_scale - window_physical.1 / window_scale) / css_per_point,
    )
}

/// The pill was shown or hidden (overlay.rs; shown on the main thread). Shown:
/// no window shadow, a clear window, and clicks pass through until the cursor
/// is over the pill.
pub fn set_shown(window: &tauri::WebviewWindow, shown: bool) {
    SHOWN.store(shown, Ordering::SeqCst);
    if shown {
        let _ = window.set_shadow(false);
        #[cfg(target_os = "macos")]
        clear_panel(window);
        let _ = window.set_ignore_cursor_events(true);
    }
}

/// Makes the Mac's panel fully transparent and shadowless, logging what it
/// found: a shadow on a transparent panel is drawn from a snapshot of its
/// content and can show as the window's rectangle.
#[cfg(target_os = "macos")]
fn clear_panel(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSColor;

    let Ok(ptr) = window.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    // SAFETY: the live NSWindow Tauri owns, used on the main thread
    // (show_overlay_state_on_main).
    unsafe {
        let panel = &*(ptr as *const AnyObject);
        let had_shadow: bool = msg_send![panel, hasShadow];
        let was_opaque: bool = msg_send![panel, isOpaque];
        if had_shadow || was_opaque {
            log::info!(
                "Pill window had shadow={had_shadow} opaque={was_opaque}; switching both off"
            );
        }
        let clear = NSColor::clearColor();
        let _: () = msg_send![panel, setHasShadow: false];
        let _: () = msg_send![panel, setOpaque: false];
        let _: () = msg_send![panel, setBackgroundColor: &*clear];
        let _: () = msg_send![panel, invalidateShadow];
    }
}

/// Starts the cursor tracker (once). While the pill is shown it lets clicks
/// through the window except over the pill.
pub fn track_clicks(app: &AppHandle) {
    if TRACKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("wt-pill-clicks".into())
        .spawn(move || {
            let mut ignoring = true;
            loop {
                thread::sleep(TRACK_INTERVAL);
                if !SHOWN.load(Ordering::SeqCst) {
                    ignoring = true;
                    continue;
                }
                let Some(window) = app.get_webview_window("recording_overlay") else {
                    continue;
                };
                let over = cursor_over_pill(&app, &window).unwrap_or(false);
                if over == ignoring {
                    ignoring = !over;
                    let _ = window.set_ignore_cursor_events(ignoring);
                }
            }
        });
    if spawned.is_err() {
        TRACKING.store(false, Ordering::SeqCst);
    }
}

fn cursor_over_pill(app: &AppHandle, window: &tauri::WebviewWindow) -> Option<bool> {
    let rect = (*PILL_RECT.lock().unwrap_or_else(|e| e.into_inner()))?;
    let cursor = app.cursor_position().ok()?;
    let origin = window.outer_position().ok()?;
    let window_scale = window.scale_factor().ok()?;
    // tao: the Mac's cursor is in the primary display's pixels; elsewhere it
    // is in the same physical space as the window.
    let cursor_scale = if cfg!(target_os = "macos") {
        app.primary_monitor().ok()??.scale_factor()
    } else {
        window_scale
    };
    // CSS pixels per point: 1, except Windows' text scale, which WebView2
    // applies as a zoom (overlay.rs).
    let css_per_point = crate::overlay::text_scale_factor();
    let point = cursor_in_window(
        (cursor.x, cursor.y),
        cursor_scale,
        (origin.x as f64, origin.y as f64),
        window_scale,
        css_per_point,
    );
    Some(over_pill(point, &rect))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECT: PillRect = PillRect {
        x: 96.0,
        y: 48.0,
        width: 320.0,
        height: 56.0,
    };

    #[test]
    fn the_window_holds_the_widest_pill_and_its_glow() {
        assert_eq!((WINDOW_WIDTH, WINDOW_HEIGHT), (512.0, 152.0));
        // Measured glow: 29 px in WebKit, 28 px in Chromium (pill-glow.spec.ts).
        assert!(GLOW_MARGIN >= 29.0 + 16.0);
        // The page keeps the pill inside the margin with the same number.
        let css = include_str!("../../../src/walkietalkey/pill/pill.css");
        assert!(
            css.contains(&format!("--wt-glow-margin: {GLOW_MARGIN}px")),
            "pill.css sets --wt-glow-margin: {GLOW_MARGIN}px"
        );
    }

    #[test]
    fn only_the_pill_catches_the_cursor() {
        assert!(over_pill((100.0, 60.0), &RECT));
        assert!(over_pill((416.0, 104.0), &RECT), "the far corner");
        assert!(over_pill((95.5, 47.5), &RECT), "a pixel of slack");
        // The glow around it lets clicks through.
        assert!(!over_pill((60.0, 76.0), &RECT));
        assert!(!over_pill((256.0, 20.0), &RECT));
        assert!(!over_pill((256.0, 140.0), &RECT));
    }

    #[test]
    fn the_cursor_is_compared_in_points_across_displays() {
        // The Mac: a 2x primary display, the window on a 1x display at (2000, 100) points.
        let point = cursor_in_window((4200.0, 300.0), 2.0, (2000.0, 100.0), 1.0, 1.0);
        assert_eq!(point, (100.0, 50.0));
        // Windows at 150 % with the text at 125 %: physical pixels throughout.
        let point = cursor_in_window((1150.0, 690.0), 1.5, (1000.0, 600.0), 1.5, 1.25);
        assert!((point.0 - 80.0).abs() < 1e-9 && (point.1 - 48.0).abs() < 1e-9);
    }
}
