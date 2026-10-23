//! WalkieTalkey's Danish models (DESK-30, DESK-35), an overlay on Handy's
//! catalog: `catalog.json` here has the same schema as Handy's synced copy and
//! is merged in front of it, so Handy's file stays a verbatim copy of its
//! package. The description is user-facing Danish. TODO(copy): Edda's
//! description in catalog.json.

/// The overlay catalog, compiled in.
pub const CATALOG_JSON: &str = include_str!("catalog.json");

/// Edda's catalog id (the key for ranking and results).
pub const EDDA_CATALOG_ID: &str = "edda-v0.2";

/// The default speech model (DESK-30), as the app ids catalog models:
/// `{repository}/{default file}`.
pub const DEFAULT_MODEL_ID: &str = "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf";

/// WalkieTalkey's list order and onboarding set, ahead of Handy's ranking:
/// `(catalog id, rank, recommended)`.
pub const RANKING: &[(&str, u32, bool)] = &[(EDDA_CATALOG_ID, 0, true)];

pub fn ranking(id: &str) -> Option<&'static (&'static str, u32, bool)> {
    RANKING.iter().find(|(model, _, _)| *model == id)
}

/// Models decoded one speech segment at a time (docs/MODELS.md, "Edda and
/// pauses"): Edda, decoded greedily, stops at the first pause of a window
/// that holds more than one sentence. Whisper turbo gets worse that way, so
/// it keeps its longer chunks.
pub fn decodes_by_segment(model_id: &str) -> bool {
    model_id.starts_with("walkietalkey/edda-")
}

#[cfg(test)]
mod segment_tests {
    use super::*;

    #[test]
    fn only_edda_is_decoded_by_segment() {
        assert!(decodes_by_segment(DEFAULT_MODEL_ID));
        assert!(!decodes_by_segment(
            "handy-computer/whisper-large-v3-turbo-gguf/whisper-large-v3-turbo-Q8_0.gguf"
        ));
        assert!(!decodes_by_segment(
            "walkietalkey/ekko-v1-tiny-gguf/ekko-v1-tiny-Q8_0.gguf"
        ));
    }
}
