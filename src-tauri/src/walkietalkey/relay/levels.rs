//! The pill's waveform for phone dictations (DESK-58): `mic-level` frames
//! computed from the PCM blocks the phone sends, in the same shape as the
//! microphone's (16 bands, one frame per 512 samples, about 31 a second).
//! Blocks arrive 200 ms at a time, so the frames are queued and paced out
//! just above the overlay's emit throttle (`overlay::emit_levels` drops a
//! frame within 33 ms of the last one), so none is dropped there; the
//! queue is short and a backlog (a burst after a stall, or the frames the
//! slightly slower pacing leaves over) is dropped from the front so the
//! waveform stays live.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

use crate::audio_toolkit::audio::AudioVisualiser;
use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;

/// As the microphone's capture sink: 512-sample windows, 16 bands, 400 Hz to
/// 4 kHz.
pub const WINDOW: usize = 512;
pub const BANDS: usize = 16;
/// The audio one frame covers: one window (32 ms).
pub const WINDOW_DURATION: Duration = Duration::from_millis((WINDOW * 1000 / 16_000) as u64);
/// The pacing: a millisecond above the overlay's throttle, so whole
/// milliseconds between two frames are never fewer than it lets through.
pub const FRAME_INTERVAL: Duration = Duration::from_millis(crate::overlay::EMIT_THROTTLE_MS + 1);
/// At most this many frames wait (about a third of a second: a block and a
/// half, so the network's jitter is smoothed but the lag stays short).
pub const MAX_QUEUE: usize = 10;

/// Turns received audio into level frames and holds them for pacing.
pub struct LevelFeed {
    visualiser: AudioVisualiser,
    /// Samples short of a whole window, kept for the next block.
    pending: Vec<f32>,
    queue: VecDeque<Vec<f32>>,
}

impl Default for LevelFeed {
    fn default() -> Self {
        Self::new()
    }
}

impl LevelFeed {
    pub fn new() -> Self {
        Self {
            visualiser: AudioVisualiser::new(WHISPER_SAMPLE_RATE, WINDOW, BANDS, 400.0, 4000.0),
            pending: Vec::with_capacity(WINDOW),
            queue: VecDeque::new(),
        }
    }

    /// Queues the frames of `samples` (16 kHz mono, in order).
    pub fn push(&mut self, samples: &[f32]) {
        // The visualiser takes one window per call and drops the rest, so it
        // gets exactly one window at a time.
        self.pending.extend_from_slice(samples);
        let whole = self.pending.len() / WINDOW * WINDOW;
        for window in self.pending[..whole].chunks(WINDOW) {
            if let Some(levels) = self.visualiser.feed(window) {
                self.queue.push_back(levels);
            }
        }
        self.pending.drain(..whole);
        while self.queue.len() > MAX_QUEUE {
            self.queue.pop_front();
        }
    }

    /// The next frame to show.
    pub fn pop(&mut self) -> Option<Vec<f32>> {
        self.queue.pop_front()
    }

    pub fn queued(&self) -> usize {
        self.queue.len()
    }
}

/// A phone dictation's waveform: fed by the relay events, paced out to the
/// pill until stopped.
pub struct PhoneLevels {
    feed: Mutex<LevelFeed>,
    live: AtomicBool,
}

impl PhoneLevels {
    /// Starts pacing frames out as `mic-level` events.
    pub fn start(app: &AppHandle) -> Arc<Self> {
        let levels = Arc::new(Self {
            feed: Mutex::new(LevelFeed::new()),
            live: AtomicBool::new(true),
        });
        let pacer = Arc::clone(&levels);
        let app = app.clone();
        thread::spawn(move || {
            while pacer.live.load(Ordering::SeqCst) {
                let frame = pacer.feed.lock().unwrap_or_else(|e| e.into_inner()).pop();
                if let Some(frame) = frame {
                    crate::overlay::emit_levels(&app, &frame);
                }
                thread::sleep(FRAME_INTERVAL);
            }
        });
        levels
    }

    pub fn push(&self, samples: &[f32]) {
        if self.live.load(Ordering::SeqCst) {
            self.feed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(samples);
        }
    }

    /// The recording ended (or was cancelled).
    pub fn stop(&self) {
        self.live.store(false, Ordering::SeqCst);
    }

    /// Still pacing frames out.
    pub fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    /// Levels without a pacer (tests).
    #[cfg(test)]
    pub fn detached() -> Arc<Self> {
        Arc::new(Self {
            feed: Mutex::new(LevelFeed::new()),
            live: AtomicBool::new(true),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 200 ms block as the phone sends it.
    fn block(amplitude: f32) -> Vec<f32> {
        (0..3_200)
            .map(|i| amplitude * (i as f32 * 2.0 * std::f32::consts::PI * 800.0 / 16_000.0).sin())
            .collect()
    }

    #[test]
    fn a_block_gives_the_microphones_shape_and_rate() {
        // DESK-58: 16 bands, one frame per 32 ms of audio, as overlay.rs emits.
        let mut feed = LevelFeed::new();
        feed.push(&block(0.3));
        assert_eq!(
            feed.queued(),
            6,
            "3,200 samples hold six 512-sample windows"
        );
        let frame = feed.pop().unwrap();
        assert_eq!(frame.len(), BANDS);
        assert!(frame.iter().all(|v| (0.0..=1.0).contains(v)));
        assert_eq!(WINDOW_DURATION, Duration::from_millis(32));
    }

    /// `overlay::emit_levels`'s throttle: a frame within the throttle of the
    /// last one sent is dropped, on a whole-millisecond clock.
    fn frames_the_overlay_drops(interval: Duration, frames: usize) -> usize {
        let throttle = crate::overlay::EMIT_THROTTLE_MS;
        // Start between two milliseconds, where rounding hurts most.
        let start_us = 1_000_000_123u64;
        let mut last_ms = 0u64;
        let mut dropped = 0;
        for k in 0..frames as u64 {
            let now_ms = (start_us + k * interval.as_micros() as u64) / 1_000;
            if now_ms.saturating_sub(last_ms) < throttle {
                dropped += 1;
            } else {
                last_ms = now_ms;
            }
        }
        dropped
    }

    #[test]
    fn the_overlay_lets_every_paced_frame_through() {
        // At 32 ms, about every other frame fell under the 33 ms throttle.
        assert!(frames_the_overlay_drops(Duration::from_millis(32), 100) > 30);
        assert_eq!(frames_the_overlay_drops(FRAME_INTERVAL, 1_000), 0);
        assert!(FRAME_INTERVAL > Duration::from_millis(crate::overlay::EMIT_THROTTLE_MS));
    }

    #[test]
    fn the_slower_pacing_never_lags_more_than_the_queue() {
        // 34 ms per frame against 32 ms of audio per frame: the surplus is
        // dropped from the front, so the waveform stays within a third of a
        // second of the voice.
        let mut feed = LevelFeed::new();
        for _ in 0..50 {
            feed.push(&block(0.3)); // 200 ms of audio
            for _ in 0..(200 / FRAME_INTERVAL.as_millis() as usize) {
                feed.pop();
            }
            assert!(feed.queued() <= MAX_QUEUE);
        }
        assert!(FRAME_INTERVAL * MAX_QUEUE as u32 <= Duration::from_millis(350));
    }

    #[test]
    fn speech_moves_the_waveform_and_silence_does_not() {
        let mut feed = LevelFeed::new();
        feed.push(&block(0.3));
        let loud = feed.pop().unwrap();
        while feed.pop().is_some() {}
        feed.push(&vec![0.0; 3_200]);
        let mut quiet = Vec::new();
        while let Some(frame) = feed.pop() {
            quiet = frame;
        }
        let sum = |f: &[f32]| f.iter().sum::<f32>();
        assert!(sum(&loud) > 1.0, "speech shows: {loud:?}");
        assert!(sum(&quiet) < 0.01, "silence is flat: {quiet:?}");
    }

    #[test]
    fn no_audio_is_lost_between_blocks() {
        let mut feed = LevelFeed::new();
        for _ in 0..5 {
            feed.push(&block(0.3)); // 5 x 3,200 = 16,000 samples
            while feed.pop().is_some() {}
        }
        feed.push(&[]);
        assert_eq!(feed.pending.len(), 16_000 % WINDOW);
    }

    #[test]
    fn a_backlog_is_dropped_from_the_front() {
        let mut feed = LevelFeed::new();
        for _ in 0..10 {
            feed.push(&block(0.3));
        }
        assert_eq!(feed.queued(), MAX_QUEUE);
    }
}
