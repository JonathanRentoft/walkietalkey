//! The live bench (DESK-43, DESK-46): a WAV fed through the same live
//! recording path as the key, in 200 ms pieces at real-time speed, each piece
//! arriving when its 200 ms of audio has been "spoken", as the microphone and
//! the phone deliver them. The recording then finishes like a key release, and
//! the wait from the end of the audio to the final text is what the user waits.

use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::managers::transcription::TranscriptionManager;

/// 200 ms of 16 kHz audio, the microphone's and the phone's piece size.
pub const PIECE_SAMPLES: usize = 3_200;

/// When each piece is due: the end of its 200 ms of audio, from `start`.
pub fn piece_due(start: Instant, index: usize) -> Instant {
    start + Duration::from_millis(200 * (index as u64 + 1))
}

/// Feeds `samples` live at real-time speed and finishes the recording.
/// Returns the final text and the wait after the end of the audio.
pub fn transcribe_live(tm: &TranscriptionManager, samples: &[f32]) -> Result<(String, Duration)> {
    let router = tm.stream_router();
    tm.start_stream();
    let start = Instant::now();
    for (index, piece) in samples.chunks(PIECE_SAMPLES).enumerate() {
        thread::sleep(piece_due(start, index).saturating_duration_since(Instant::now()));
        router.feed(piece);
    }
    let released = Instant::now();
    let text = tm.transcribe_recording(samples.to_vec())?;
    Ok((text, released.elapsed()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pieces_arrive_when_their_audio_has_been_spoken() {
        let start = Instant::now();
        assert_eq!(piece_due(start, 0) - start, Duration::from_millis(200));
        assert_eq!(piece_due(start, 74) - start, Duration::from_secs(15));
        assert_eq!(PIECE_SAMPLES, 16_000 / 5);
    }
}
