//! Long-form chunking: long audio is decoded in chunks cut at pauses, because
//! most models' accuracy degrades past 30-40 s of audio in one run.
//!
//! Cuts come from per-frame voice activity probabilities. Every duration here
//! is in samples of 16 kHz audio, never in frames, so any detector's frame size
//! works with the same rules. The thresholds are Silero's.
//!
//! Ported from pi-voice's `chunking.ts`. The cut plan is the same; the Rust
//! version returns chunks for the caller to decode rather than decoding them.

use std::ops::Range;

use anyhow::Result;
use log::{debug, warn};
use once_cell::sync::Lazy;
use regex::Regex;

use super::constants;
use super::vad::SpeechScorer;

const RATE: usize = constants::WHISPER_SAMPLE_RATE as usize;

/// How long chunks are, in samples of 16 kHz audio.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChunkPlan {
    /// Cuts prefer pauses about this far into a chunk.
    pub target_seconds: f64,
    /// No chunk is longer; audio up to this long is decoded in one piece.
    pub max_chunk_samples: usize,
    /// No chunk is shorter, unless the whole clip is.
    pub min_chunk_samples: usize,
    /// Live, a cut is only final once this much audio past its window is
    /// scored: then no cut it allows can leave a short rest, so live cuts
    /// match the plan for the whole clip.
    pub lookahead_samples: usize,
    /// When the recording stops, a rest up to this long is decoded in one
    /// piece rather than cut again.
    pub whole_rest_samples: usize,
    /// WalkieTalkey: end a piece at every pause the VAD finds once the piece
    /// is `min_chunk_samples` long, instead of preferring pauses near the
    /// target ([`ChunkPlan::LIVE_SEGMENTS`]).
    pub split_at_pauses: bool,
    /// With `split_at_pauses`: only pauses at least this long end a piece, so
    /// a short hesitation inside a sentence stays in its piece.
    pub min_pause_samples: usize,
    /// With `split_at_pauses` (run 5): a pause only ends a piece when the VAD
    /// finds at least this much speech on each side of it, from the previous
    /// cut and up to the end of the recording. Less before it, and that
    /// stretch joins the next piece; less after it, and live the cut waits
    /// for more speech, so at the end a short rest joins the piece before it.
    /// Whisper-family models decode every piece as an utterance and never
    /// return nothing: a piece that holds only a click, a breath or one short
    /// word comes back with invented words.
    pub min_piece_speech_samples: usize,
}

impl ChunkPlan {
    /// Handy's long-form plan: about 30 s, never cutting 40 s or less.
    pub const HANDY: Self = Self {
        target_seconds: 30.0,
        max_chunk_samples: 40 * RATE,
        min_chunk_samples: 5 * RATE,
        lookahead_samples: 5 * RATE,
        whole_rest_samples: 40 * RATE,
        split_at_pauses: false,
        min_pause_samples: 0,
        min_piece_speech_samples: 0,
    };

    /// WalkieTalkey's live plan (DESK-46): 10 to 20 s chunks cut only in
    /// pauses, keeping the 5 s minimum, so at release only a short rest is
    /// left whatever the total length. The rest (at most the maximum plus the
    /// lookahead, 20 s) is one piece: it fits one Whisper window, so it costs
    /// one encoder pass, and it is never much longer than a short dictation.
    /// The short lookahead is enough live: a short last piece only decodes
    /// faster.
    pub const LIVE_DA: Self = Self {
        target_seconds: 14.0,
        max_chunk_samples: 18 * RATE,
        min_chunk_samples: 5 * RATE,
        lookahead_samples: 2 * RATE,
        whole_rest_samples: 20 * RATE,
        split_at_pauses: false,
        min_pause_samples: 0,
        min_piece_speech_samples: 0,
    };

    /// WalkieTalkey, for Edda (docs/MODELS.md, "Edda and pauses"): decoded
    /// greedily, Edda stops at the first pause of a window that holds more
    /// than one sentence. So a pause of half a second or more (as the VAD
    /// measures it), the usual break between sentences, ends a piece once the
    /// piece is a second long; a sentence with its shorter pauses stays whole.
    /// Each piece is decoded on its own while the user talks: at release only
    /// the piece since the last such pause is left, whatever the length
    /// (DESK-46). A stretch without one is cut as [`Self::LIVE_DA`] cuts it.
    /// A piece that still comes out cut short is split at its shorter pauses
    /// ([`Self::LIVE_SEGMENTS_FINE`]). Run 5: a pause only ends a piece with
    /// 1.5 s of speech on each side of it, so a noise or a few words on their
    /// own after a pause are decoded with their neighbour (docs/MODELS.md,
    /// "Invented words on short pieces").
    pub const LIVE_SEGMENTS: Self = Self {
        target_seconds: 14.0,
        max_chunk_samples: 18 * RATE,
        min_chunk_samples: RATE,
        lookahead_samples: 2 * RATE,
        whole_rest_samples: 0,
        split_at_pauses: true,
        min_pause_samples: RATE / 2,
        min_piece_speech_samples: 3 * RATE / 2,
    };

    /// [`Self::LIVE_SEGMENTS`] cut at every pause of a tenth of a second, for
    /// a piece whose text came out cut short.
    pub const LIVE_SEGMENTS_FINE: Self = Self {
        min_pause_samples: RATE / 10,
        ..Self::LIVE_SEGMENTS
    };
}

impl Default for ChunkPlan {
    fn default() -> Self {
        Self::HANDY
    }
}

// Silero's `get_speech_timestamps` defaults, as `VadSession::run` applies them.
const THRESHOLD: f32 = 0.5;
const NEG_THRESHOLD: f32 = THRESHOLD - 0.15;
const MIN_SPEECH_SAMPLES: usize = 250 * RATE / 1000;
const MIN_SILENCE_SAMPLES: usize = 100 * RATE / 1000;
const SPEECH_PAD_SAMPLES: usize = 30 * RATE / 1000;

/// Speech segments, in samples, from per-frame speech probabilities: Silero's
/// `get_speech_timestamps` without a maximum speech length. `samples` is the
/// length of the audio the probabilities score.
fn speech_segments(probs: &[f32], frame_samples: usize, samples: usize) -> Vec<Range<usize>> {
    let mut segments: Vec<Range<usize>> = Vec::new();
    let mut triggered = false;
    let mut start = 0;
    let mut temp_end: Option<usize> = None;
    for (i, &prob) in probs.iter().enumerate() {
        let at = i * frame_samples;
        if prob >= THRESHOLD {
            temp_end = None;
            if !triggered {
                triggered = true;
                start = at;
            }
            continue;
        }
        if prob < NEG_THRESHOLD && triggered {
            let end = *temp_end.get_or_insert(at);
            if at - end < MIN_SILENCE_SAMPLES {
                continue;
            }
            if end - start > MIN_SPEECH_SAMPLES {
                segments.push(start..end);
            }
            triggered = false;
            temp_end = None;
        }
    }
    if triggered && samples.saturating_sub(start) > MIN_SPEECH_SAMPLES {
        segments.push(start..samples);
    }

    for i in 0..segments.len() {
        if i == 0 {
            segments[0].start = segments[0].start.saturating_sub(SPEECH_PAD_SAMPLES);
        }
        if i + 1 == segments.len() {
            segments[i].end = (segments[i].end + SPEECH_PAD_SAMPLES).min(samples);
            continue;
        }
        let silence = segments[i + 1].start - segments[i].end;
        let pad = if silence < 2 * SPEECH_PAD_SAMPLES {
            silence / 2
        } else {
            SPEECH_PAD_SAMPLES
        };
        segments[i].end = (segments[i].end + pad).min(samples);
        segments[i + 1].start = segments[i + 1].start.saturating_sub(pad);
    }
    segments
}

/// A place a chunk may end: the middle of a pause.
#[derive(Debug, Clone, Copy, PartialEq)]
struct CutCandidate {
    cut: usize,
    gap_seconds: f64,
}

/// The part of `segment` from `from` on, in samples.
fn speech_from(segment: &Range<usize>, from: usize) -> usize {
    segment.end.saturating_sub(segment.start.max(from))
}

/// How much of `range` the speech segments cover, in samples.
fn speech_within(segments: &[Range<usize>], range: Range<usize>) -> usize {
    segments
        .iter()
        .map(|segment| {
            segment
                .end
                .min(range.end)
                .saturating_sub(segment.start.max(range.start))
        })
        .sum()
}

/// Cuts in the middle of every pause of at least the plan's minimum that
/// speech has come back after (so the cut can no longer move), from `start`
/// on. A cut that would end a piece shorter than the minimum, or with less
/// speech than the minimum, is left out: that fragment joins the next piece.
/// A cut with less speech than the minimum after it in all of `segments` is
/// not made yet: live, it waits for more speech; at the end, the rest joins
/// the piece before it.
fn pause_cuts(segments: &[Range<usize>], start: usize, plan: &ChunkPlan) -> Vec<usize> {
    let mut cuts = Vec::new();
    let mut from = start;
    // Speech from the last cut to the pause at hand, and after that pause.
    let mut before = 0;
    let mut after: usize = segments.iter().map(|s| speech_from(s, start)).sum();
    for pair in segments.windows(2) {
        let spoken = speech_from(&pair[0], from);
        before += spoken;
        after -= spoken;
        if pair[1].start.saturating_sub(pair[0].end) < plan.min_pause_samples {
            continue;
        }
        let cut = (pair[0].end + pair[1].start) / 2;
        if cut < from + plan.min_chunk_samples || before < plan.min_piece_speech_samples {
            continue;
        }
        if after < plan.min_piece_speech_samples {
            break;
        }
        cuts.push(cut);
        from = cut;
        before = 0;
    }
    cuts
}

/// One candidate in the middle of each pause, lead-in and tail included.
fn cut_candidates(segments: &[Range<usize>], samples: usize) -> Vec<CutCandidate> {
    let mut candidates = Vec::new();
    let mut silence_start = 0;
    for segment in segments
        .iter()
        .cloned()
        .chain(std::iter::once(samples..samples))
    {
        if segment.start > silence_start {
            candidates.push(CutCandidate {
                cut: (silence_start + segment.start) / 2,
                gap_seconds: (segment.start - silence_start) as f64 / RATE as f64,
            });
        }
        silence_start = silence_start.max(segment.end);
    }
    candidates
}

/// The most audio one piece may hold when the plan keeps a piece whole rather
/// than cut off a stretch without speech: just under one Whisper window.
const WINDOW_SAMPLES: usize = 28 * RATE;

/// Greedy, left to right from `from`: each cut is the best-scoring pause
/// min-max after the previous one (5-40 s in Handy's plan), preferring long
/// pauses near the target and ones that leave at least the minimum after
/// them. With no pause, it is a hard cut at the maximum, or halfway when that
/// would leave under the minimum. Audio of the maximum or less is never cut.
/// `candidates` must be in order; `segments` are the speech they are cut
/// between.
///
/// With [`ChunkPlan::min_piece_speech_samples`] (run 5), a pause is only used
/// with that much speech on each side of it (after it, within the lookahead
/// past the maximum, so live cuts match the plan for the whole clip). When no
/// pause will do and there is no more than that much speech past the
/// maximum either, the stretch is kept whole up to one window: what is past
/// the maximum is silence or a noise, which must not be decoded alone.
fn plan_cuts(
    plan: &ChunkPlan,
    candidates: &[CutCandidate],
    segments: &[Range<usize>],
    samples: usize,
    from: usize,
) -> Vec<usize> {
    let max_chunk = plan.max_chunk_samples;
    let min_chunk = plan.min_chunk_samples;
    let min_speech = plan.min_piece_speech_samples;
    let target = plan.target_seconds;
    let mut cuts = Vec::new();
    let mut start = from;
    // Each window starts after the last, so earlier candidates never return.
    let mut first = 0;
    while samples - start > max_chunk {
        while first < candidates.len() && candidates[first].cut < start + min_chunk {
            first += 1;
        }
        let horizon = samples.min(start + max_chunk + plan.lookahead_samples);
        let speech_around = |cut: usize| {
            min_speech == 0
                || (speech_within(segments, start..cut) >= min_speech
                    && speech_within(segments, cut..horizon) >= min_speech)
        };
        // A pause that leaves under 5 s is only used when no other pause will do.
        let mut best: Option<(usize, f64)> = None;
        let mut fallback: Option<(usize, f64)> = None;
        for candidate in candidates[first..]
            .iter()
            .take_while(|candidate| candidate.cut <= start + max_chunk)
            .filter(|candidate| speech_around(candidate.cut))
        {
            let position = (candidate.cut - start) as f64 / RATE as f64;
            let off_target = if position > target {
                0.1 * (position - target)
            } else {
                0.05 * (target - position)
            };
            let score = candidate.gap_seconds.min(1.0) - off_target;
            if samples - candidate.cut >= min_chunk && best.is_none_or(|(_, best)| score > best) {
                best = Some((candidate.cut, score));
            }
            if fallback.is_none_or(|(_, fallback)| score > fallback) {
                fallback = Some((candidate.cut, score));
            }
        }
        let hard_cut = if samples - start < max_chunk + min_chunk {
            start + (samples - start) / 2
        } else {
            start + max_chunk
        };
        start = match best.or(fallback) {
            Some((cut, _)) => cut,
            None if min_speech > 0
                && samples - start <= WINDOW_SAMPLES
                && speech_within(segments, start + max_chunk..horizon) < min_speech =>
            {
                break;
            }
            None => hard_cut,
        };
        cuts.push(start);
    }
    cuts
}

/// Makes a fresh scorer for one clip.
pub type MakeScorer = Box<dyn Fn() -> Result<Box<dyn SpeechScorer>> + Send>;

/// Cuts audio into chunks at pauses as it arrives, and hands each back once
/// its cut is certain, so it can be decoded while the user is still
/// speaking. Pushed all at once, a clip is cut exactly as it is live: the
/// same scores and the same plan.
///
/// If the audio can't be scored (the VAD fails to load or to run), nothing
/// more is cut and the rest is one chunk: chunking only places cuts, so the
/// audio is still decoded, as it would be without chunking.
pub struct Chunker {
    make_scorer: MakeScorer,
    plan: ChunkPlan,
    /// Made the first time audio has to be scored, so a clip short enough to
    /// be one chunk never loads a VAD.
    scorer: Option<Box<dyn SpeechScorer>>,
    /// The scorer's frame size, once it is made.
    frame_samples: usize,
    /// Set when scoring fails: no more cuts.
    uncut: bool,
    /// Audio from `start` on; everything before it is already in a chunk.
    pending: Vec<f32>,
    /// One speech probability per whole frame from the beginning. Audio is
    /// only scored once a cut has to be planned, so a clip short enough to
    /// be one chunk is never scored.
    probs: Vec<f32>,
    start: usize,
    len: usize,
}

impl Chunker {
    /// `make_scorer` must make a fresh scorer: scores carry on from what it
    /// saw before.
    pub fn new(make_scorer: MakeScorer) -> Self {
        Self::with_plan(make_scorer, ChunkPlan::HANDY)
    }

    /// A chunker cutting to `plan` (WalkieTalkey: [`ChunkPlan::LIVE_DA`]).
    pub fn with_plan(make_scorer: MakeScorer, plan: ChunkPlan) -> Self {
        Self {
            make_scorer,
            plan,
            scorer: None,
            frame_samples: 0,
            uncut: false,
            pending: Vec::new(),
            probs: Vec::new(),
            start: 0,
            len: 0,
        }
    }

    /// Samples pushed so far, chunked or not. A caller checks this against
    /// the whole recording before trusting the chunks.
    pub fn samples(&self) -> usize {
        self.len
    }

    /// Adds audio. Returns the chunks whose cuts this made certain, in order.
    /// A whole clip pushed at once is moved in, not copied.
    pub fn push(&mut self, pcm: impl Into<Vec<f32>>) -> Vec<Vec<f32>> {
        let pcm = pcm.into();
        self.len += pcm.len();
        if self.pending.is_empty() {
            self.pending = pcm;
        } else {
            self.pending.extend_from_slice(&pcm);
        }
        if self.plan.split_at_pauses {
            return self.push_segments();
        }
        let ready = self.plan.max_chunk_samples + self.plan.lookahead_samples;
        if self.uncut || self.len - self.start <= ready {
            return Vec::new();
        }
        // Plan over whole frames only; a partial one waits for the rest.
        let scored = match self.score(false) {
            Ok(scored) => scored,
            Err(e) => {
                self.stop_cutting(e);
                return Vec::new();
            }
        };
        let segments = speech_segments(&self.probs, self.frame_samples, scored);
        // A pause still open at the end moves its midpoint as it grows: wait
        // for speech.
        if segments.last().map(|segment| segment.end) != Some(scored) {
            return Vec::new();
        }
        // One plan, committed while each cut's whole window plus the lookahead
        // is scored.
        let cuts = plan_cuts(
            &self.plan,
            &cut_candidates(&segments, scored),
            &segments,
            scored,
            self.start,
        );
        let mut chunks = Vec::new();
        for cut in cuts {
            if scored - self.start <= ready {
                break;
            }
            chunks.push(self.take_until(cut));
        }
        chunks
    }

    /// Cuts what is left and returns the remaining chunks, in order. Nothing
    /// more is pushed after.
    pub fn finish(&mut self) -> Vec<Vec<f32>> {
        let mut chunks = Vec::new();
        if self.plan.split_at_pauses {
            if !self.uncut && self.len - self.start > self.plan.min_chunk_samples {
                match self.score(true) {
                    Ok(_) => {
                        chunks.extend(self.cut_segments(self.len));
                        // What is left without a pause is cut at the maximum.
                        let segments = speech_segments(&self.probs, self.frame_samples, self.len);
                        let cuts = plan_cuts(
                            &self.plan,
                            &cut_candidates(&segments, self.len),
                            &segments,
                            self.len,
                            self.start,
                        );
                        for cut in cuts {
                            chunks.push(self.take_until(cut));
                        }
                    }
                    Err(e) => self.stop_cutting(e),
                }
            }
        } else if !self.uncut && self.len - self.start > self.plan.whole_rest_samples {
            match self.score(true) {
                Ok(_) => {
                    let segments = speech_segments(&self.probs, self.frame_samples, self.len);
                    let cuts = plan_cuts(
                        &self.plan,
                        &cut_candidates(&segments, self.len),
                        &segments,
                        self.len,
                        self.start,
                    );
                    for cut in cuts {
                        chunks.push(self.take_until(cut));
                    }
                }
                Err(e) => self.stop_cutting(e),
            }
        }
        if self.len > self.start {
            chunks.push(self.take_until(self.len));
        }
        chunks
    }

    /// [`ChunkPlan::split_at_pauses`]: the pieces whose pause speech has come
    /// back after, as soon as it has.
    fn push_segments(&mut self) -> Vec<Vec<f32>> {
        if self.uncut || self.len - self.start <= self.plan.min_chunk_samples {
            return Vec::new();
        }
        let scored = match self.score(false) {
            Ok(scored) => scored,
            Err(e) => {
                self.stop_cutting(e);
                return Vec::new();
            }
        };
        let mut chunks = self.cut_segments(scored);
        // A stretch without a usable pause: the long-form rule at the maximum.
        let ready = self.plan.max_chunk_samples + self.plan.lookahead_samples;
        if scored - self.start > ready {
            let segments = speech_segments(&self.probs, self.frame_samples, scored);
            let cuts = plan_cuts(
                &self.plan,
                &cut_candidates(&segments, scored),
                &segments,
                scored,
                self.start,
            );
            for cut in cuts {
                if scored - self.start <= ready {
                    break;
                }
                chunks.push(self.take_until(cut));
            }
        }
        chunks
    }

    /// Takes every piece that ends at a pause in the first `scored` samples.
    fn cut_segments(&mut self, scored: usize) -> Vec<Vec<f32>> {
        let segments = speech_segments(&self.probs, self.frame_samples, scored);
        pause_cuts(&segments, self.start, &self.plan)
            .into_iter()
            .map(|cut| self.take_until(cut))
            .collect()
    }

    /// How much speech the VAD found in `range` of the audio pushed so far,
    /// in samples. `None` where the audio is not scored: a clip too short to
    /// cut, or after the VAD failed.
    pub fn speech_samples(&self, range: Range<usize>) -> Option<usize> {
        if self.scorer.is_none() || self.uncut {
            return None;
        }
        let scored = (self.probs.len() * self.frame_samples).min(self.len);
        if range.end > scored {
            return None;
        }
        let segments = speech_segments(&self.probs, self.frame_samples, scored);
        Some(speech_within(&segments, range))
    }

    /// Scores every frame not yet scored, making the scorer first if this is
    /// the first time: whole frames only, or with `pad_last` the partial last
    /// frame too, zero padded. Returns how many samples are scored.
    fn score(&mut self, pad_last: bool) -> Result<usize> {
        if self.scorer.is_none() {
            // Nothing is cut before the first score, so a fresh scorer starts
            // at the first sample, as it must.
            debug_assert!(self.start == 0 && self.probs.is_empty());
            let scorer = (self.make_scorer)()?;
            self.frame_samples = scorer.frame_samples();
            assert!(self.frame_samples > 0, "VAD frame size must be non-zero");
            self.scorer = Some(scorer);
        }
        let scorer = self.scorer.as_mut().expect("the scorer was made above");
        let frame = self.frame_samples;
        let scored = self.probs.len() * frame;
        // Cuts only fall in scored audio, so its unscored rest is pending.
        let from = scored - self.start;
        let whole = (self.len - scored) / frame * frame;
        if whole > 0 {
            self.probs
                .extend(scorer.score(&self.pending[from..from + whole])?);
        }
        if pad_last && self.len > scored + whole {
            let mut tail = self.pending[from + whole..].to_vec();
            tail.resize(frame, 0.0);
            self.probs.extend(scorer.score(&tail)?);
            return Ok(self.len);
        }
        Ok(scored + whole)
    }

    /// Scoring failed: nothing more is cut, so the rest is one chunk.
    fn stop_cutting(&mut self, e: anyhow::Error) {
        warn!(
            "Voice activity detection failed at {:.1}s; decoding the rest in one piece: {:#}",
            seconds(self.len),
            e
        );
        self.uncut = true;
    }

    fn take_until(&mut self, cut: usize) -> Vec<f32> {
        if log::log_enabled!(log::Level::Debug) {
            let speech = self.speech_samples(self.start..cut).map_or_else(
                || "not scored".to_string(),
                |n| format!("{:.1}s", seconds(n)),
            );
            debug!(
                "Long-form chunk: {:.1}-{:.1}s (speech {})",
                seconds(self.start),
                seconds(cut),
                speech
            );
        }
        let chunk = self.pending.drain(..cut - self.start).collect();
        self.start = cut;
        chunk
    }
}

/// Scripts written without spaces between words, and CJK punctuation.
static UNSPACED: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"[\p{Han}\p{Hiragana}\p{Katakana}\p{Bopomofo}\p{Thai}\p{Lao}\p{Khmer}\p{Myanmar}\x{3000}-\x{303f}\x{ff00}-\x{ffef}]",
    )
    .unwrap()
});

fn is_unspaced(c: char) -> bool {
    UNSPACED.is_match(c.encode_utf8(&mut [0; 4]))
}

/// Chunk texts in order: a space between two chunks unless either side is
/// unspaced script.
pub fn join_transcripts<S: AsRef<str>>(texts: &[S]) -> String {
    let mut joined = String::new();
    let mut last: Option<char> = None;
    for text in texts {
        let text = text.as_ref().trim();
        let Some(first) = text.chars().next() else {
            continue;
        };
        if last.is_some_and(|last| !is_unspaced(last) && !is_unspaced(first)) {
            joined.push(' ');
        }
        joined.push_str(text);
        last = text.chars().last();
    }
    joined
}

fn seconds(samples: usize) -> f64 {
    samples as f64 / RATE as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_toolkit::vad::{VadFrame, VoiceActivityDetector};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const FRAME: usize = 512;

    fn s(seconds: f64) -> usize {
        (seconds * RATE as f64).round() as usize
    }

    /// Frame probabilities: speech everywhere except the given pauses, in seconds.
    fn probs_with_pauses(seconds: f64, pauses: &[(f64, f64)]) -> Vec<f32> {
        (0..s(seconds) / FRAME)
            .map(|i| {
                let at = (i * FRAME) as f64 / RATE as f64;
                if pauses.iter().any(|&(start, end)| at >= start && at < end) {
                    0.0
                } else {
                    1.0
                }
            })
            .collect()
    }

    /// Cut positions, in tenths of a second.
    fn plan(seconds: f64, pauses: &[(f64, f64)]) -> Vec<f64> {
        let samples = s(seconds);
        let segments = speech_segments(&probs_with_pauses(seconds, pauses), FRAME, samples);
        plan_cuts(
            &ChunkPlan::HANDY,
            &cut_candidates(&segments, samples),
            &segments,
            samples,
            0,
        )
        .into_iter()
        .map(|cut| (cut as f64 / RATE as f64 * 10.0).round() / 10.0)
        .collect()
    }

    fn lengths(chunks: &[Vec<f32>]) -> Vec<usize> {
        chunks.iter().map(Vec::len).collect()
    }

    /// Where chunks end, except the last, in tenths of a second.
    fn cuts(chunks: &[Vec<f32>]) -> Vec<f64> {
        let mut end = 0;
        chunks[..chunks.len().saturating_sub(1)]
            .iter()
            .map(|chunk| {
                end += chunk.len();
                (end as f64 / RATE as f64 * 10.0).round() / 10.0
            })
            .collect()
    }

    #[test]
    fn cuts_prefer_long_pauses_near_30s() {
        assert!(
            plan(40.0, &[(20.0, 21.0)]).is_empty(),
            "40 s or less is never cut"
        );
        // A 1 s pause at 28-29 s beats a short one right at 30 s; 41.5 s
        // remain, so cut again.
        assert_eq!(
            plan(70.0, &[(28.0, 29.0), (30.0, 30.2), (55.0, 56.0)]),
            vec![28.5, 55.5]
        );
        // Without any pause, cuts are hard 40 s ones.
        assert_eq!(plan(100.0, &[]), vec![40.0, 80.0]);
        // A pause under 5 s in is never used.
        assert_eq!(plan(60.0, &[(2.0, 3.0)]), vec![40.0]);
    }

    #[test]
    fn cuts_avoid_leaving_a_short_last_chunk() {
        // The pause at 38 s would leave 4 s, so the weaker one at 10 s wins.
        assert_eq!(plan(42.0, &[(9.8, 10.2), (37.5, 38.5)]), vec![10.0]);
        // Without a pause, a short rest is split evenly instead of cut at 40 s.
        assert_eq!(plan(84.0, &[]), vec![40.0, 62.0]);
        // A pause that leaves a short rest still beats cutting mid-speech.
        assert_eq!(plan(40.5, &[(38.8, 39.2)]), vec![39.0]);
    }

    fn segmenter() -> Chunker {
        let make = || {
            let scorer = ScriptedScorer {
                scored: Arc::new(AtomicUsize::new(0)),
                calls: 0,
                fail_on: None,
            };
            Ok(Box::new(scorer) as Box<dyn SpeechScorer>)
        };
        Chunker::with_plan(Box::new(make), ChunkPlan::LIVE_SEGMENTS_FINE)
    }

    #[test]
    fn segments_end_at_every_pause_once_they_are_a_second_long() {
        // Pauses at 2.0-2.4 s, 2.8-3.0 s (0.7 s after the first cut: that
        // fragment joins the next piece) and 6-6.5 s; the clip ends in speech.
        let pcm = clip(&probs_with_pauses(
            9.0,
            &[(2.0, 2.4), (2.8, 3.0), (6.0, 6.5)],
        ));
        let mut once = segmenter();
        let mut offline = once.push(&pcm[..]);
        offline.extend(once.finish());
        // The middles of the pauses (frames are 32 ms, so 6-6.5 s lands at 6.3).
        assert_eq!(cuts(&offline), vec![2.2, 6.3]);
        assert_eq!(offline.concat(), pcm, "every sample once, in order");

        // Live, each piece arrives once speech has come back after its pause,
        // well before the end: only the piece after 6.3 s is left at release.
        let mut live_chunker = segmenter();
        let mut live = Vec::new();
        let mut before_end = 0;
        for piece in pcm.chunks(FRAME * 3 + 7) {
            let ready = live_chunker.push(piece);
            before_end += ready.len();
            live.extend(ready);
        }
        assert_eq!(before_end, 2, "both pieces are ready while audio arrives");
        live.extend(live_chunker.finish());
        assert_eq!(lengths(&live), lengths(&offline));
    }

    #[test]
    fn a_pause_inside_a_sentence_does_not_end_a_segment() {
        // 0.3 s at 3 s (inside a sentence), 0.7 s at 6 s (between sentences).
        let pcm = clip(&probs_with_pauses(9.0, &[(3.0, 3.3), (6.0, 6.7)]));
        let make = || {
            let scorer = ScriptedScorer {
                scored: Arc::new(AtomicUsize::new(0)),
                calls: 0,
                fail_on: None,
            };
            Ok(Box::new(scorer) as Box<dyn SpeechScorer>)
        };
        let mut chunker = Chunker::with_plan(Box::new(make), ChunkPlan::LIVE_SEGMENTS);
        let mut chunks = chunker.push(&pcm[..]);
        chunks.extend(chunker.finish());
        assert_eq!(cuts(&chunks), vec![6.4]);
    }

    #[test]
    fn segments_cut_a_stretch_without_pauses_at_the_maximum() {
        let pcm = clip(&probs_with_pauses(45.0, &[]));
        let mut chunker = segmenter();
        let mut chunks = chunker.push(&pcm[..]);
        chunks.extend(chunker.finish());
        assert_eq!(cuts(&chunks), vec![18.0, 36.0]);
    }

    #[test]
    fn a_short_clip_is_one_segment() {
        let pcm = clip(&probs_with_pauses(0.8, &[(0.3, 0.5)]));
        let mut chunker = segmenter();
        let mut chunks = chunker.push(&pcm[..]);
        chunks.extend(chunker.finish());
        assert_eq!(chunks.len(), 1);
    }

    fn live_segments() -> Chunker {
        let make = || {
            Ok(Box::new(ScriptedScorer {
                scored: Arc::new(AtomicUsize::new(0)),
                calls: 0,
                fail_on: None,
            }) as Box<dyn SpeechScorer>)
        };
        Chunker::with_plan(Box::new(make), ChunkPlan::LIVE_SEGMENTS)
    }

    /// Cuts a clip pushed whole and the same clip fed live in 200 ms pieces;
    /// asserts they agree and returns the cuts and how many pieces were
    /// ready before the end.
    fn whole_and_live(pcm: &[f32]) -> (Vec<f64>, usize) {
        let mut once = live_segments();
        let mut whole = once.push(pcm);
        whole.extend(once.finish());
        assert_eq!(whole.concat(), pcm, "every sample once, in order");
        let mut chunker = live_segments();
        let mut live = feed_live(&mut chunker, pcm);
        let before_end = live.len();
        live.extend(chunker.finish());
        assert_eq!(lengths(&live), lengths(&whole), "live cuts as whole");
        (cuts(&whole), before_end)
    }

    #[test]
    fn a_noise_after_the_last_pause_joins_the_piece_before_it() {
        // Run 5 (DESK-46): a sentence, a pause, then a click or a breath the
        // VAD takes for 0.4 s of speech, then silence. Cut off on its own, the
        // noise came back from Edda as invented words ("Tester en to tre fire
        // fem seks syv otte."); with the sentence before it, it does not.
        let pcm = clip(&probs_with_pauses(7.5, &[(4.0, 6.0), (6.4, 7.5)]));
        let (cuts, before_end) = whole_and_live(&pcm);
        assert!(cuts.is_empty(), "one piece, got cuts at {cuts:?}");
        assert_eq!(before_end, 0);
    }

    #[test]
    fn a_noise_before_the_first_pause_joins_the_piece_after_it() {
        // Leading silence with a 0.3 s noise, a pause, then the dictation.
        let pcm = clip(&probs_with_pauses(8.0, &[(0.0, 1.0), (1.3, 2.5)]));
        let (cuts, _) = whole_and_live(&pcm);
        assert!(cuts.is_empty(), "one piece, got cuts at {cuts:?}");
    }

    #[test]
    fn a_short_last_phrase_is_decoded_with_the_sentence_before_it() {
        // "... og så videre. Tak.": 0.5 s of speech after the last pause is
        // too little to decode alone, so live the cut before it is never
        // made and the sentence waits for it. So is 1.2 s.
        for end in [6.3, 7.0] {
            let pcm = clip(&probs_with_pauses(end, &[(5.0, 5.8)]));
            let (cuts, before_end) = whole_and_live(&pcm);
            assert!(cuts.is_empty(), "one piece, got cuts at {cuts:?}");
            assert_eq!(before_end, 0);
        }
        // With 1.7 s of speech after the pause it is a piece of its own.
        let pcm = clip(&probs_with_pauses(7.5, &[(5.0, 5.8)]));
        let (cuts, before_end) = whole_and_live(&pcm);
        assert_eq!(cuts, vec![5.4]);
        assert_eq!(before_end, 1);
    }

    #[test]
    fn a_short_fragment_between_two_pauses_joins_the_next_piece() {
        // A 0.5 s "øh" between two pauses is not a piece of its own.
        let pcm = clip(&probs_with_pauses(10.0, &[(3.0, 3.8), (4.3, 5.0)]));
        let (cuts, _) = whole_and_live(&pcm);
        assert_eq!(cuts, vec![3.4]);
    }

    #[test]
    fn a_long_piece_is_not_cut_into_a_piece_without_speech() {
        // 17 s of speech, a pause, a 0.3 s noise, then silence to 25 s: past
        // the 18 s maximum, but the only pause to cut at would leave the
        // noise alone, so it is one piece (it still fits one window).
        let pcm = clip(&probs_with_pauses(25.0, &[(17.0, 17.6), (17.9, 25.0)]));
        let (cuts, before_end) = whole_and_live(&pcm);
        assert!(cuts.is_empty(), "one piece, got cuts at {cuts:?}");
        assert_eq!(before_end, 0);
    }

    #[test]
    fn a_stretch_longer_than_a_window_is_still_cut() {
        // 17 s of speech, then 15 s of silence: more than one Whisper window,
        // so it is cut at the maximum, and what is left has no speech.
        let pcm = clip(&probs_with_pauses(32.0, &[(17.0, 32.0)]));
        let (cuts, _) = whole_and_live(&pcm);
        assert_eq!(cuts, vec![18.0]);
        let mut chunker = live_segments();
        let mut chunks = chunker.push(&pcm[..]);
        chunks.extend(chunker.finish());
        assert_eq!(chunker.speech_samples(s(18.0)..pcm.len()), Some(0));
    }

    #[test]
    fn live_a_cut_waits_for_enough_speech_after_it() {
        let pcm = clip(&probs_with_pauses(9.0, &[(3.0, 3.6)]));
        let mut chunker = live_segments();
        let mut first_at = None;
        for (i, piece) in pcm.chunks(s(0.2)).enumerate() {
            if !chunker.push(piece).is_empty() && first_at.is_none() {
                first_at = Some((i + 1) as f64 * 0.2);
            }
        }
        // Speech is back at 3.6 s; the cut at 3.3 s is certain once 1.5 s of
        // it is scored.
        let at = first_at.expect("the first piece is ready before the end");
        assert!((5.1..=5.5).contains(&at), "ready at {at:.1}s");
    }

    #[test]
    fn the_chunker_reports_the_speech_in_each_piece() {
        let pcm = clip(&probs_with_pauses(9.0, &[(0.0, 1.0), (4.0, 5.0)]));
        let mut chunker = live_segments();
        let mut chunks = chunker.push(&pcm[..]);
        chunks.extend(chunker.finish());
        assert_eq!(cuts(&chunks), vec![4.5]);
        let speech = |range: Range<usize>| {
            chunker
                .speech_samples(range)
                .map(|n| n as f64 / RATE as f64)
        };
        // 1.0-4.0 s and 5.0-9.0 s, each with Silero's 30 ms pads.
        let first = speech(0..s(4.5)).unwrap();
        assert!((first - 3.06).abs() < 0.05, "{first:.2}");
        let second = speech(s(4.5)..pcm.len()).unwrap();
        assert!((second - 4.03).abs() < 0.05, "{second:.2}");
        // A clip too short to cut is never scored.
        let mut short = live_segments();
        let mut chunks = short.push(&pcm[..s(0.8)]);
        chunks.extend(short.finish());
        assert_eq!(short.speech_samples(0..s(0.8)), None);
    }

    #[test]
    fn joins_put_spaces_only_between_spaced_scripts() {
        assert_eq!(
            join_transcripts(&[" Hello there. ", "", "General Kenobi."]),
            "Hello there. General Kenobi."
        );
        assert_eq!(
            join_transcripts(&["今天天气很好。", "我们去公园吧。"]),
            "今天天气很好。我们去公园吧。"
        );
        assert_eq!(join_transcripts(&["I said", "你好"]), "I said你好");
        assert_eq!(
            join_transcripts(&["안녕하세요.", "반갑습니다."]),
            "안녕하세요. 반갑습니다."
        );
        // CJK Extension B, outside the Basic Multilingual Plane.
        assert_eq!(join_transcripts(&["你好𠀀", "我们"]), "你好𠀀我们");
    }

    /// Scores each frame with its first sample, so a test clip carries its
    /// own probabilities. Counts the frames it scores, and fails on the
    /// `fail_on`th call (from 0).
    struct ScriptedScorer {
        scored: Arc<AtomicUsize>,
        calls: usize,
        fail_on: Option<usize>,
    }

    impl VoiceActivityDetector for ScriptedScorer {
        fn push_frame<'a>(&'a mut self, _frame: &'a [f32]) -> Result<VadFrame<'a>> {
            unreachable!("chunking only scores")
        }

        fn frame_samples(&self) -> usize {
            FRAME
        }
    }

    impl SpeechScorer for ScriptedScorer {
        fn score(&mut self, frames: &[f32]) -> Result<Vec<f32>> {
            assert!(frames.len().is_multiple_of(FRAME), "whole frames only");
            self.calls += 1;
            if self.fail_on == Some(self.calls - 1) {
                anyhow::bail!("scripted VAD failure");
            }
            self.scored
                .fetch_add(frames.len() / FRAME, Ordering::Relaxed);
            Ok(frames.chunks(FRAME).map(|frame| frame[0]).collect())
        }
    }

    /// How many scorers a chunker made, and how many frames they scored.
    #[derive(Clone, Default)]
    struct Counts {
        made: Arc<AtomicUsize>,
        scored: Arc<AtomicUsize>,
    }

    fn scripted(fail_on: Option<usize>) -> (Chunker, Counts) {
        let counts = Counts::default();
        let make = {
            let counts = counts.clone();
            move || {
                counts.made.fetch_add(1, Ordering::Relaxed);
                let scorer = ScriptedScorer {
                    scored: Arc::clone(&counts.scored),
                    calls: 0,
                    fail_on,
                };
                Ok(Box::new(scorer) as Box<dyn SpeechScorer>)
            }
        };
        (Chunker::new(Box::new(make)), counts)
    }

    fn chunker() -> (Chunker, Counts) {
        scripted(None)
    }

    /// Audio whose every frame holds its own probability.
    fn clip(probs: &[f32]) -> Vec<f32> {
        probs.iter().flat_map(|&p| [p; FRAME]).collect()
    }

    /// 100 s of audio, with pauses at 29-30 s and 58-59 s.
    fn long_clip() -> Vec<f32> {
        clip(&probs_with_pauses(100.0, &[(29.0, 30.0), (58.0, 59.0)]))
    }

    #[test]
    fn live_chunks_arrive_before_the_end_at_the_same_cuts() {
        // A partial last frame, scored padded.
        let mut pcm = long_clip();
        pcm.extend([1.0; 100]);
        let (mut once, _) = chunker();
        let mut offline = once.push(&pcm[..]);
        offline.extend(once.finish());
        // The pauses' midpoints, then the 41.5 s left split evenly.
        assert_eq!(cuts(&offline), vec![29.5, 58.5, 79.3]);

        // Pieces that split frames, as the recorder's do.
        let (mut chunker, counts) = chunker();
        let mut live = Vec::new();
        for piece in pcm.chunks(FRAME * 3 + 7) {
            live.extend(chunker.push(piece));
        }
        // A cut is made whenever more than 45 s is waiting: 2 of the 4 chunks
        // before the end.
        assert_eq!(live.len(), 2, "chunks are ready while audio still arrives");
        live.extend(chunker.finish());
        assert_eq!(lengths(&live), lengths(&offline));
        assert_eq!(live.concat(), pcm, "every sample once, in order");

        // One stateful scorer for the clip, scoring each frame once.
        assert_eq!(counts.made.load(Ordering::Relaxed), 1);
        assert_eq!(
            counts.scored.load(Ordering::Relaxed),
            pcm.len().div_ceil(FRAME)
        );
    }

    #[test]
    fn live_cuts_wait_for_a_pause_to_end() {
        // At 45 s the pause so far is 34-45 s, a cut at 39.5 s; the whole
        // pause's midpoint, 42 s, is out of reach, so the plan cuts at 40 s.
        let pcm = clip(&probs_with_pauses(90.0, &[(34.0, 50.0)]));
        let planned = vec![s(40.0), s(40.0), pcm.len() - s(80.0)];

        let (mut chunker, _) = chunker();
        let mut live = Vec::new();
        for piece in pcm.chunks(16 * FRAME) {
            live.extend(chunker.push(piece));
        }
        live.extend(chunker.finish());
        assert_eq!(lengths(&live), planned);
    }

    #[test]
    fn audio_that_is_one_chunk_never_loads_a_vad() {
        let probs = probs_with_pauses(40.0, &[(20.0, 21.0)]);
        let pcm = clip(&probs);
        let (mut chunker, counts) = chunker();
        for frame in pcm.chunks(FRAME) {
            assert!(chunker.push(frame).is_empty());
        }
        assert_eq!(lengths(&chunker.finish()), vec![pcm.len()]);
        assert_eq!(counts.made.load(Ordering::Relaxed), 0);
    }

    /// A chunker with WalkieTalkey's live plan (DESK-46).
    fn live_da_chunker() -> Chunker {
        let make = || {
            Ok(Box::new(ScriptedScorer {
                scored: Arc::new(AtomicUsize::new(0)),
                calls: 0,
                fail_on: None,
            }) as Box<dyn SpeechScorer>)
        };
        Chunker::with_plan(Box::new(make), ChunkPlan::LIVE_DA)
    }

    /// Speech with a short pause every `every` seconds, like dictation.
    fn dictation(seconds: f64, every: f64) -> Vec<f32> {
        let pauses: Vec<(f64, f64)> = (1..)
            .map(|i| i as f64 * every)
            .take_while(|&at| at + 0.6 < seconds)
            .map(|at| (at, at + 0.6))
            .collect();
        clip(&probs_with_pauses(seconds, &pauses))
    }

    /// Feeds `pcm` as the phone and the recorder do, in 200 ms pieces.
    fn feed_live(chunker: &mut Chunker, pcm: &[f32]) -> Vec<Vec<f32>> {
        let mut chunks = Vec::new();
        for piece in pcm.chunks(s(0.2)) {
            chunks.extend(chunker.push(piece));
        }
        chunks
    }

    #[test]
    fn live_da_plan_cuts_two_minutes_into_10_to_20_second_chunks() {
        let pcm = dictation(120.0, 7.0);
        let mut chunker = live_da_chunker();
        let live = feed_live(&mut chunker, &pcm);
        assert!(
            live.len() >= 5,
            "most of 2 min is decoded while talking, got {}",
            live.len()
        );
        for chunk in &live {
            let secs = chunk.len() as f64 / RATE as f64;
            assert!((10.0..=18.0).contains(&secs), "chunk of {secs:.1}s");
        }
        let rest = chunker.finish();
        assert_eq!(rest.len(), 1, "one piece is left at release");
        let mut all = live;
        all.extend(rest);
        assert_eq!(all.concat(), pcm, "every sample once, in order");
    }

    #[test]
    fn live_da_plan_leaves_one_short_rest_whatever_the_length() {
        for seconds in [15.0, 24.0, 37.0, 60.0, 120.0, 183.0, 300.0] {
            for every in [3.0, 5.5, 8.0] {
                let pcm = dictation(seconds, every);
                let mut chunker = live_da_chunker();
                feed_live(&mut chunker, &pcm);
                let rest = chunker.finish();
                assert_eq!(rest.len(), 1, "{seconds}s with pauses every {every}s");
                let rest_secs = rest[0].len() as f64 / RATE as f64;
                assert!(
                    rest_secs <= 20.0,
                    "{seconds}s with pauses every {every}s left {rest_secs:.1}s"
                );
            }
        }
    }

    #[test]
    fn live_da_plan_keeps_a_short_dictation_whole() {
        let pcm = dictation(15.0, 6.0);
        let mut chunker = live_da_chunker();
        assert!(feed_live(&mut chunker, &pcm).is_empty());
        assert_eq!(lengths(&chunker.finish()), vec![pcm.len()]);
    }

    #[test]
    fn handy_plan_is_the_default() {
        assert_eq!(ChunkPlan::default(), ChunkPlan::HANDY);
        assert_eq!(ChunkPlan::HANDY.max_chunk_samples, 40 * RATE);
    }

    #[test]
    fn a_vad_failure_leaves_the_rest_in_one_piece() {
        // The VAD fails on its second score, after the first chunk is out.
        let pcm = long_clip();
        let (mut chunker, _) = scripted(Some(1));
        let mut chunks = Vec::new();
        for frame in pcm.chunks(FRAME) {
            chunks.extend(chunker.push(frame));
        }
        assert_eq!(chunks.len(), 1);
        chunks.extend(chunker.finish());
        assert_eq!(cuts(&chunks), vec![29.5]);
        assert_eq!(chunks.concat(), pcm, "no audio lost");
    }
}
