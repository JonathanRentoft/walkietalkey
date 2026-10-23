//! Long-form chunked decoding, shared by a live recording and a batch clip:
//! both cut the same audio at the same pauses and decode it the same way.

use std::time::Instant;

use log::{debug, info};
use transcribe_cpp::{RunOptions, Transcript};

use super::TranscriptionManager;
use crate::audio_toolkit::chunking::{ChunkPlan, Chunker};
use crate::engine_supervisor::{CancelMark, EngineError};
use crate::managers::audio::create_detector;
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
    on_chunk: Option<ChunkObserver>,
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
        Self {
            tm,
            mark,
            run_options,
            model_id: model_id.to_string(),
            chunker: Chunker::with_plan(
                Box::new(move || create_detector(backend, &app_handle)),
                plan,
            ),
            context_prompts,
            on_chunk,
            transcripts: Vec::new(),
            failure: None,
        }
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
            let started = Instant::now();
            let mut run_options = self.run_options.clone();
            if self.context_prompts {
                run_options.prompt = crate::pipeline::da::context::chunk_prompt(
                    self.transcripts.last().map(|t| t.text.as_str()),
                    self.run_options.language.as_deref(),
                );
            }
            match self
                .tm
                .run_batch(self.mark, chunk, &run_options, &self.model_id)
            {
                Ok(transcript) => {
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
}
