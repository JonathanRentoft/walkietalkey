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
