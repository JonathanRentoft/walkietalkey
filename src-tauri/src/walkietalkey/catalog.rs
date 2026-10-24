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

/// Spec 11 and principle 3: everything WalkieTalkey offers may be used by
/// anyone, companies included, so models under a non-commercial licence
/// (Handy's catalog has Canary and a Granite model) are not offered.
pub fn non_commercial(license: &str) -> bool {
    let license = license.to_ascii_lowercase();
    license.contains("-nc")
        || license.contains("noncommercial")
        || license.contains("non-commercial")
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
    fn the_catalog_overlay_ships_the_manifests_hashes() {
        // Spec: the SHA-256 from models/manifest.json ships inside the app.
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../models/manifest.json")).unwrap();
        let overlay: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        for model in overlay["models"].as_array().unwrap() {
            for file in model["files"].as_object().unwrap().values() {
                let name = file["filename"].as_str().unwrap();
                let listed = manifest["models"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|m| m["files"].as_array().unwrap())
                    .find(|f| f["name"] == name)
                    .unwrap_or_else(|| panic!("{name} is in models/manifest.json"));
                assert_eq!(listed["sha256"], file["sha256"], "{name}");
                assert_eq!(listed["size"], file["size"], "{name}");
            }
        }
    }

    #[test]
    fn non_commercial_models_are_not_offered() {
        assert!(non_commercial("cc-by-nc-4.0"));
        assert!(non_commercial("cc-by-nc-sa-4.0"));
        assert!(!non_commercial("cc-by-4.0"));
        assert!(!non_commercial("apache-2.0"));
        assert!(!non_commercial("other"));
        let offered = |repo: &str| crate::catalog::CATALOG.iter().any(|m| m.id.contains(repo));
        assert!(!offered("/canary-1b-gguf/"), "cc-by-nc-4.0");
        assert!(
            !offered("/granite-speech-5.0-470m-turboctc-nc-gguf/"),
            "cc-by-nc-sa-4.0"
        );
        assert!(offered("/canary-1b-v2-gguf/"), "cc-by-4.0 stays");
    }

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
