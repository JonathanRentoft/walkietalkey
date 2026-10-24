//! Long-form chunked decoding, shared by a live recording and a batch clip:
//! both cut the same audio at the same pauses and decode it the same way.

use std::time::Instant;

use log::{debug, info};
use transcribe_cpp::{RunOptions, Transcript};

use super::TranscriptionManager;
use crate::audio_toolkit::chunking::{ChunkPlan, Chunker};
use crate::engine_supervisor::{CancelMark, EngineError};
use crate::managers::audio::create_detector;
use crate::pipeline::da::script::has_stray_characters;
use crate::settings::VadBackend;

/// WalkieTalkey (DESK-47): told each chunk's text as soon as it is decoded,
/// so AI cleanup can run while the user is still talking.
pub(crate) type ChunkObserver = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

/// Cuts audio at pauses as it arrives and decodes each chunk once its cut is
/// certain, so a recording has only its last chunk left when it stops.
pub(super) struct ChunkedDecode<'a> {
    tm: &'a TranscriptionManager,
    /// Every chunk's run stops with one cancel.
    mark: CancelMark,
    run_options: RunOptions,
    model_id: String,
    chunker: Chunker,
    /// Each chunk gets the end of the previous chunk's text as its context
    /// prompt (DESK-46), when the model takes one.
    context_prompts: bool,
    /// WalkieTalkey (Edda): a chunk whose text is cut short is decoded again
    /// piece by piece, see [`looks_cut_short`].
    resplit_cut_short: bool,
    backend: VadBackend,
    on_chunk: Option<ChunkObserver>,
    /// WalkieTalkey (run 4): reads each joint again with both sides in view
    /// (Danish runs, `pipeline::da::joints`), as soon as the chunk after it
    /// is decoded, so the wait after the recording stays the same.
    joint_judge: Option<crate::walkietalkey::punctuation::PncJointJudge>,
    /// Where the next chunk starts in the recording, in samples.
    offset: usize,
    transcripts: Vec<Transcript>,
    /// The first run that failed or was cancelled; nothing more is decoded
    /// after it.
    failure: Option<EngineError>,
}

impl<'a> ChunkedDecode<'a> {
    pub(super) fn new(
        tm: &'a TranscriptionManager,
        mark: CancelMark,
        run_options: RunOptions,
        model_id: &str,
        backend: VadBackend,
        plan: ChunkPlan,
        context_prompts: bool,
        on_chunk: Option<ChunkObserver>,
    ) -> Self {
        // The VAD is only loaded if the audio turns out long enough to cut.
        let app_handle = tm.app_handle.clone();
        let joint_judge = (run_options.language.as_deref() == Some("da"))
            .then(|| crate::walkietalkey::punctuation::joint_judge(&tm.app_handle))
            .flatten();
        let edda = crate::walkietalkey::catalog::decodes_by_segment(model_id);
        Self {
            tm,
            mark,
            run_options: if edda {
                with_fixed_seed(run_options)
            } else {
                run_options
            },
            model_id: model_id.to_string(),
            chunker: Chunker::with_plan(
                Box::new(move || create_detector(backend, &app_handle)),
                plan,
            ),
            context_prompts,
            resplit_cut_short: edda,
            backend,
            on_chunk,
            joint_judge,
            offset: 0,
            transcripts: Vec::new(),
            failure: None,
        }
    }

    /// A whole clip's chunks under `plan`, decoded in order (WalkieTalkey:
    /// Edda's segments, with context prompts).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn decode_clip_with(
        tm: &'a TranscriptionManager,
        mark: CancelMark,
        run_options: RunOptions,
        audio: Vec<f32>,
        model_id: &str,
        backend: VadBackend,
        plan: ChunkPlan,
        context_prompts: bool,
    ) -> Result<Vec<Transcript>, EngineError> {
        let mut decode = Self::new(
            tm,
            mark,
            run_options,
            model_id,
            backend,
            plan,
            context_prompts,
            None,
        );
        decode.push(audio);
        decode.finish()
    }

    /// A whole clip's chunks, decoded in order.
    pub(super) fn decode_clip(
        tm: &'a TranscriptionManager,
        mark: CancelMark,
        run_options: RunOptions,
        audio: Vec<f32>,
        model_id: &str,
        backend: VadBackend,
    ) -> Result<Vec<Transcript>, EngineError> {
        // A whole clip keeps Handy's plan: it has no talking time to hide in.
        let mut decode = Self::new(
            tm,
            mark,
            run_options,
            model_id,
            backend,
            ChunkPlan::HANDY,
            false,
            None,
        );
        decode.push(audio);
        decode.finish()
    }

    /// Samples pushed so far.
    pub(super) fn samples(&self) -> usize {
        self.chunker.samples()
    }

    /// Chunks decoded so far.
    pub(super) fn decoded(&self) -> usize {
        self.transcripts.len()
    }

    /// Whether a failure already ended the decode; [`finish`](Self::finish)
    /// reports it.
    pub(super) fn failed(&self) -> bool {
        self.failure.is_some()
    }

    /// Adds audio, decoding each chunk it makes certain.
    pub(super) fn push(&mut self, pcm: Vec<f32>) {
        if self.failure.is_some() {
            return;
        }
        let chunks = self.chunker.push(pcm);
        self.decode(chunks);
    }

    /// Decodes what is left. Every chunk's transcript in order, or the run
    /// that failed or was cancelled.
    pub(super) fn finish(mut self) -> Result<Vec<Transcript>, EngineError> {
        if self.failure.is_none() {
            let planned = Instant::now();
            let chunks = self.chunker.finish();
            debug!(
                "Recording stopped: {} chunk(s) left ({:.1}s), planned in {:.0} ms",
                chunks.len(),
                chunks.iter().map(Vec::len).sum::<usize>() as f64 / 16_000.0,
                planned.elapsed().as_secs_f64() * 1000.0
            );
            self.decode(chunks);
        }
        if let Some(failure) = self.failure {
            return Err(failure);
        }
        if self.transcripts.len() > 1 {
            info!(
                "Decoded {:.1}s of audio in {} chunks",
                self.samples() as f64 / 16_000.0,
                self.transcripts.len()
            );
        }
        Ok(self.transcripts)
    }

    fn decode(&mut self, chunks: Vec<Vec<f32>>) {
        for chunk in chunks {
            if self.failure.is_some() {
                return;
            }
            let audio_secs = chunk.len() as f64 / 16_000.0;
            let range = self.offset..self.offset + chunk.len();
            self.offset = range.end;
            let speech = self.chunker.speech_samples(range.clone());
            if !has_speech(speech, self.chunker.speech_samples(0..range.end)) {
                info!(
                    "A chunk of {:.1}s has no speech; not decoding it",
                    audio_secs
                );
                continue;
            }
            let speech_secs = speech.map(|n| n as f64 / 16_000.0);
            let started = Instant::now();
            let mut run_options = self.run_options.clone();
            if self.context_prompts {
                run_options.prompt = crate::pipeline::da::context::chunk_prompt(
                    self.transcripts.last().map(|t| t.text.as_str()),
                    self.run_options.language.as_deref(),
                );
            }
            let kept = self.resplit_cut_short.then(|| chunk.clone());
            match self.run_guarded(chunk, &run_options) {
                Ok(transcript) => {
                    let mut transcript = match kept {
                        Some(audio) if looks_cut_short(&transcript.text, speech_secs) => {
                            match self.decode_in_pieces(audio, transcript) {
                                Ok(transcript) => transcript,
                                Err(e) => {
                                    info!("Chunk decoding stopped: {}", e);
                                    self.failure = Some(e);
                                    return;
                                }
                            }
                        }
                        _ => transcript,
                    };
                    if let (Some(judge), Some(previous)) =
                        (&self.joint_judge, self.transcripts.last_mut())
                    {
                        let (before, after) = crate::pipeline::da::joints::repair(
                            &previous.text,
                            &transcript.text,
                            judge,
                        );
                        previous.text = before;
                        transcript.text = after;
                    }
                    if let Some(on_chunk) = &self.on_chunk {
                        on_chunk(&transcript.text);
                    }
                    self.transcripts.push(transcript);
                    // Real-time factor: audio seconds decoded per second of
                    // wall clock. Floored so a near-instant decode reports a
                    // large factor instead of infinity.
                    let elapsed_secs = started.elapsed().as_secs_f64().max(1e-6);
                    info!(
                        "Decoded long-form chunk {} ({:.1}s of audio) in {:.2}s ({:.0}x real time)",
                        self.transcripts.len(),
                        audio_secs,
                        elapsed_secs,
                        audio_secs / elapsed_secs
                    );
                }
                Err(e) => {
                    info!("Chunk decoding stopped: {}", e);
                    self.failure = Some(e);
                }
            }
        }
    }

    /// WalkieTalkey (run 2, Phase 2): one run of `audio`. A Danish run with a
    /// vocabulary prompt that comes back with letters from another script, or
    /// with broken characters (run 4), is decoded again without the
    /// vocabulary: on code-switched speech the "Glossary:" prompt can tip Edda
    /// into such fragments, the plain run does not (`pipeline::da::script`).
    fn run_guarded(
        &self,
        audio: Vec<f32>,
        run_options: &RunOptions,
    ) -> Result<Transcript, EngineError> {
        let retry = needs_script_guard(run_options).then(|| audio.clone());
        let transcript = self
            .tm
            .run_batch(self.mark, audio, run_options, &self.model_id)?;
        match retry {
            Some(audio) if has_stray_characters(&transcript.text) => {
                let mut plain = run_options.clone();
                plain.vocabulary.clear();
                info!(
                    "A chunk came back with letters from another script or broken characters; decoding it again without the vocabulary"
                );
                self.tm.run_batch(self.mark, audio, &plain, &self.model_id)
            }
            _ => Ok(transcript),
        }
    }

    /// WalkieTalkey: decodes a chunk again one speech segment at a time (cut at
    /// its pauses, [`ChunkPlan::LIVE_SEGMENTS_FINE`]), each with the text
    /// before it as context, and keeps that only if it says clearly more than
    /// `whole`.
    fn decode_in_pieces(
        &self,
        audio: Vec<f32>,
        whole: Transcript,
    ) -> Result<Transcript, EngineError> {
        let app_handle = self.tm.app_handle.clone();
        let backend = self.backend;
        let mut chunker = Chunker::with_plan(
            Box::new(move || create_detector(backend, &app_handle)),
            ChunkPlan::LIVE_SEGMENTS_FINE,
        );
        let mut pieces = chunker.push(audio);
        pieces.extend(chunker.finish());
        if pieces.len() < 2 {
            return Ok(whole);
        }
        let started = Instant::now();
        let count = pieces.len();
        let mut texts: Vec<String> = Vec::new();
        let mut previous = self.transcripts.last().map(|t| t.text.clone());
        let mut at = 0;
        for piece in pieces {
            let piece_range = at..at + piece.len();
            at = piece_range.end;
            let piece_speech = chunker.speech_samples(piece_range.clone());
            if !has_speech(piece_speech, chunker.speech_samples(0..piece_range.end)) {
                continue;
            }
            let mut run_options = self.run_options.clone();
            if self.context_prompts {
                run_options.prompt = crate::pipeline::da::context::chunk_prompt(
                    previous.as_deref(),
                    self.run_options.language.as_deref(),
                );
            }
            let transcript = self.run_guarded(piece, &run_options)?;
            previous = Some(transcript.text.clone());
            texts.push(transcript.text);
        }
        let joined = crate::pipeline::da::joints::join(
            &texts,
            self.joint_judge
                .as_ref()
                .map(|j| j as &dyn crate::pipeline::da::joints::JointJudge),
        );
        let (whole_words, piece_words) = (word_count(&whole.text), word_count(&joined));
        let better = piece_words_win(whole_words, piece_words);
        info!(
            "A chunk looked cut short ({} words); in {} pieces it has {} ({:.2}s): {}",
            whole_words,
            count,
            piece_words,
            started.elapsed().as_secs_f64(),
            if better {
                "using the pieces"
            } else {
                "keeping the whole"
            }
        );
        Ok(if better {
            Transcript {
                text: joined,
                raw_text: String::new(),
                segments: Vec::new(),
                words: Vec::new(),
                tokens: Vec::new(),
                ..whole
            }
        } else {
            whole
        })
    }
}

/// Whether a run's text is checked for letters from other scripts: Danish
/// runs that carry a vocabulary prompt.
fn needs_script_guard(run_options: &RunOptions) -> bool {
    run_options.language.as_deref() == Some("da") && !run_options.vocabulary.is_empty()
}

fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

/// Run 5: whether a chunk is decoded at all. Edda has no notion of "no
/// speech" (its no-speech probability is 0 on silence and noise), so a chunk
/// in which the VAD found no speech at all comes back with invented words.
/// The VAD's word is only taken when it heard speech elsewhere in the
/// recording (`heard`, speech up to the end of this chunk): a quiet speaker
/// the VAD misses altogether is still decoded. A chunk that was never scored
/// (a clip too short to cut) is decoded.
fn has_speech(speech_samples: Option<usize>, heard: Option<usize>) -> bool {
    !(speech_samples == Some(0) && heard.is_some_and(|n| n > 0))
}

/// The sampling seed for Edda's pieces; 0 would be the library's random one.
const DECODE_SEED: u32 = 1;

/// Run 5: `run_options` with a fixed sampling seed, so the same audio always
/// gives the same text. Where greedy decoding is unsure (average
/// log-probability under -1, as on a piece without speech), transcribe.cpp
/// falls back to sampling at rising temperatures and keeps the last try; with
/// its default seed the same piece came back as different invented words on
/// every run. The rest of the library's decoding recipe stays: without the
/// fallback, Edda writes fluent sentences into such pieces instead.
fn with_fixed_seed(mut run_options: RunOptions) -> RunOptions {
    run_options.family = Some(transcribe_cpp::RunExtension::Whisper(
        transcribe_cpp::WhisperRunOptions {
            seed: Some(DECODE_SEED),
            ..Default::default()
        },
    ));
    run_options
}

/// Letters per second of speech below which a piece looks cut short.
const CUT_SHORT_LETTERS_PER_SPEECH_SECOND: f64 = 9.0;

/// Edda, decoded greedily, may stop at the first pause of a window that holds
/// more than one sentence (docs/MODELS.md, "Edda and pauses"). Its text is
/// then far shorter than the speech: fewer than 9 letters per second of
/// speech the VAD found in a piece with more than 4 s of it. Run 5: Danish
/// pieces come out at a median of 14 letters per second of speech (1st
/// percentile 9, on 600 FLEURS pieces). Run 4 counted words per second of
/// the whole piece, silence included, which took a sentence with a pause
/// around it for a cut-short one and decoded it again in short pieces that
/// invented words.
fn looks_cut_short(text: &str, speech_secs: Option<f64>) -> bool {
    let letters = text.chars().filter(|c| c.is_alphanumeric()).count() as f64;
    speech_secs.is_some_and(|speech| {
        speech > 4.0 && letters < CUT_SHORT_LETTERS_PER_SPEECH_SECOND * speech
    })
}

/// The pieces replace the whole only when they say clearly more: a chunk that
/// was not cut short (a slow speaker) keeps its one-window text.
fn piece_words_win(whole_words: usize, piece_words: usize) -> bool {
    piece_words as f64 >= 1.25 * whole_words as f64 && piece_words > whole_words
}

#[cfg(test)]
mod cut_short_tests {
    use super::*;

    #[test]
    fn only_danish_runs_with_a_vocabulary_are_guarded() {
        let mut run = RunOptions {
            language: Some("da".into()),
            vocabulary: vec!["deploy".into(), "staging".into()],
            ..Default::default()
        };
        assert!(needs_script_guard(&run));
        run.vocabulary.clear();
        assert!(
            !needs_script_guard(&run),
            "nothing to drop without a vocabulary"
        );
        run.vocabulary = vec!["deploy".into()];
        run.language = Some("en".into());
        assert!(
            !needs_script_guard(&run),
            "other languages keep their scripts"
        );
        run.language = None;
        assert!(!needs_script_guard(&run));
    }

    #[test]
    fn short_text_for_the_speech_is_cut_short() {
        // 17 of about 60 words on a 30 s window with 25 s of speech (the M0
        // finding): about 3 letters per second of speech.
        let seventeen = vec!["sætning"; 17].join(" ");
        assert!(looks_cut_short(&seventeen, Some(25.0)));
        // Run 5: a sentence with silence around it is not cut short. Run 4's
        // rule (words per second of the whole 13.7 s piece) took this FLEURS
        // clip for one and decoded it again in pieces, which invented words.
        let sentence = "Sondarbans er blevet tilføjet til UNESCOs verdensarvsliste, den del \
                        af skoven, der indenfor indisk territorium kaldes Sondarbans National Park.";
        assert!(!looks_cut_short(sentence, Some(9.8)));
        // Little speech is never judged, nor a piece the VAD did not score.
        assert!(!looks_cut_short("hej", Some(3.5)));
        assert!(!looks_cut_short("hej", None));
    }

    #[test]
    fn edda_decodes_with_a_fixed_sampling_seed() {
        let run = with_fixed_seed(RunOptions {
            language: Some("da".into()),
            ..Default::default()
        });
        let Some(transcribe_cpp::RunExtension::Whisper(whisper)) = &run.family else {
            panic!("a Whisper run extension, got {:?}", run.family);
        };
        assert_eq!(whisper.seed, Some(DECODE_SEED));
        assert_ne!(DECODE_SEED, 0, "0 is the library's random seed");
        // Everything else stays the library's decoding recipe.
        assert_eq!(
            transcribe_cpp::WhisperRunOptions {
                seed: None,
                ..whisper.clone()
            },
            transcribe_cpp::WhisperRunOptions::default()
        );
        assert_eq!(run.language.as_deref(), Some("da"));
    }

    #[test]
    fn chunks_without_speech_are_not_decoded() {
        assert!(!has_speech(Some(0), Some(16_000)));
        assert!(has_speech(Some(1), Some(16_000)));
        assert!(
            has_speech(Some(0), Some(0)),
            "a recording the VAD hears nothing in is decoded"
        );
        assert!(
            has_speech(None, None),
            "a clip too short to score is decoded"
        );
    }

    #[test]
    fn pieces_win_only_when_they_say_clearly_more() {
        assert!(piece_words_win(17, 58));
        assert!(!piece_words_win(20, 22), "a slow speaker keeps the whole");
        assert!(!piece_words_win(0, 0));
        assert!(piece_words_win(0, 3));
    }
}
