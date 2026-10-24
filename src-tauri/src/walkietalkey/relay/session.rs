//! One phone dictation's audio (DESK-61, PHONE-31, PHONE-32). Frames carry
//! 1 to 10 blocks of 200 ms (3,200 samples of 16-bit PCM) starting at a block
//! index. Blocks are fed to the live chunker in order as soon as they are
//! contiguous; duplicates after a resend are dropped; at `audio_end` the
//! missing blocks are known, and the app waits up to 5 s for the resend.

use std::collections::BTreeMap;
use std::time::Duration;

/// Samples per 200 ms block at 16 kHz.
pub const BLOCK_SAMPLES: usize = 3_200;
/// How long to wait for a resend of missing blocks after `audio_end`.
pub const RESEND_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
pub struct SessionAudio {
    /// The next block index to feed.
    next: u32,
    /// Blocks that arrived ahead of `next`.
    pending: BTreeMap<u32, Vec<f32>>,
    /// From `audio_end`: how many blocks the phone sent.
    expected: Option<u32>,
    /// Every sample fed so far, in order (the whole recording at the end).
    fed: Vec<f32>,
}

/// PCM16 little-endian bytes as samples in [-1, 1].
fn samples(pcm: &[u8]) -> Vec<f32> {
    pcm.chunks_exact(2)
        .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0)
        .collect()
}

impl SessionAudio {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a frame's blocks. Returns the audio that became contiguous, in
    /// order, ready for the live chunker.
    pub fn add(&mut self, first_index: u32, pcm: &[u8]) -> Vec<f32> {
        let all = samples(pcm);
        for (offset, block) in all.chunks(BLOCK_SAMPLES).enumerate() {
            let index = first_index + offset as u32;
            if index >= self.next {
                self.pending.entry(index).or_insert_with(|| block.to_vec());
            }
        }
        let mut ready = Vec::new();
        while let Some(block) = self.pending.remove(&self.next) {
            ready.extend_from_slice(&block);
            self.next += 1;
        }
        self.fed.extend_from_slice(&ready);
        ready
    }

    /// `audio_end`: the phone sent `chunks` blocks in all.
    pub fn end(&mut self, chunks: u32) {
        self.expected = Some(chunks);
    }

    /// Block indexes still missing (only meaningful after `end`).
    pub fn missing(&self) -> Vec<u32> {
        let Some(expected) = self.expected else {
            return Vec::new();
        };
        (self.next..expected)
            .filter(|i| !self.pending.contains_key(i))
            .collect()
    }

    /// Whether every block up to `audio_end` has been fed.
    pub fn is_complete(&self) -> bool {
        self.expected.is_some_and(|expected| self.next >= expected)
    }

    /// After the resend wait: feeds what arrived after a gap anyway, so the
    /// app transcribes what it has (DESK-61). Returns that audio.
    pub fn give_up_on_gaps(&mut self) -> Vec<f32> {
        let mut ready = Vec::new();
        for (index, block) in std::mem::take(&mut self.pending) {
            ready.extend_from_slice(&block);
            self.next = index + 1;
        }
        self.fed.extend_from_slice(&ready);
        ready
    }

    /// The recording so far.
    pub fn audio(&self) -> &[f32] {
        &self.fed
    }

    pub fn duration(&self) -> Duration {
        Duration::from_secs_f64(self.fed.len() as f64 / 16_000.0)
    }

    /// All audio received so far, the blocks after a gap included.
    pub fn received(&self) -> Duration {
        let waiting: usize = self.pending.values().map(Vec::len).sum();
        Duration::from_secs_f64((self.fed.len() + waiting) as f64 / 16_000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `n` blocks whose samples all hold their block index.
    fn blocks(first: u32, n: u32) -> Vec<u8> {
        (first..first + n)
            .flat_map(|i| std::iter::repeat((i as i16).to_le_bytes()).take(BLOCK_SAMPLES))
            .flatten()
            .collect()
    }

    fn block_ids(audio: &[f32]) -> Vec<u32> {
        audio
            .chunks(BLOCK_SAMPLES)
            .map(|b| (b[0] * 32768.0).round() as u32)
            .collect()
    }

    #[test]
    fn in_order_frames_are_fed_at_once() {
        let mut s = SessionAudio::new();
        assert_eq!(block_ids(&s.add(0, &blocks(0, 1))), vec![0]);
        assert_eq!(block_ids(&s.add(1, &blocks(1, 1))), vec![1]);
        s.end(2);
        assert!(s.is_complete());
        assert!(s.missing().is_empty());
        assert_eq!(s.audio().len(), 2 * BLOCK_SAMPLES);
    }

    #[test]
    fn early_blocks_wait_for_the_gap() {
        let mut s = SessionAudio::new();
        s.add(0, &blocks(0, 1));
        assert!(s.add(2, &blocks(2, 1)).is_empty(), "block 1 is missing");
        s.end(4);
        assert_eq!(s.missing(), vec![1, 3]);
        assert_eq!(block_ids(&s.add(1, &blocks(1, 1))), vec![1, 2]);
        assert_eq!(s.missing(), vec![3]);
    }

    #[test]
    fn a_resend_of_the_whole_session_drops_duplicates() {
        let mut s = SessionAudio::new();
        s.add(0, &blocks(0, 3));
        // PHONE-32: after a reconnect the phone resends everything, 10 per frame.
        let fed = s.add(0, &blocks(0, 5));
        assert_eq!(block_ids(&fed), vec![3, 4]);
        s.end(5);
        assert!(s.is_complete());
        assert_eq!(block_ids(s.audio()), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn after_the_wait_the_app_transcribes_what_it_has() {
        let mut s = SessionAudio::new();
        s.add(0, &blocks(0, 1));
        s.add(3, &blocks(3, 2));
        s.end(5);
        assert_eq!(s.missing(), vec![1, 2]);
        assert_eq!(block_ids(&s.give_up_on_gaps()), vec![3, 4]);
        assert_eq!(block_ids(s.audio()), vec![0, 3, 4]);
        assert!(s.is_complete());
    }

    #[test]
    fn received_audio_counts_the_blocks_after_a_gap() {
        let mut s = SessionAudio::new();
        s.add(0, &blocks(0, 2));
        s.add(5, &blocks(5, 3));
        assert_eq!(s.duration().as_millis(), 400);
        assert_eq!(s.received().as_millis(), 1_000);
    }

    #[test]
    fn a_short_last_block_is_kept() {
        let mut s = SessionAudio::new();
        let mut pcm = blocks(0, 1);
        pcm.extend_from_slice(&[0u8; 640]); // 20 ms more
        s.add(0, &pcm);
        assert_eq!(s.audio().len(), BLOCK_SAMPLES + 320);
        assert!(s.duration() > Duration::from_millis(219));
    }
}
