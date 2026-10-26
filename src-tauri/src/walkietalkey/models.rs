//! Model files (DESK-11, DESK-32, DESK-102): WalkieTalkey's own models come
//! from our GitHub release (`models-v1`), a company's own model server
//! (`ModelBaseUrl`) replaces every source, and "Importér modelfil" installs a
//! file the user already has, all checked against the SHA-256 sums compiled
//! into the app. Both servers hold the same flat file names:
//! `{base}/{file name}`. GitHub answers with a redirect to its storage,
//! which the downloader follows (Range requests included, so downloads
//! resume). Handy's own catalog keeps its Hugging Face downloads.
//!
//! The default model (Edda, DESK-30) starts downloading at the first launch,
//! in the background, and reports through the usual events
//! (`model-download-progress`, `model-download-complete`,
//! `model-download-failed`).

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use log::{info, warn};
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use super::settings::ONBOARDING_DONE;
use crate::catalog::MirrorFile;

/// Where WalkieTalkey's models are published: the assets of release
/// `models-v1` (flat names, the bytes the catalog's SHA-256 sums describe).
pub const MODEL_RELEASE_BASE: &str =
    "https://github.com/JonathanRentoft/walkietalkey/releases/download/models-v1";

/// The catalog repositories that are ours (`catalog.json` next to this file).
pub fn is_ours(model_id: &str) -> bool {
    model_id.starts_with("walkietalkey/")
}

/// The direct download of `model_id`: from the company's server when one is
/// set (any catalog model), else from our release for our own models. `None`
/// leaves Handy's models to Hugging Face.
pub fn direct_source(model_base_url: Option<&str>, model_id: &str) -> Option<MirrorFile> {
    let company = model_base_url
        .map(|b| b.trim_end_matches('/'))
        .filter(|b| !b.is_empty());
    let base = match company {
        Some(base) => base,
        None if is_ours(model_id) => MODEL_RELEASE_BASE,
        None => return None,
    };
    let (_, filename, sha256, size) = crate::catalog::file_hashes()
        .into_iter()
        .find(|(id, _, _, _)| id == model_id)?;
    Some(MirrorFile {
        url: format!("{base}/{filename}"),
        sha256,
        size_bytes: size,
    })
}

/// Downloads in progress, by model id: a second request for the same file
/// (onboarding, the model settings, the first-launch download) waits for the
/// first instead of writing the same partial file twice.
static IN_FLIGHT: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Holds a model's slot in [`IN_FLIGHT`] while its download runs.
pub struct DownloadSlot(String);

impl Drop for DownloadSlot {
    fn drop(&mut self) {
        IN_FLIGHT
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// Claims the download of `model_id`, or `None` when one is running.
pub fn begin_download(model_id: &str) -> Option<DownloadSlot> {
    IN_FLIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(model_id.to_string())
        .then(|| DownloadSlot(model_id.to_string()))
}

pub fn is_downloading(model_id: &str) -> bool {
    IN_FLIGHT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(model_id)
}

/// Waits for the running download of `model_id` to end; `Ok` when the file
/// is then in place (`downloaded`).
pub async fn wait_for_download<F: Fn() -> bool>(model_id: &str, downloaded: F) -> Result<()> {
    while is_downloading(model_id) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if downloaded() {
        Ok(())
    } else {
        Err(anyhow!("The download of {model_id} did not finish"))
    }
}

/// Whether the user is past onboarding: WalkieTalkey's own onboarding saves
/// `onboarding_resume_step = "finished"` (it never sets Handy's
/// `onboarding_completed`, which only picking a model in the model settings
/// does); either counts.
fn onboarding_done(handy_completed: bool, resume_step: Option<&str>) -> bool {
    handy_completed || resume_step == Some(ONBOARDING_DONE)
}

/// The model to fetch by itself at start: during onboarding the selected one
/// (a company may pin it) or the default (DESK-30), when it is not here yet.
/// Run 6: after onboarding, the base Edda, if it is missing, because every
/// version of Edda rolls back to it (`versions`); the app never deletes it, so
/// this only repairs a file removed by hand. A company that pins a model
/// manages its models itself.
fn first_launch_target(
    selected_model: &str,
    onboarding_completed: bool,
    model_pinned: bool,
    is_downloaded: impl Fn(&str) -> Option<bool>,
) -> Option<String> {
    if onboarding_completed {
        let keep = super::catalog::DEFAULT_MODEL_ID;
        return (!model_pinned && is_downloaded(keep) == Some(false)).then(|| keep.to_string());
    }
    let target = if selected_model.is_empty() {
        super::catalog::DEFAULT_MODEL_ID
    } else {
        selected_model
    };
    // Only catalog models can be fetched (a custom file cannot).
    let known = crate::catalog::file_hashes()
        .iter()
        .any(|(id, _, _, _)| id == target);
    (known && is_downloaded(target) == Some(false)).then(|| target.to_string())
}

/// DESK-11: the speech model starts downloading as soon as the app first
/// starts, not when an onboarding step mounts. Its progress and end arrive
/// as the usual events; the onboarding (or anything else) asking for the same
/// model meanwhile joins this download.
pub fn download_default_at_first_launch(app: &AppHandle) {
    let Some(mm) = app.try_state::<Arc<crate::managers::model::ModelManager>>() else {
        return;
    };
    let mm = Arc::clone(&mm);
    let settings = crate::settings::get_settings(app);
    let (wt, applied) = super::store::effective(app);
    let Some(model_id) = first_launch_target(
        &settings.selected_model,
        onboarding_done(
            settings.onboarding_completed,
            wt.onboarding_resume_step.as_deref(),
        ),
        applied.locked.iter().any(|f| f == "selected_model"),
        |id| mm.get_model_info(id).map(|m| m.is_downloaded),
    ) else {
        return;
    };
    info!("Downloading {model_id} in the background (first launch, DESK-11)");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match mm.download_model(&model_id).await {
            Ok(()) => super::select_default_model(&app),
            Err(e) => {
                warn!("First-launch download of {model_id} failed: {e}");
                let _ = app.emit(
                    "model-download-failed",
                    serde_json::json!({ "model_id": &model_id, "error": e.to_string() }),
                );
            }
        }
    });
}

/// Checks a downloaded catalog model file against the catalog's SHA-256
/// (DESK-32). A model without a known hash passes.
pub fn verify_catalog_file(model_id: &str, path: &Path) -> Result<()> {
    let Some((_, _, expected, _)) = crate::catalog::file_hashes()
        .into_iter()
        .find(|(id, _, _, _)| id == model_id)
    else {
        return Ok(());
    };
    let got = sha256_of(path)?;
    if got.eq_ignore_ascii_case(&expected) {
        Ok(())
    } else {
        // The error the UI shows for a damaged download.
        Err(anyhow!(
            "Talemodellen kom ikke rigtigt frem (SHA-256 {got}, forventet {expected}). Prøv igen."
        ))
    }
}

/// SHA-256 of a file, streamed.
pub fn sha256_of(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// The catalog file a hash belongs to: `(registry id, file name)`.
/// The id "Importér modelfil" returns for Ekko PnC's files.
pub const PUNCTUATION_ID: &str = "ekko-pnc";

/// Ekko PnC's files (DESK-41): any one of them, with the others found next to
/// it, goes into the punctuation folder. Returns `None` for other files.
fn import_punctuation(source: &Path, hash: &str, models_dir: &Path) -> Result<Option<String>> {
    use super::punctuation::{PNC_DIR, RUNTIME_FILES};
    if !RUNTIME_FILES
        .iter()
        .any(|f| f.sha256.eq_ignore_ascii_case(hash))
    {
        return Ok(None);
    }
    let target_dir = models_dir.join(PNC_DIR);
    fs::create_dir_all(&target_dir)?;
    let from_dir = source.parent().unwrap_or(Path::new("."));
    for file in &RUNTIME_FILES {
        let candidate = from_dir.join(file.name);
        let path = if candidate.is_file() {
            candidate
        } else {
            continue;
        };
        if sha256_of(&path)? != file.sha256 {
            continue;
        }
        let target = target_dir.join(file.name);
        if target != path {
            let partial = target_dir.join(format!("{}.import", file.name));
            fs::copy(&path, &partial)?;
            fs::rename(&partial, &target)?;
        }
    }
    Ok(Some(PUNCTUATION_ID.to_string()))
}

pub fn catalog_file_for(sha256: &str) -> Option<(String, String)> {
    crate::catalog::file_hashes()
        .into_iter()
        .find(|(_, _, hash, _)| hash.eq_ignore_ascii_case(sha256))
        .map(|(id, filename, _, _)| (id, filename))
}

/// "Importér modelfil": checks `source` against the known hashes and copies
/// it into `models_dir` under its catalog name. Returns the model id.
pub fn import_model_file(source: &Path, models_dir: &Path) -> Result<String> {
    let hash = sha256_of(source)?;
    if let Some(id) = import_punctuation(source, &hash, models_dir)? {
        return Ok(id);
    }
    // The error the UI shows for an unknown file.
    let (model_id, filename) = catalog_file_for(&hash)
        .ok_or_else(|| anyhow!("Filen passer ikke til en kendt talemodel."))?;
    fs::create_dir_all(models_dir)?;
    let target = models_dir.join(&filename);
    if target != source {
        let partial = models_dir.join(format!("{filename}.import"));
        fs::copy(source, &partial)?;
        fs::rename(&partial, &target)?;
    }
    Ok(model_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::walkietalkey::catalog::DEFAULT_MODEL_ID;

    #[test]
    fn our_models_come_from_our_release() {
        // DESK-32: flat asset names under release models-v1.
        let edda = direct_source(None, DEFAULT_MODEL_ID).expect("Edda is ours");
        assert_eq!(
            edda.url,
            "https://github.com/JonathanRentoft/walkietalkey/releases/download/models-v1/edda-v0.2-Q8_0.gguf"
        );
        assert_eq!(
            edda.sha256,
            "63ac884ad3d436642e8599ed3bda6c2b3456a0bb939a497c796589dee3f3b18d"
        );
        assert_eq!(edda.size_bytes, 886_381_920);
        let ekko = direct_source(
            None,
            "walkietalkey/ekko-v1-tiny-gguf/ekko-v1-tiny-Q8_0.gguf",
        )
        .expect("Ekko v1 Tiny is ours");
        assert!(ekko.url.ends_with("/models-v1/ekko-v1-tiny-Q8_0.gguf"));
        assert!(
            !edda.url.contains("huggingface"),
            "no Hugging Face for ours"
        );
        // Handy's own models stay with Hugging Face.
        assert!(direct_source(
            None,
            "handy-computer/whisper-large-v3-turbo-gguf/whisper-large-v3-turbo-Q8_0.gguf"
        )
        .is_none());
    }

    #[test]
    fn a_company_server_serves_the_same_file_names() {
        // DESK-102: ModelBaseUrl replaces every source.
        let mirror = direct_source(Some("https://modeller.firma.dk/wt/"), DEFAULT_MODEL_ID)
            .expect("Edda has a catalog file");
        assert_eq!(
            mirror.url,
            "https://modeller.firma.dk/wt/edda-v0.2-Q8_0.gguf"
        );
        assert_eq!(mirror.sha256.len(), 64);
        assert!(mirror.size_bytes > 800_000_000);
        assert!(direct_source(Some(""), DEFAULT_MODEL_ID)
            .unwrap()
            .url
            .starts_with(MODEL_RELEASE_BASE));
        assert!(direct_source(Some("https://x"), "not/a-model.gguf").is_none());
    }

    #[test]
    fn the_download_urls_are_the_manifests_release_assets() {
        // DESK-32: baseUrl + path in models/manifest.json, for every model
        // of ours in the catalog.
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../models/manifest.json")).unwrap();
        let base = manifest["baseUrl"].as_str().unwrap();
        let ours: Vec<_> = crate::catalog::file_hashes()
            .into_iter()
            .filter(|(id, _, _, _)| is_ours(id))
            .collect();
        assert_eq!(ours.len(), 2, "Edda and Ekko v1 Tiny");
        for (id, filename, sha256, _) in ours {
            let entry = manifest["models"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|m| m["files"].as_array().unwrap())
                .find(|f| f["name"] == filename.as_str())
                .unwrap_or_else(|| panic!("{filename} in the manifest"));
            let source = direct_source(None, &id).unwrap();
            assert_eq!(
                source.url,
                format!("{base}{}", entry["path"].as_str().unwrap())
            );
            assert_eq!(entry["sha256"], sha256.as_str());
        }
    }

    #[test]
    fn one_download_per_model_at_a_time() {
        let id = "test/one-at-a-time.gguf";
        let slot = begin_download(id).expect("free");
        assert!(begin_download(id).is_none(), "the second request waits");
        assert!(is_downloading(id));
        drop(slot);
        assert!(!is_downloading(id));
        assert!(begin_download(id).is_some());
    }

    #[test]
    fn a_waiting_request_shares_the_first_ones_outcome() {
        let id = "test/shared-outcome.gguf";
        let slot = begin_download(id).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            drop(slot);
        });
        tauri::async_runtime::block_on(async {
            assert!(wait_for_download(id, || true).await.is_ok());
            assert!(wait_for_download(id, || false).await.is_err());
        });
        release.join().unwrap();
    }

    #[test]
    fn the_first_launch_fetches_the_default_model_by_itself() {
        // DESK-11, DESK-30.
        let missing = |_: &str| Some(false);
        assert_eq!(
            first_launch_target("", false, false, missing).as_deref(),
            Some(DEFAULT_MODEL_ID)
        );
        // A selected (or company-pinned) catalog model during onboarding.
        let ekko = "walkietalkey/ekko-v1-tiny-gguf/ekko-v1-tiny-Q8_0.gguf";
        assert_eq!(
            first_launch_target(ekko, false, true, missing).as_deref(),
            Some(ekko)
        );
        // Already there.
        assert_eq!(first_launch_target("", false, false, |_| Some(true)), None);
        // A custom file cannot be fetched.
        assert_eq!(
            first_launch_target("custom/my.gguf", false, false, |_| None),
            None
        );
    }

    #[test]
    fn after_onboarding_only_a_missing_base_edda_is_fetched_again() {
        // Run 6: every version rolls back to the base Edda, so it stays
        // installed; other models the user removed are not fetched again.
        let ekko = "walkietalkey/ekko-v1-tiny-gguf/ekko-v1-tiny-Q8_0.gguf";
        let edda_gone = |id: &str| Some(id != DEFAULT_MODEL_ID);
        let done = onboarding_done(false, Some(ONBOARDING_DONE));
        assert!(done);
        assert_eq!(
            first_launch_target("edda-ft-first-v2", done, false, edda_gone).as_deref(),
            Some(DEFAULT_MODEL_ID)
        );
        assert_eq!(
            first_launch_target(ekko, done, false, edda_gone).as_deref(),
            Some(DEFAULT_MODEL_ID)
        );
        // Edda is there: nothing, whatever else is missing.
        let others_gone = |id: &str| Some(id == DEFAULT_MODEL_ID);
        assert_eq!(first_launch_target(ekko, done, false, others_gone), None);
        // A company that pins a model manages its models.
        assert_eq!(first_launch_target(ekko, done, true, edda_gone), None);
        // Handy's flag (a model picked in the model settings) counts too.
        assert!(onboarding_done(true, None));
        // A first launch, or one resumed mid-onboarding, fetches the selected one.
        for step in [None, Some("welcome"), Some("accessibility"), Some("try")] {
            assert!(!onboarding_done(false, step), "{step:?}");
        }
        assert_eq!(
            first_launch_target(
                "",
                onboarding_done(false, Some("microphone")),
                false,
                |_| Some(false)
            )
            .as_deref(),
            Some(DEFAULT_MODEL_ID)
        );
    }

    #[test]
    fn punctuation_files_are_recognised_and_unknown_ones_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let other = dir.path().join("config.json");
        fs::write(&other, b"{}").unwrap();
        let hash = sha256_of(&other).unwrap();
        assert!(
            import_punctuation(&other, &hash, &dir.path().join("models"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_download_must_match_the_catalogs_sha256() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("edda-v0.2-Q8_0.gguf");
        fs::write(&file, b"not the model").unwrap();
        let err = verify_catalog_file(DEFAULT_MODEL_ID, &file).unwrap_err();
        assert!(err.to_string().contains("SHA-256"));
        // A model the catalog has no hash for is not blocked.
        assert!(verify_catalog_file("someone/else.gguf", &file).is_ok());
    }

    #[test]
    fn imports_accept_only_known_files() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("random.gguf");
        fs::write(&source, b"not a model").unwrap();
        let err = import_model_file(&source, &dir.path().join("models")).unwrap_err();
        assert!(err.to_string().contains("kendt talemodel"));
    }

    #[test]
    fn hashes_are_lower_case_hex() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x");
        fs::write(&file, b"abc").unwrap();
        assert_eq!(
            sha256_of(&file).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(catalog_file_for("00").is_none());
    }
}
