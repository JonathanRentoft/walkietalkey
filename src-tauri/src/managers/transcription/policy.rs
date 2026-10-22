//! How audio is decoded: the one place the model's traits and the settings
//! choose between streaming, long-form chunking and a single run.

use crate::engine_supervisor::LoadedInfo;

/// What a model can do that decides how its audio is decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelTraits {
    /// Decodes audio incrementally as it is recorded.
    pub streaming: bool,
    /// Keeps its accuracy on audio longer than its native window in one run
    /// (whisper today).
    pub long_form: bool,
}

impl ModelTraits {
    /// The loaded model's own traits: the authority once a model is loaded.
    pub fn of(info: &LoadedInfo) -> Self {
        Self {
            streaming: info.capabilities.supports_streaming,
            long_form: info.supports_long_form,
        }
    }
}

/// How a recording is decoded while it is still going.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveDecode {
    /// The model decodes the audio as it arrives.
    Stream,
    /// Long audio is cut at pauses and each chunk decoded once its cut is
    /// certain.
    Chunked,
    /// Nothing until the recording stops; then it is decoded in batch.
    None,
}

/// How a whole clip is decoded: a recording without a live result, a
/// re-transcribed history entry, or a file from the CLI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchDecode {
    /// Cut at pauses into chunks of about 30 s, each decoded in turn; a clip
    /// of 40 s or less is one chunk.
    Chunked,
    /// One run.
    Whole,
}

/// Streaming wins: a streaming model handles long audio itself. Otherwise
/// the recording is chunked while it goes.
///
/// WalkieTalkey (DESK-46): long-form models (Whisper, so Edda) are chunked
/// live too. Their own long-form decode only starts at release and takes the
/// whole recording's time then; chunking while the user talks leaves only the
/// last short chunk for after release, whatever the length.
pub fn live_decode(model: ModelTraits, long_form_chunking: bool) -> LiveDecode {
    if model.streaming {
        LiveDecode::Stream
    } else if long_form_chunking {
        LiveDecode::Chunked
    } else {
        LiveDecode::None
    }
}

/// As live, except that a streaming model takes a whole clip in one run, as
/// it did before long-form chunking existed.
pub fn batch_decode(model: ModelTraits, long_form_chunking: bool) -> BatchDecode {
    if long_form_chunking && !model.long_form && !model.streaming {
        BatchDecode::Chunked
    } else {
        BatchDecode::Whole
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHISPER: ModelTraits = ModelTraits {
        streaming: false,
        long_form: true,
    };
    const PARAKEET_BATCH: ModelTraits = ModelTraits {
        streaming: false,
        long_form: false,
    };
    const STREAMING: ModelTraits = ModelTraits {
        streaming: true,
        long_form: false,
    };

    #[test]
    fn whisper_is_chunked_while_talking() {
        // DESK-46: Edda (Whisper) decodes chunk by chunk during the recording.
        assert_eq!(live_decode(WHISPER, true), LiveDecode::Chunked);
        assert_eq!(live_decode(PARAKEET_BATCH, true), LiveDecode::Chunked);
    }

    #[test]
    fn streaming_models_stream_and_chunking_can_be_turned_off() {
        assert_eq!(live_decode(STREAMING, true), LiveDecode::Stream);
        assert_eq!(live_decode(WHISPER, false), LiveDecode::None);
    }

    #[test]
    fn batch_keeps_handys_rules() {
        assert_eq!(batch_decode(WHISPER, true), BatchDecode::Whole);
        assert_eq!(batch_decode(PARAKEET_BATCH, true), BatchDecode::Chunked);
    }
}
