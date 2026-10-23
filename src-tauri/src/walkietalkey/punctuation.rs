//! Punctuation (DESK-41, spec 6.4 step 4): Ekko PnC (int8 ONNX, about 22 MB,
//! local through ONNX Runtime) runs on the recognised text when it has fewer
//! than one mark per 25 words, or always or never by "Tegnsætning". It runs
//! before filler removal, as the spec orders the steps. Without its files
//! (not downloaded yet), or on an Intel Mac, the text passes unchanged.

use std::path::{Path, PathBuf};
use std::time::Instant;

use log::{info, warn};
use tauri::AppHandle;

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
