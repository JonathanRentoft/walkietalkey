//! Punctuation (DESK-41, spec 6.4 step 4): Ekko PnC (int8 ONNX, about 22 MB,
//! local through ONNX Runtime) runs on the recognised text when it has fewer
//! than one mark per 25 words, or always or never by "Tegnsætning". It runs
//! before filler removal, as the spec orders the steps. Without its files
//! (not downloaded yet), or on an Intel Mac, the text passes unchanged.
//!
//! The files are fetched at start when they are missing (DESK-32: resumed,
//! checked against SHA-256, a failed check retried once): from our GitHub
//! release `models-v1` (byte for byte RyeAI's files at the revision the
//! reference tool pins), or from the company's `ModelBaseUrl` when set
//! (DESK-102). Their licence files come along. Release asset names cannot
//! hold a `/`, so there the licence files are flat with an `ekko-pnc-`
//! prefix (`ekko-pnc-CC-BY-4.0.txt`); a company server keeps the paths
//! (`LICENSES/CC-BY-4.0.txt`). Locally they always land at their paths.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
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

/// Runs `f` with the shared Ekko PnC, loading it from `dir` the first time.
/// `None` when its files are missing or it cannot load.
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn with_punctuator<T>(dir: &Path, f: impl FnOnce(&ekko_pnc::Punctuator) -> T) -> Option<T> {
    use once_cell::sync::OnceCell;

    static PUNCTUATOR: OnceCell<Mutex<Option<ekko_pnc::Punctuator>>> = OnceCell::new();
    let cell = PUNCTUATOR.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        if !dir.join("pnc.int8.onnx").exists() {
            return None;
        }
        match ekko_pnc::Punctuator::from_dir(dir) {
            Ok(p) => *guard = Some(p),
            Err(e) => {
                warn!("Ekko PnC could not load: {e}");
                return None;
            }
        }
    }
    guard.as_ref().map(f)
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn punctuate_with(dir: &Path, text: String) -> String {
    let started = Instant::now();
    let Some(result) = with_punctuator(dir, |p| p.punctuate(&text)) else {
        return text;
    };
    match result {
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

/// Reads chunk joints with Ekko PnC (run 4, `pipeline::da::joints`).
pub struct PncJointJudge {
    dir: PathBuf,
}

/// The joint judge, unless "Tegnsætning" is "Aldrig" or Ekko PnC's files are
/// missing. On an Intel Mac Ekko PnC does not run, so every joint stays as
/// Whisper wrote it.
pub fn joint_judge(app: &AppHandle) -> Option<PncJointJudge> {
    if super::store::get(app).punctuation
        == crate::pipeline::da::punctuation::PunctuationMode::Never
    {
        return None;
    }
    let dir = pnc_dir(app)?;
    files_present(&dir).then_some(PncJointJudge { dir })
}

impl PncJointJudge {
    /// A judge on the files in `dir` (tests point it at WT_EKKO_PNC_DIR).
    pub fn from_dir(dir: PathBuf) -> Self {
        Self { dir }
    }
}

impl crate::pipeline::da::joints::JointJudge for PncJointJudge {
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    fn read(
        &self,
        before: &[String],
        after: &[String],
    ) -> Option<crate::pipeline::da::joints::JointReading> {
        let words: Vec<&str> = before.iter().chain(after).map(String::as_str).collect();
        let rendered = with_punctuator(&self.dir, |p| p.punctuate_words(&words))?
            .map_err(|e| warn!("Joint reading failed: {e}"))
            .ok()?;
        // Each word comes back as itself, maybe with a capital and one mark.
        let last = rendered.get(before.len().checked_sub(1)?)?;
        let next = rendered.get(before.len())?;
        let mark: String = last.chars().skip(before.last()?.chars().count()).collect();
        Some(crate::pipeline::da::joints::JointReading {
            mark: (!mark.is_empty()).then_some(mark),
            next_upper: next.chars().next().is_some_and(char::is_uppercase),
        })
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    fn read(
        &self,
        _before: &[String],
        _after: &[String],
    ) -> Option<crate::pipeline::da::joints::JointReading> {
        None
    }
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

/// Where the files come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// Our release: flat asset names.
    Release(String),
    /// A company's server (Appendix B `ModelBaseUrl`): the files' paths.
    Company(String),
}

impl Source {
    /// The URL of the file at local path `name` here.
    pub fn url(&self, name: &str) -> String {
        match self {
            Source::Release(base) => format!("{base}/{}", release_asset_name(name)),
            Source::Company(base) => format!("{base}/{name}"),
        }
    }
}

/// A file's asset name in our release: a licence file in a folder gets
/// `ekko-pnc-` and its base name, the rest keep their names.
pub fn release_asset_name(name: &str) -> String {
    let is_runtime = RUNTIME_FILES.iter().any(|f| f.name == name);
    if is_runtime {
        return name.to_string();
    }
    let base = name.rsplit('/').next().unwrap_or(name);
    format!("ekko-pnc-{base}")
}

/// The company's server when `ModelBaseUrl` is set, else our release.
pub fn source(model_base_url: Option<&str>) -> Source {
    match model_base_url.map(|b| b.trim_end_matches('/')) {
        Some(base) if !base.is_empty() => Source::Company(base.to_string()),
        _ => Source::Release(super::models::MODEL_RELEASE_BASE.to_string()),
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
    let from = source(super::store::get(app).model_base_url.as_deref());
    set_status(app, PncStatus::Downloading);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match fetch_all(&from, &dir).await {
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

async fn fetch_all(from: &Source, dir: &Path) -> anyhow::Result<()> {
    // Licence files first, so the model never arrives without them.
    let files: Vec<(&'static str, &'static str)> = LICENCE_FILES
        .iter()
        .chain(RUNTIME_FILES.iter())
        .map(|f| (f.name, f.sha256))
        .collect();
    fetch_files(from, dir, files).await
}

/// Fetches `(local path, sha256)` files into `dir`.
async fn fetch_files<'a>(
    from: &Source,
    dir: &Path,
    files: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .user_agent("WalkieTalkey/0.1 (+https://github.com/JonathanRentoft/walkietalkey)")
        .build()?;
    for (name, sha256) in files {
        let url = from.url(name);
        let dest = dir.join(name);
        // DESK-32: a failed check deletes the file and retries once.
        if let Err(first) = fetch(&client, &url, &dest, sha256).await {
            warn!("{name} did not arrive ({first}); trying once more");
            fetch(&client, &url, &dest, sha256).await?;
        }
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

/// Real chunk joints read by the real model (run 4): FLEURS sentences cut at
/// a pause or paired, each part decoded by Edda the way the app decodes a
/// chunk (`pipeline/da/testdata/joints-fleurs.json`, made by
/// `scripts/walkietalkey/joints/make_fixtures.py`). Needs Ekko PnC's files in
/// `WT_EKKO_PNC_DIR` (CI downloads them); skipped without.
#[cfg(all(test, not(all(target_os = "macos", target_arch = "x86_64"))))]
mod joint_tests {
    use super::PncJointJudge;
    use crate::pipeline::da::joints::repair;

    /// Whether a sentence ends at the joint, and whether the next word has a capital.
    fn joint(before: &str, after: &str) -> (bool, bool) {
        (
            before.trim_end().ends_with(['.', '?', '!', '…']),
            after
                .chars()
                .find(|c| c.is_alphabetic())
                .is_some_and(char::is_uppercase),
        )
    }

    #[test]
    fn real_edda_joints_are_read_again() {
        let Ok(dir) = std::env::var("WT_EKKO_PNC_DIR") else {
            eprintln!("skipped: set WT_EKKO_PNC_DIR to Ekko PnC's files");
            return;
        };
        let judge = PncJointJudge::from_dir(dir.into());
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../pipeline/da/testdata/joints-fleurs.json"))
                .unwrap();
        let (mut cases, mut right_as_decoded, mut right_repaired) = (0, 0, 0);
        let mut wrong = Vec::new();
        for case in fixture["cases"].as_array().unwrap() {
            let (before, after) = (
                case["before"].as_str().unwrap(),
                case["after"].as_str().unwrap(),
            );
            let expected = (
                case["boundary"].as_bool().unwrap(),
                case["next_upper"].as_bool().unwrap(),
            );
            let (b, a) = repair(before, after, &judge);
            cases += 1;
            right_as_decoded += usize::from(joint(before, after) == expected);
            if joint(&b, &a) == expected {
                right_repaired += 1;
            } else {
                wrong.push(format!("{}: {b} | {a}", case["id"]));
            }
        }
        eprintln!(
            "{cases} joints: {right_as_decoded} right as decoded, {right_repaired} after repair\n{}",
            wrong.join("\n")
        );
        assert!(cases >= 60, "{cases} cases");
        assert!(
            right_repaired * 100 >= cases * JOINTS_RIGHT_PERCENT,
            "{right_repaired} of {cases} joints right after repair"
        );
        assert!(right_repaired > right_as_decoded);
    }

    /// The share of real joints that must come out right.
    const JOINTS_RIGHT_PERCENT: usize = 85;
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
    fn our_release_has_flat_names_and_a_company_server_the_paths() {
        // DESK-32 (release models-v1), DESK-102 (ModelBaseUrl).
        let release = source(None);
        assert_eq!(source(Some("")), release);
        let licence = &LICENCE_FILES[2];
        assert_eq!(licence.name, "LICENSES/CC-BY-4.0.txt");
        assert_eq!(
            release.url(licence.name),
            "https://github.com/JonathanRentoft/walkietalkey/releases/download/models-v1/ekko-pnc-CC-BY-4.0.txt"
        );
        assert_eq!(
            release.url(RUNTIME_FILES[0].name),
            "https://github.com/JonathanRentoft/walkietalkey/releases/download/models-v1/pnc.int8.onnx"
        );
        let company = source(Some("https://modeller.firma.dk/wt/"));
        assert_eq!(
            company.url(licence.name),
            "https://modeller.firma.dk/wt/LICENSES/CC-BY-4.0.txt"
        );
        assert_eq!(
            company.url(RUNTIME_FILES[1].name),
            "https://modeller.firma.dk/wt/tokenizer.json"
        );
        let names: Vec<String> = LICENCE_FILES
            .iter()
            .map(|f| release_asset_name(f.name))
            .collect();
        assert_eq!(
            names,
            [
                "ekko-pnc-MODEL_LICENSE.md",
                "ekko-pnc-NOTICE",
                "ekko-pnc-CC-BY-4.0.txt",
                "ekko-pnc-CC0-1.0.txt",
                "ekko-pnc-CORAL-LICENSE",
                "ekko-pnc-FTSPEECH-LICENSE.md",
            ]
        );
        for f in &RUNTIME_FILES {
            assert!(!release.url(f.name).contains("huggingface"));
        }
    }

    #[test]
    fn the_release_names_and_sums_match_the_manifest() {
        // DESK-32: what models/manifest.json says release models-v1 holds.
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../models/manifest.json")).unwrap();
        assert_eq!(
            manifest["baseUrl"].as_str().unwrap().trim_end_matches('/'),
            super::super::models::MODEL_RELEASE_BASE
        );
        let pnc = manifest["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "ekko-pnc")
            .unwrap();
        for f in &LICENCE_FILES {
            let asset = &pnc["licenseAssets"][f.name];
            assert_eq!(asset["asset"], release_asset_name(f.name), "{}", f.name);
            assert_eq!(asset["sha256"], f.sha256, "{}", f.name);
        }
        for f in &RUNTIME_FILES {
            let entry = pnc["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["name"] == f.name)
                .unwrap();
            assert_eq!(entry["path"], release_asset_name(f.name), "{}", f.name);
        }
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

    /// The release answers like GitHub: a 302 to its storage host, which
    /// serves the bytes and honours Range requests. A fake server, never the
    /// network.
    mod fake_release {
        use std::collections::HashMap;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        pub struct Server {
            pub base: String,
            pub requests: Arc<Mutex<Vec<String>>>,
            pub corrupt_once: Arc<Mutex<Option<String>>>,
            pub served: Arc<AtomicUsize>,
        }

        /// Serves `files` (asset name -> bytes) at `/download/<name>` via a
        /// redirect to `/storage/<name>`.
        pub async fn start(files: HashMap<String, Vec<u8>>) -> Server {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let corrupt_once: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let served = Arc::new(AtomicUsize::new(0));
            let files = Arc::new(files);
            let (r, c, n) = (requests.clone(), corrupt_once.clone(), served.clone());
            tokio::spawn(async move {
                loop {
                    let Ok((mut sock, _)) = listener.accept().await else {
                        return;
                    };
                    let (files, r, c, n) = (files.clone(), r.clone(), c.clone(), n.clone());
                    tokio::spawn(async move {
                        let mut head = Vec::new();
                        let mut byte = [0u8; 1];
                        while !head.ends_with(b"\r\n\r\n") {
                            if sock.read_exact(&mut byte).await.is_err() {
                                return;
                            }
                            head.push(byte[0]);
                        }
                        let head = String::from_utf8_lossy(&head).to_string();
                        let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                        let range = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("range: bytes=")
                                    .map(str::to_string)
                            })
                            .and_then(|r| r.trim_end_matches('-').trim().parse::<usize>().ok());
                        r.lock().unwrap().push(format!("{path} {range:?}"));
                        let response = if let Some(name) = path.strip_prefix("/download/") {
                            format!(
                                "HTTP/1.1 302 Found\r\nLocation: /storage/{name}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            )
                            .into_bytes()
                        } else if let Some(body) = path
                            .strip_prefix("/storage/")
                            .and_then(|name| files.get(name).map(|b| (name.to_string(), b.clone())))
                        {
                            let (name, mut bytes) = body;
                            let mut corrupt = c.lock().unwrap();
                            if corrupt.as_deref() == Some(name.as_str()) {
                                *corrupt = None;
                                bytes = vec![b'x'; bytes.len()];
                            }
                            n.fetch_add(1, Ordering::SeqCst);
                            match range {
                                Some(start) if start < bytes.len() => {
                                    let part = &bytes[start..];
                                    let mut out = format!(
                                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                        bytes.len() - 1,
                                        bytes.len(),
                                        part.len()
                                    )
                                    .into_bytes();
                                    out.extend_from_slice(part);
                                    out
                                }
                                _ => {
                                    let mut out = format!(
                                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                        bytes.len()
                                    )
                                    .into_bytes();
                                    out.extend_from_slice(&bytes);
                                    out
                                }
                            }
                        } else {
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
                        };
                        let _ = sock.write_all(&response).await;
                        let _ = sock.shutdown().await;
                    });
                }
            });
            Server {
                base: format!("http://{addr}/download"),
                requests,
                corrupt_once,
                served,
            }
        }
    }

    fn sha(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn a_file_follows_the_redirect_and_resumes_a_partial_download() {
        tauri::async_runtime::block_on(async {
            let bytes: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
            let files = [("pnc.int8.onnx".to_string(), bytes.clone())].into();
            let server = fake_release::start(files).await;
            let dir = tempfile::tempdir().unwrap();
            let dest = dir.path().join("pnc.int8.onnx");
            // An earlier attempt stopped after 20,000 bytes.
            std::fs::write(dest.with_extension("part"), &bytes[..20_000]).unwrap();
            let client = reqwest::Client::new();
            fetch(
                &client,
                &format!("{}/pnc.int8.onnx", server.base),
                &dest,
                &sha(&bytes),
            )
            .await
            .unwrap();
            assert_eq!(std::fs::read(&dest).unwrap(), bytes);
            let requests = server.requests.lock().unwrap().clone();
            assert_eq!(
                requests,
                vec![
                    "/download/pnc.int8.onnx Some(20000)".to_string(),
                    "/storage/pnc.int8.onnx Some(20000)".to_string(),
                ],
                "the Range survives GitHub's redirect"
            );
        });
    }

    #[test]
    fn every_file_lands_at_its_path_and_a_bad_one_is_retried_once() {
        tauri::async_runtime::block_on(async {
            // Stand-in bytes: the fake release serves what the test expects.
            let mut files = std::collections::HashMap::new();
            let mut expected = Vec::new();
            for f in LICENCE_FILES.iter().chain(RUNTIME_FILES.iter()) {
                let bytes = format!("contents of {}", f.name).into_bytes();
                expected.push((f.name, sha(&bytes)));
                files.insert(release_asset_name(f.name), bytes);
            }
            let server = fake_release::start(files).await;
            *server.corrupt_once.lock().unwrap() = Some("tokenizer.json".to_string());
            let dir = tempfile::tempdir().unwrap();
            let from = Source::Release(server.base.clone());
            fetch_files(
                &from,
                dir.path(),
                expected.iter().map(|(name, hash)| (*name, hash.as_str())),
            )
            .await
            .unwrap();
            assert!(files_present(dir.path()));
            assert!(dir.path().join("LICENSES/CORAL-LICENSE").is_file());
            assert!(dir.path().join("MODEL_LICENSE.md").is_file());
            // 9 files, one of them twice.
            assert_eq!(server.served.load(std::sync::atomic::Ordering::SeqCst), 10);
        });
    }
}
