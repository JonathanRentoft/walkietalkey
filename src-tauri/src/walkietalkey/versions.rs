//! Model versions and rollback (run 6). The training workbench installs each
//! fine-tune of Edda as `edda-ft-<slug>-v<N>.gguf` in the models folder, with
//! a sidecar `<id>.json` holding its version number, name, run, date and
//! validation WER (training/wt_train/versions.py). The base Edda is the model
//! everything rolls back to, so the app keeps it installed: Indstillinger ›
//! Model offers no way to delete it ("Hent igen" only replaces a broken file),
//! and a missing one is fetched again at start
//! (`models::download_default_at_first_launch`).
//!
//! Indstillinger › Model lists the base and every installed version
//! ([`wt_model_versions`]) and switches between them. `walkietalkey
//! --use-model <id>` (`wt-train use`) does the same from the terminal: the
//! single-instance plugin hands it to the running app, or, with none running,
//! the selection is saved for the next start ([`use_model_offline`]).

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use super::catalog::DEFAULT_MODEL_ID;
use crate::managers::model::{ModelInfo, ModelManager};

/// The prefix of every workbench export (training/wt_train/export.py).
pub const VERSION_PREFIX: &str = "edda-ft-";

/// The base Edda (DESK-30), the model every version rolls back to.
pub fn is_base(model_id: &str) -> bool {
    model_id == DEFAULT_MODEL_ID
}

/// A version of Edda made by the workbench.
pub fn is_version(model_id: &str) -> bool {
    model_id.starts_with(VERSION_PREFIX)
}

/// What the workbench writes next to a version's GGUF.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Sidecar {
    pub version: Option<u32>,
    pub name: Option<String>,
    pub run: Option<String>,
    pub created: Option<String>,
    pub validation_wer: Option<f64>,
}

pub fn read_sidecar(models_dir: &Path, model_id: &str) -> Option<Sidecar> {
    let text = std::fs::read_to_string(models_dir.join(format!("{model_id}.json"))).ok()?;
    serde_json::from_str(&text).ok()
}

/// One row of Indstillinger › Model › Versioner.
#[derive(Debug, Clone, Serialize, Type, PartialEq)]
pub struct ModelVersion {
    pub id: String,
    pub name: String,
    /// The workbench's version number; `None` for the base Edda.
    pub version: Option<u32>,
    pub base: bool,
    pub selected: bool,
    /// ISO date and time the version was exported.
    pub created: Option<String>,
    /// The training run it came from.
    pub run: Option<String>,
    /// Word error rate on the validation clips, 0 to 1.
    pub validation_wer: Option<f64>,
}

/// The base Edda first, then every installed version, oldest first. Only
/// models that are on disk; the base is listed even while it downloads.
pub fn list(
    models: &[ModelInfo],
    selected: &str,
    sidecar: impl Fn(&str) -> Option<Sidecar>,
) -> Vec<ModelVersion> {
    let mut out = Vec::new();
    if let Some(base) = models.iter().find(|m| is_base(&m.id)) {
        out.push(ModelVersion {
            id: base.id.clone(),
            name: base.name.clone(),
            version: None,
            base: true,
            selected: selected == base.id,
            created: None,
            run: None,
            validation_wer: None,
        });
    }
    let mut versions: Vec<ModelVersion> = models
        .iter()
        .filter(|m| is_version(&m.id) && m.is_downloaded)
        .map(|m| {
            let side = sidecar(&m.id).unwrap_or_default();
            ModelVersion {
                id: m.id.clone(),
                name: side.name.unwrap_or_else(|| m.name.clone()),
                version: side.version,
                base: false,
                selected: selected == m.id,
                created: side.created,
                run: side.run,
                validation_wer: side.validation_wer,
            }
        })
        .collect();
    versions.sort_by(|a, b| {
        (a.version.unwrap_or(u32::MAX), &a.id).cmp(&(b.version.unwrap_or(u32::MAX), &b.id))
    });
    out.extend(versions);
    out
}

/// Indstillinger › Model › Versioner (run 6).
#[tauri::command]
#[specta::specta]
pub fn wt_model_versions(app: AppHandle) -> Vec<ModelVersion> {
    let Some(mm) = app.try_state::<Arc<ModelManager>>() else {
        return Vec::new();
    };
    let selected = crate::settings::get_settings(&app).selected_model;
    // The folder ModelManager::new uses.
    let Ok(dir) = crate::portable::app_data_dir(&app).map(|d| d.join("models")) else {
        return Vec::new();
    };
    list(&mm.get_available_models(), &selected, |id| {
        read_sidecar(&dir, id)
    })
}

/// `--use-model <id>` among a second instance's arguments.
pub fn use_model_arg(args: &[String]) -> Option<String> {
    args.iter().enumerate().find_map(|(i, a)| {
        if let Some(v) = a.strip_prefix("--use-model=") {
            return Some(v.to_string()).filter(|v| !v.is_empty());
        }
        (a == "--use-model")
            .then(|| args.get(i + 1))
            .flatten()
            .filter(|v| !v.starts_with("--"))
            .cloned()
    })
}

/// In the running app: switch, as picking it in Indstillinger › Model does,
/// off the main thread (loading takes a few seconds), and tell the screens.
pub fn use_model_running(app: &AppHandle, model_id: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = crate::commands::models::switch_active_model(&app, &model_id);
        match &result {
            Ok(()) => log::info!("Switched to {model_id} (--use-model)"),
            Err(e) => log::warn!("--use-model {model_id} failed: {e}"),
        }
        let _ = app.emit(
            "wt-model-switched",
            serde_json::json!({ "model_id": model_id, "error": result.err() }),
        );
    });
}

/// With no app running: save the selection for the next start, if the model
/// is installed. Returns the process's exit status.
pub fn use_model_offline(app: &AppHandle, model_id: &str) -> i32 {
    let mm = match ModelManager::new(app) {
        Ok(mm) => mm,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };
    match mm.get_model_info(model_id) {
        Some(m) if m.is_downloaded => {
            let mut settings = crate::settings::get_settings(app);
            settings.selected_model = model_id.to_string();
            crate::settings::write_settings(app, settings);
            println!("{model_id} is selected; WalkieTalkey uses it from its next start");
            0
        }
        Some(_) => {
            eprintln!("error: {model_id} is not installed");
            1
        }
        None => {
            eprintln!("error: no model {model_id}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managers::model::ModelInfo;

    fn model(id: &str, downloaded: bool) -> ModelInfo {
        ModelInfo {
            id: id.to_string(),
            name: format!("name of {id}"),
            description: String::new(),
            filename: format!("{id}.gguf"),
            source: crate::managers::model::ModelSource::Local,
            size_mb: 886,
            is_downloaded: downloaded,
            is_downloading: false,
            partial_size: 0,
            accuracy_score: 0.0,
            speed_score: 0.0,
            supports_translation: false,
            is_recommended: false,
            supported_languages: vec![],
            supports_language_selection: false,
            is_custom: true,
            supports_streaming: false,
            supports_language_detection: false,
        }
    }

    #[test]
    fn lists_the_base_then_the_installed_versions_by_number() {
        let models = vec![
            model("edda-ft-first-v2", true),
            model(
                "walkietalkey/ekko-v1-tiny-gguf/ekko-v1-tiny-Q8_0.gguf",
                true,
            ),
            model(DEFAULT_MODEL_ID, true),
            model("edda-ft-first-v1", true),
            model("edda-ft-gone-v3", false),
            model("edda-ft-handmade", true),
        ];
        let sidecar = |id: &str| match id {
            "edda-ft-first-v1" => Some(Sidecar {
                version: Some(1),
                name: Some("Edda finjusteret v1".into()),
                run: Some("first-20261025-1".into()),
                created: Some("2026-10-25T12:00:00+00:00".into()),
                validation_wer: Some(0.061),
            }),
            "edda-ft-first-v2" => Some(Sidecar {
                version: Some(2),
                ..Sidecar::default()
            }),
            _ => None,
        };
        let got = list(&models, "edda-ft-first-v2", sidecar);
        let ids: Vec<&str> = got.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                DEFAULT_MODEL_ID,
                "edda-ft-first-v1",
                "edda-ft-first-v2",
                "edda-ft-handmade"
            ]
        );
        assert!(got[0].base && got[0].version.is_none() && !got[0].selected);
        assert_eq!(got[1].name, "Edda finjusteret v1");
        assert_eq!(got[1].validation_wer, Some(0.061));
        assert_eq!(got[1].run.as_deref(), Some("first-20261025-1"));
        assert!(got[2].selected);
        // no sidecar: the GGUF's own name
        assert_eq!(got[3].name, "name of edda-ft-handmade");
        assert_eq!(got[3].version, None);
    }

    #[test]
    fn reads_the_workbench_sidecar() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(
            dir.path().join("edda-ft-a-v4.json"),
            r#"{"model_id": "edda-ft-a-v4", "version": 4, "name": "Edda v4", "run": "r", "created": "2026-10-25",
                "validation_wer": 0.05, "sha256": "ab", "registered_model": "edda-da", "base_repo": "x"}"#,
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let side = read_sidecar(dir.path(), "edda-ft-a-v4").unwrap_or_default();
        assert_eq!(side.version, Some(4));
        assert_eq!(side.validation_wer, Some(0.05));
        assert!(read_sidecar(dir.path(), "edda-ft-none").is_none());
    }

    #[test]
    fn finds_the_model_a_second_instance_asks_for() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            use_model_arg(&args(&["walkietalkey", "--use-model", "edda-ft-a-v2"])).as_deref(),
            Some("edda-ft-a-v2")
        );
        assert_eq!(
            use_model_arg(&args(&["walkietalkey", "--use-model=edda-ft-a-v2"])).as_deref(),
            Some("edda-ft-a-v2")
        );
        assert_eq!(use_model_arg(&args(&["walkietalkey", "--use-model"])), None);
        assert_eq!(use_model_arg(&args(&["walkietalkey", "--cancel"])), None);
    }
}
