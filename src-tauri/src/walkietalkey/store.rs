//! Reading and writing [`WtSettings`] with the managed overlay applied.
//! Managed values are read once at start (DESK-100) and kept in memory; the
//! managed API key is never written anywhere (Appendix B `CleanupApiKey`).

use std::sync::RwLock;

use log::{info, warn};
use once_cell::sync::Lazy;
use serde::Serialize;
use specta::Type;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use super::managed::{self, Applied, ManagedValues};
use super::settings::WtSettings;
use crate::settings::{AppSettings, SETTINGS_STORE_PATH};

const STORE_KEY: &str = "walkietalkey";

static MANAGED: Lazy<RwLock<ManagedValues>> = Lazy::new(|| RwLock::new(ManagedValues::new()));

/// Sets the managed values found in the platform store. Called at start.
pub fn set_managed_values(values: ManagedValues) {
    if !values.is_empty() {
        info!(
            "Managed settings found: {}",
            values.keys().cloned().collect::<Vec<_>>().join(", ")
        );
    }
    *MANAGED.write().unwrap() = values;
}

fn managed_values() -> ManagedValues {
    MANAGED.read().unwrap().clone()
}

/// The user's own WalkieTalkey settings, without the managed overlay.
fn user_settings(app: &AppHandle) -> WtSettings {
    let Ok(store) = app.store(crate::portable::store_path(SETTINGS_STORE_PATH)) else {
        return WtSettings::default();
    };
    match store.get(STORE_KEY) {
        Some(value) => serde_json::from_value(value).unwrap_or_else(|e| {
            warn!("Stored WalkieTalkey settings could not be read ({e}); using defaults");
            WtSettings::default()
        }),
        None => WtSettings::default(),
    }
}

/// The settings in effect, and what the organisation locked.
pub fn effective(app: &AppHandle) -> (WtSettings, Applied) {
    let mut wt = user_settings(app);
    let mut handy = crate::settings::get_default_settings();
    let applied = managed::apply(&managed_values(), &mut wt, &mut handy);
    (wt, applied)
}

/// The WalkieTalkey settings in effect.
pub fn get(app: &AppHandle) -> WtSettings {
    effective(app).0
}

/// Lays the managed values that belong to Handy's settings (Model,
/// AutoUpdate) over them. Called from `settings::get_settings`.
pub fn overlay_handy(settings: &mut AppSettings) {
    let values = managed_values();
    if values.is_empty() {
        return;
    }
    let mut scratch = WtSettings::default();
    managed::apply(&values, &mut scratch, settings);
}

/// The other half of [`overlay_handy`], for a write of Handy's settings:
/// a locked field keeps the user's own stored value, so a managed value is
/// never saved as the user's and nothing sticks once the profile is gone
/// (DESK-101).
pub fn restore_handy_locked(new: &mut AppSettings, stored: &AppSettings) {
    restore_handy_locked_with(&managed_values(), new, stored);
}

fn restore_handy_locked_with(values: &ManagedValues, new: &mut AppSettings, stored: &AppSettings) {
    if values.is_empty() {
        return;
    }
    let mut scratch_wt = WtSettings::default();
    let mut scratch_handy = new.clone();
    let applied = managed::apply(values, &mut scratch_wt, &mut scratch_handy);
    for field in &applied.locked {
        match field.as_str() {
            "selected_model" => new.selected_model = stored.selected_model.clone(),
            "update_checks_enabled" => new.update_checks_enabled = stored.update_checks_enabled,
            _ => {}
        }
    }
}

/// The settings and their locks, as the settings screens get them.
#[derive(Debug, Clone, Serialize, Type)]
pub struct WtSettingsView {
    pub settings: WtSettings,
    /// Locked field names: show a lock and "Styret af din organisation".
    pub locked: Vec<String>,
    /// A managed API key is in use for cleanup (its value is never shown).
    pub managed_api_key: bool,
}

pub fn view(app: &AppHandle) -> WtSettingsView {
    let (settings, applied) = effective(app);
    WtSettingsView {
        settings,
        locked: applied.locked,
        managed_api_key: applied.cleanup_api_key.is_some(),
    }
}

/// Stores the user's settings. Locked fields keep the user's previous value
/// (the managed one shows anyway), so a managed setting can never be changed
/// from the app (DESK-101).
pub fn update(app: &AppHandle, mut new: WtSettings) -> Result<WtSettingsView, String> {
    let previous = user_settings(app);
    let (_, applied) = effective(app);
    restore_locked(&mut new, &previous, &applied.locked);
    let store = app
        .store(crate::portable::store_path(SETTINGS_STORE_PATH))
        .map_err(|e| e.to_string())?;
    store.set(
        STORE_KEY,
        serde_json::to_value(&new).map_err(|e| e.to_string())?,
    );
    Ok(view(app))
}

/// Puts back the previous user value of every locked field.
fn restore_locked(new: &mut WtSettings, previous: &WtSettings, locked: &[String]) {
    let mut new_json = serde_json::to_value(&*new).expect("settings serialize");
    let previous_json = serde_json::to_value(previous).expect("settings serialize");
    if let (Some(new_map), Some(previous_map)) =
        (new_json.as_object_mut(), previous_json.as_object())
    {
        for field in locked {
            if let Some(value) = previous_map.get(field) {
                new_map.insert(field.clone(), value.clone());
            }
        }
    }
    *new = serde_json::from_value(new_json).expect("settings deserialize");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::walkietalkey::settings::CleanupMode;

    #[test]
    fn locked_fields_keep_the_previous_user_value() {
        let previous = WtSettings::default();
        let mut new = WtSettings {
            relay_url: "wss://someone-else.example".into(),
            cleanup_mode: CleanupMode::Always,
            ..WtSettings::default()
        };
        restore_locked(&mut new, &previous, &["relay_url".to_string()]);
        assert_eq!(new.relay_url, previous.relay_url, "locked");
        assert_eq!(new.cleanup_mode, CleanupMode::Always, "not locked");
    }

    #[test]
    fn managed_handy_values_are_never_written_as_the_users() {
        use crate::walkietalkey::managed::ManagedValue;
        let values: ManagedValues = [
            (
                "Model".to_string(),
                ManagedValue::Text("company/model.gguf".into()),
            ),
            ("AutoUpdate".to_string(), ManagedValue::Bool(false)),
        ]
        .into_iter()
        .collect();
        let mut stored = crate::settings::get_default_settings();
        stored.selected_model = "mine.gguf".into();
        stored.update_checks_enabled = true;
        // What get_settings handed out, with the managed values laid over.
        let mut written = stored.clone();
        written.selected_model = "company/model.gguf".into();
        written.update_checks_enabled = false;
        written.audio_feedback = !stored.audio_feedback;
        restore_handy_locked_with(&values, &mut written, &stored);
        assert_eq!(written.selected_model, "mine.gguf");
        assert!(written.update_checks_enabled);
        assert_eq!(written.audio_feedback, !stored.audio_feedback, "not locked");
    }
}
