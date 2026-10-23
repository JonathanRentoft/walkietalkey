//! Punctuation (DESK-41, spec 6.4 step 4): Ekko PnC (int8 ONNX, about 22 MB,
//! local through ONNX Runtime) runs on the recognised text when it has fewer
//! than one mark per 25 words, or always or never by "Tegnsætning". It runs
//! before filler removal, as the spec orders the steps. Without its files
//! (not downloaded yet), or on an Intel Mac, the text passes unchanged.
//!
//! The files are fetched at start when they are missing (DESK-32: resumed,
//! checked against SHA-256): from the company's `ModelBaseUrl` when set,
//! else from RyeAI's own Hugging Face repository at the pinned revision (our
//! copy there is byte for byte the same, and our organisation's repository
//! does not exist yet). Their licence files come along.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use log::{info, warn};
use once_cell::sync::Lazy;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};

use crate::pipeline::da::punctuation::should_punctuate;

/// The folder in the models directory that holds Ekko PnC's files.
pub const PNC_DIR: &str = "ekko-pnc";

pub fn pnc_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::portable::app_data_dir(app)
        .ok()
        .map(|dir| dir.join("models").join(PNC_DIR))
}

/// Applies the punctuation step to a recognised text.
pub fn apply(app: &AppHandle, text: String) -> String {
    let mode = super::store::get(app).punctuation;
    if !should_punctuate(mode, &text) {
        return text;
    }
    let Some(dir) = pnc_dir(app) else {
        return text;
    };
    punctuate_with(&dir, text)
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn punctuate_with(dir: &Path, text: String) -> String {
    use std::sync::Mutex;

    use once_cell::sync::OnceCell;

    static PUNCTUATOR: OnceCell<Mutex<Option<ekko_pnc::Punctuator>>> = OnceCell::new();
    let cell = PUNCTUATOR.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap();
    if guard.is_none() {
        if !dir.join("pnc.int8.onnx").exists() {
            return text;
        }
        match ekko_pnc::Punctuator::from_dir(dir) {
            Ok(p) => *guard = Some(p),
            Err(e) => {
                warn!("Ekko PnC could not load: {e}");
                return text;
            }
        }
    }
    let started = Instant::now();
    match guard.as_ref().expect("loaded above").punctuate(&text) {
        Ok(punctuated) => {
            info!(
                "Punctuated {} words in {:?}",
                text.split_whitespace().count(),
                started.elapsed()
            );
            punctuated
        }
        Err(e) => {
            warn!("Punctuation failed: {e}");
            text
        }
    }
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn punctuate_with(_dir: &Path, text: String) -> String {
    text
}

/// One file Ekko PnC needs, as `models/manifest.json` lists it.
pub struct PncFile {
    pub name: &'static str,
    pub sha256: &'static str,
}

/// What the punctuator loads.
pub const RUNTIME_FILES: [PncFile; 3] = [
    PncFile {
        name: "pnc.int8.onnx",
        sha256: "46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527",
    },
    PncFile {
        name: "tokenizer.json",
        sha256: "a1e0d43ee307ad7a1ccc23e6e5398d877a68ca7f576067ac507625a0d50e9502",
    },
    PncFile {
        name: "config.json",
        sha256: "dc655c46f69eeb15dd43786ad58fb5862cc794b36cc9d2c426ab5bc4b01f23ca",
    },
];

/// What must travel with the model (CC BY 4.0, the CoRal and FT Speech terms).
pub const LICENCE_FILES: [PncFile; 6] = [
    PncFile {
        name: "MODEL_LICENSE.md",
        sha256: "590f820521961c89e7795bd3f46575794f4cbdcb02cc9db682e825c0afc874aa",
    },
    PncFile {
        name: "NOTICE",
        sha256: "bc86a9b47ff32a3ab29bb0ff8f414ae8b2ef1932ccf8bae2e4dacb5a6812ba8d",
    },
    PncFile {
        name: "LICENSES/CC-BY-4.0.txt",
        sha256: "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411",
    },
    PncFile {
        name: "LICENSES/CC0-1.0.txt",
        sha256: "a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499",
    },
    PncFile {
        name: "LICENSES/CORAL-LICENSE",
        sha256: "ee93c98df9a894464d1c042b66c6039543776c463d06d1a6e93f176e08ca67bd",
    },
    PncFile {
        name: "LICENSES/FTSPEECH-LICENSE.md",
        sha256: "39708f5d77ae217b3a540363cb1b37fe079478e4ed1d3464f38d05d5a1c58b9a",
    },
];

/// RyeAI's repository at the revision the reference tool pins.
pub const RYEAI_BASE: &str =
    "https://huggingface.co/RyeAI/ekko-pnc/resolve/d3129544e4e0155093e192cac58a9e69a4dea1ff";

/// Where the files come from: the company's server (same file names, Appendix
/// B `ModelBaseUrl`), or RyeAI's repository.
pub fn source_base(model_base_url: Option<&str>) -> String {
    match model_base_url.map(|b| b.trim_end_matches('/')) {
        Some(base) if !base.is_empty() => base.to_string(),
        _ => RYEAI_BASE.to_string(),
    }
}

/// Whether this build can run Ekko PnC (no ONNX Runtime for Intel Macs).
pub const SUPPORTED: bool = !cfg!(all(target_os = "macos", target_arch = "x86_64"));

/// The punctuation model's state, for Indstillinger › Model.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PncStatus {
    Ready,
    Missing,
    Downloading,
    Failed {
        message: String,
    },
    /// An Intel Mac: punctuation is not available (deviation, docs/MODELS.md).
    Unsupported,
}

static STATUS: Lazy<Mutex<Option<PncStatus>>> = Lazy::new(|| Mutex::new(None));

fn set_status(app: &AppHandle, status: PncStatus) {
    *STATUS.lock().unwrap() = Some(status.clone());
    let _ = app.emit("wt-punctuation-status", status);
}

/// Whether the runtime files are in `dir` (by name; their sums were checked
/// when they arrived).
pub fn files_present(dir: &Path) -> bool {
    RUNTIME_FILES.iter().all(|f| dir.join(f.name).is_file())
}

pub fn status(app: &AppHandle) -> PncStatus {
    if !SUPPORTED {
        return PncStatus::Unsupported;
    }
    if let Some(status) = STATUS.lock().unwrap().clone() {
        if status != PncStatus::Missing {
            return status;
        }
    }
    match pnc_dir(app) {
        Some(dir) if files_present(&dir) => PncStatus::Ready,
        _ => PncStatus::Missing,
    }
}

/// At start: fetches the files when they are missing.
pub fn ensure(app: &AppHandle) {
    if !SUPPORTED {
        return;
    }
    let Some(dir) = pnc_dir(app) else {
        return;
    };
    if files_present(&dir) {
        set_status(app, PncStatus::Ready);
        return;
    }
    download(app);
}

/// Downloads the files now (at start, or "Prøv igen").
pub fn download(app: &AppHandle) {
    let Some(dir) = pnc_dir(app) else {
        return;
    };
    if matches!(*STATUS.lock().unwrap(), Some(PncStatus::Downloading)) {
        return;
    }
    let base = source_base(super::store::get(app).model_base_url.as_deref());
    set_status(app, PncStatus::Downloading);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match fetch_all(&base, &dir).await {
            Ok(()) => {
                info!("Ekko PnC is ready in {}", dir.display());
                set_status(&app, PncStatus::Ready);
            }
            Err(e) => {
                warn!("Ekko PnC download failed: {e}");
                set_status(
                    &app,
                    PncStatus::Failed {
                        message: e.to_string(),
                    },
                );
            }
        }
    });
}

async fn fetch_all(base: &str, dir: &Path) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .user_agent("WalkieTalkey/0.1 (+https://github.com/JonathanRentoft/walkietalkey)")
        .build()?;
    // Licence files first, so the model never arrives without them.
    for file in LICENCE_FILES.iter().chain(RUNTIME_FILES.iter()) {
        fetch(
            &client,
            &format!("{base}/{}", file.name),
            &dir.join(file.name),
            file.sha256,
        )
        .await?;
    }
    Ok(())
}

/// Fetches one file to `dest`, resuming a partial download, and keeps it
/// only if its SHA-256 matches.
async fn fetch(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    sha256: &str,
) -> anyhow::Result<()> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    if dest.is_file() && super::models::sha256_of(dest)? == sha256 {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let partial = dest.with_extension("part");
    let have = tokio::fs::metadata(&partial)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let mut request = client.get(url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let response = request.send().await?.error_for_status()?;
    let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&partial)
        .await?;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        file.write_all(&chunk?).await?;
    }
    file.flush().await?;
    drop(file);
    let got = super::models::sha256_of(&partial)?;
    if got != sha256 {
        let _ = tokio::fs::remove_file(&partial).await;
        anyhow::bail!("{url}: SHA-256 {got}, expected {sha256}");
    }
    tokio::fs::rename(&partial, dest).await?;
    Ok(())
}

#[cfg(test)]
mod download_tests {
    use super::*;

    #[test]
    fn the_file_list_matches_the_manifest() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../models/manifest.json")).unwrap();
        let pnc = manifest["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "ekko-pnc")
            .expect("ekko-pnc in the manifest");
        let files = pnc["files"].as_array().unwrap();
        assert_eq!(files.len(), RUNTIME_FILES.len());
        for f in &RUNTIME_FILES {
            let entry = files
                .iter()
                .find(|e| e["name"] == f.name)
                .unwrap_or_else(|| panic!("{} in the manifest", f.name));
            assert_eq!(entry["sha256"], f.sha256, "{}", f.name);
        }
        let licences: Vec<&str> = pnc["licenseFiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        for f in &LICENCE_FILES {
            assert!(
                licences.contains(&f.name),
                "{} travels with the model",
                f.name
            );
        }
    }

    #[test]
    fn a_company_server_replaces_ryeai() {
        assert_eq!(source_base(None), RYEAI_BASE);
        assert_eq!(source_base(Some("")), RYEAI_BASE);
        assert_eq!(
            source_base(Some("https://modeller.firma.dk/wt/")),
            "https://modeller.firma.dk/wt"
        );
    }

    #[test]
    fn present_means_every_runtime_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!files_present(dir.path()));
        for f in &RUNTIME_FILES {
            std::fs::write(dir.path().join(f.name), b"x").unwrap();
        }
        assert!(files_present(dir.path()));
    }

    /// Downloads the real files from RyeAI (network): `cargo test --lib
    /// download_tests::real -- --ignored`.
    #[test]
    #[ignore]
    fn real_download_from_ryeai() {
        let dir = tempfile::tempdir().unwrap();
        tauri::async_runtime::block_on(fetch_all(RYEAI_BASE, dir.path())).unwrap();
        assert!(files_present(dir.path()));
        assert!(dir.path().join("LICENSES/CORAL-LICENSE").is_file());
    }
}
