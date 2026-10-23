//! Model files (DESK-32): a company's own model server (`ModelBaseUrl`)
//! replaces Hugging Face entirely, and "Importér modelfil" installs a file
//! the user already has, both checked against the SHA-256 sums compiled into
//! the app. A company server holds the same file names in one folder:
//! `{ModelBaseUrl}/{file name}`.

use std::fs;
use std::io::Read;
use std::path::Path;

use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};

use crate::catalog::MirrorFile;

/// The download of `model_id` from the company's server, if one is set.
pub fn company_mirror(model_base_url: Option<&str>, model_id: &str) -> Option<MirrorFile> {
    let base = model_base_url?.trim_end_matches('/');
    let (_, filename, sha256, size) = crate::catalog::file_hashes()
        .into_iter()
        .find(|(id, _, _, _)| id == model_id)?;
    Some(MirrorFile {
        url: format!("{base}/{filename}"),
        sha256,
        size_bytes: size,
    })
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
        // TODO(copy): the error the UI shows for a damaged download.
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
    Ok(format!("{:x}", hasher.finalize()))
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
    // TODO(copy): the error the UI shows for an unknown file.
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
    fn a_company_server_serves_the_same_file_names() {
        let mirror = company_mirror(Some("https://modeller.firma.dk/wt/"), DEFAULT_MODEL_ID)
            .expect("Edda has a catalog file");
        assert_eq!(
            mirror.url,
            "https://modeller.firma.dk/wt/edda-v0.2-Q8_0.gguf"
        );
        assert_eq!(mirror.sha256.len(), 64);
        assert!(mirror.size_bytes > 800_000_000);
        assert!(company_mirror(None, DEFAULT_MODEL_ID).is_none());
        assert!(company_mirror(Some("https://x"), "not/a-model.gguf").is_none());
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
