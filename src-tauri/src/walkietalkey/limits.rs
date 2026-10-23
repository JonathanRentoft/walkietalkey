//! Maximum 5 minutes per dictation (DESK-24, PHONE-29): from 4:45 the pill
//! counts down, and at 5:00 the recording stops and what it has is
//! transcribed.

use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

pub const MAX_RECORDING: Duration = Duration::from_secs(5 * 60);
pub const COUNTDOWN_FROM: Duration = Duration::from_secs(4 * 60 + 45);

/// Seconds left to show in the pill, once the countdown has started.
pub fn seconds_left(elapsed: Duration) -> Option<u64> {
    (elapsed >= COUNTDOWN_FROM).then(|| MAX_RECORDING.saturating_sub(elapsed).as_secs())
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct CountdownEvent {
    pub seconds_left: u64,
}

/// Watches a key dictation's length while it is current: countdown events
/// from 4:45, then a forced stop at 5:00.
pub fn watch<C>(app: AppHandle, started: Instant, is_current: C)
where
    C: Fn() -> bool + Send + 'static,
{
    thread::spawn(move || {
        while is_current() {
            let elapsed = started.elapsed();
            if elapsed >= MAX_RECORDING {
                log::info!("Dictation reached 5 minutes; stopping and transcribing");
                if let Some(coordinator) = app.try_state::<crate::TranscriptionCoordinator>() {
                    coordinator.force_stop();
                }
                return;
            }
            if let Some(seconds_left) = seconds_left(elapsed) {
                let _ = app.emit("wt-pill-countdown", CountdownEvent { seconds_left });
            }
            // Wake at the countdown, then every second.
            let next = if elapsed < COUNTDOWN_FROM {
                (COUNTDOWN_FROM - elapsed).min(Duration::from_secs(1))
            } else {
                Duration::from_secs(1) - Duration::from_nanos(u64::from(elapsed.subsec_nanos()))
            };
            thread::sleep(next.max(Duration::from_millis(20)));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_countdown_starts_at_4_45_and_ends_at_5_00() {
        assert_eq!(seconds_left(Duration::from_secs(60)), None);
        assert_eq!(seconds_left(Duration::from_secs(284)), None);
        assert_eq!(seconds_left(Duration::from_secs(285)), Some(15));
        assert_eq!(seconds_left(Duration::from_millis(299_500)), Some(0));
        assert_eq!(seconds_left(Duration::from_secs(400)), Some(0));
    }
}
