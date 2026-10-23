//! Managed settings for companies (spec 6.15, Appendix B). The platform store
//! (macOS managed preferences for `com.walkietalkey.app` via CFPreferences,
//! Windows `HKLM\SOFTWARE\Policies\WalkieTalkey`) is read into
//! [`ManagedValues`]; [`apply`] lays them over the user's settings. One rule
//! (DESK-101): every managed value is locked, wins over the user's value, and
//! the UI shows a lock with "Styret af din organisation".

use std::collections::BTreeMap;

use serde::Serialize;
use specta::Type;

use super::settings::{CleanupMode, HistoryRetention, OutputMode, UpdateChannel, WtSettings};
use crate::settings::AppSettings;

/// A value as the platform store holds it: plist strings, booleans and
/// integers; registry REG_SZ and REG_DWORD.
#[derive(Debug, Clone, PartialEq)]
pub enum ManagedValue {
    Text(String),
    Bool(bool),
    Int(i64),
}

impl ManagedValue {
    fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            Self::Int(0) => Some(false),
            Self::Int(1) => Some(true),
            Self::Text(t) => match t.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" => Some(true),
                "false" | "0" | "no" => Some(false),
                _ => None,
            },
            Self::Int(_) => None,
        }
    }

    fn as_text(&self) -> Option<String> {
        match self {
            Self::Text(t) if !t.trim().is_empty() => Some(t.trim().to_string()),
            _ => None,
        }
    }

    fn as_int(&self) -> Option<i64> {
        match self {
            Self::Int(i) => Some(*i),
            Self::Text(t) => t.trim().parse().ok(),
            Self::Bool(_) => None,
        }
    }
}

/// The managed values found, by Appendix B key.
pub type ManagedValues = BTreeMap<String, ManagedValue>;

/// Every Appendix B key, the same names on macOS and Windows.
pub const KEYS: &[&str] = &[
    "RelayUrl",
    "PhoneAppUrl",
    "ModelBaseUrl",
    "AllowPhonePairing",
    "CleanupMode",
    "CleanupProvider",
    "AllowCloudCleanup",
    "CleanupBaseUrl",
    "CleanupModel",
    "CleanupApiKey",
    "VocabularySource",
    "OutputMode",
    "ShowTextInNotifications",
    "HistoryRetentionDays",
    "AutoUpdate",
    "UpdateChannel",
    "Model",
];

/// Cleanup providers a company may force (Appendix B `CleanupProvider`).
const PROVIDERS: &[&str] = &[
    "apple",
    "openai",
    "anthropic",
    "groq",
    "cerebras",
    "openrouter",
    "custom",
];

/// What applying the managed values did.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Type)]
pub struct Applied {
    /// Settings fields that are locked, by their field names in WtSettings or
    /// Handy's settings (`relay_url`, `selected_model`, `cleanup_api_key`...).
    pub locked: Vec<String>,
    /// Managed keys whose value could not be used, with why. Logged; never
    /// locked, so the user's own value stays.
    pub rejected: Vec<(String, String)>,
    /// `CleanupApiKey`: read from the profile at each start and never copied
    /// elsewhere, so it lives only here, in memory.
    #[serde(skip)]
    pub cleanup_api_key: Option<String>,
}

fn url_ok(url: &str, scheme: &str) -> bool {
    url.strip_prefix(scheme)
        .is_some_and(|rest| rest.len() > 1 && !rest.contains(char::is_whitespace))
}

/// Lays `values` over `wt` and `handy`, returning what is locked.
pub fn apply(values: &ManagedValues, wt: &mut WtSettings, handy: &mut AppSettings) -> Applied {
    let mut applied = Applied::default();
    for (key, value) in values {
        let result: Result<&[&str], String> = match key.as_str() {
            "RelayUrl" => match value.as_text() {
                // SEC-06: only wss://.
                Some(url) if url_ok(&url, "wss://") => {
                    wt.relay_url = url;
                    Ok(&["relay_url"])
                }
                _ => Err("must be a wss:// URL".into()),
            },
            "PhoneAppUrl" => match value.as_text() {
                Some(url) if url_ok(&url, "https://") => {
                    wt.phone_app_url = url;
                    Ok(&["phone_app_url"])
                }
                _ => Err("must be an https:// URL".into()),
            },
            "ModelBaseUrl" => match value.as_text() {
                Some(url) if url_ok(&url, "https://") => {
                    wt.model_base_url = Some(url);
                    Ok(&["model_base_url"])
                }
                _ => Err("must be an https:// URL".into()),
            },
            "AllowPhonePairing" => value
                .as_bool()
                .map(|b| {
                    wt.allow_phone_pairing = b;
                    &["allow_phone_pairing"][..]
                })
                .ok_or_else(|| "must be a boolean".into()),
            "CleanupMode" => match value.as_text().as_deref() {
                Some("off") => Ok(CleanupMode::Off),
                Some("when-needed") => Ok(CleanupMode::WhenNeeded),
                Some("always") => Ok(CleanupMode::Always),
                Some("shift") => Ok(CleanupMode::Shift),
                _ => Err("must be off, when-needed, always or shift".to_string()),
            }
            .map(|mode| {
                wt.cleanup_mode = mode;
                &["cleanup_mode"][..]
            }),
            "CleanupProvider" => match value.as_text() {
                Some(p) if PROVIDERS.contains(&p.as_str()) => {
                    wt.cleanup_provider = Some(p);
                    Ok(&["cleanup_provider"])
                }
                _ => Err(format!("must be one of {}", PROVIDERS.join(", "))),
            },
            "AllowCloudCleanup" => value
                .as_bool()
                .map(|b| {
                    wt.allow_cloud_cleanup = b;
                    &["allow_cloud_cleanup"][..]
                })
                .ok_or_else(|| "must be a boolean".into()),
            "CleanupBaseUrl" => match value.as_text() {
                Some(url)
                    if url_ok(&url, "https://")
                        || (url_ok(&url, "http://")
                            && super::cleanup::provider::is_local_url(&url)) =>
                {
                    wt.cleanup_base_url = Some(url);
                    Ok(&["cleanup_base_url"])
                }
                _ => Err("must be an https:// URL (or http://localhost)".into()),
            },
            "CleanupModel" => value
                .as_text()
                .map(|m| {
                    wt.cleanup_model = Some(m);
                    &["cleanup_model"][..]
                })
                .ok_or_else(|| "must be a model name".into()),
            "CleanupApiKey" => value
                .as_text()
                .map(|k| {
                    applied.cleanup_api_key = Some(k);
                    &["cleanup_api_key"][..]
                })
                .ok_or_else(|| "must be a key".into()),
            "VocabularySource" => match value.as_text() {
                Some(src) if url_ok(&src, "https://") || !src.contains("://") => {
                    wt.vocabulary_source = Some(src);
                    Ok(&["vocabulary_source"])
                }
                _ => Err("must be a path or an https:// URL".into()),
            },
            "OutputMode" => match value.as_text().as_deref() {
                Some("paste") => Ok(OutputMode::Paste),
                Some("clipboard") => Ok(OutputMode::Clipboard),
                _ => Err("must be paste or clipboard".to_string()),
            }
            .map(|mode| {
                wt.output_mode = mode;
                &["output_mode"][..]
            }),
            "ShowTextInNotifications" => value
                .as_bool()
                .map(|b| {
                    wt.show_text_in_notifications = b;
                    &["show_text_in_notifications"][..]
                })
                .ok_or_else(|| "must be a boolean".into()),
            "HistoryRetentionDays" => value
                .as_int()
                .map(|days| {
                    wt.history_retention = HistoryRetention::from_days(days);
                    &["history_retention"][..]
                })
                .ok_or_else(|| "must be a whole number of days".into()),
            "AutoUpdate" => value
                .as_bool()
                .map(|b| {
                    wt.auto_update = b;
                    handy.update_checks_enabled = b;
                    &["auto_update", "update_checks_enabled"][..]
                })
                .ok_or_else(|| "must be a boolean".into()),
            "UpdateChannel" => match value.as_text().as_deref() {
                Some("stable") => Ok(UpdateChannel::Stable),
                Some("beta") => Ok(UpdateChannel::Beta),
                _ => Err("must be stable or beta".to_string()),
            }
            .map(|channel| {
                wt.update_channel = channel;
                &["update_channel"][..]
            }),
            "Model" => value
                .as_text()
                .map(|model| {
                    handy.selected_model = model;
                    &["selected_model"][..]
                })
                .ok_or_else(|| "must be a model id".into()),
            other => Err(format!("unknown key {other}")),
        };
        match result {
            Ok(fields) => applied.locked.extend(fields.iter().map(|f| f.to_string())),
            Err(why) => applied.rejected.push((key.clone(), why)),
        }
    }
    applied.locked.sort();
    applied.locked.dedup();
    // Cloud cleanup forbidden: only on-device providers stay usable.
    if !wt.allow_cloud_cleanup {
        let on_device = match wt.cleanup_provider.as_deref() {
            Some("apple") => true,
            Some("custom") => wt
                .cleanup_base_url
                .as_deref()
                .is_some_and(super::cleanup::provider::is_local_url),
            _ => false,
        };
        if !on_device {
            wt.cleanup_mode = CleanupMode::Off;
        }
    }
    applied
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;

    fn managed(pairs: &[(&str, ManagedValue)]) -> ManagedValues {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn text(s: &str) -> ManagedValue {
        ManagedValue::Text(s.into())
    }

    #[test]
    fn every_managed_value_wins_and_is_locked() {
        let mut wt = WtSettings::default();
        let mut handy = get_default_settings();
        let values = managed(&[
            ("RelayUrl", text("wss://relay.firma.dk")),
            ("PhoneAppUrl", text("https://diktat.firma.dk")),
            ("ModelBaseUrl", text("https://modeller.firma.dk/wt")),
            ("AllowPhonePairing", ManagedValue::Bool(false)),
            ("CleanupMode", text("always")),
            ("CleanupProvider", text("custom")),
            ("CleanupBaseUrl", text("https://firma.openai.azure.com/v1")),
            ("CleanupModel", text("gpt-4o-mini")),
            ("CleanupApiKey", text("sk-company")),
            ("VocabularySource", text("https://intra.firma.dk/ord.txt")),
            ("OutputMode", text("clipboard")),
            ("ShowTextInNotifications", ManagedValue::Int(0)),
            ("HistoryRetentionDays", ManagedValue::Int(-1)),
            ("AutoUpdate", ManagedValue::Bool(false)),
            ("UpdateChannel", text("beta")),
            ("Model", text("edda-v0.2-Q8_0")),
        ]);
        let applied = apply(&values, &mut wt, &mut handy);
        assert!(applied.rejected.is_empty(), "{:?}", applied.rejected);
        assert_eq!(wt.relay_url, "wss://relay.firma.dk");
        assert_eq!(wt.phone_app_url, "https://diktat.firma.dk");
        assert!(!wt.allow_phone_pairing);
        assert_eq!(wt.cleanup_mode, CleanupMode::Always);
        assert_eq!(wt.output_mode, OutputMode::Clipboard);
        assert!(!wt.show_text_in_notifications);
        assert_eq!(wt.history_retention, HistoryRetention::Forever);
        assert!(!wt.auto_update && !handy.update_checks_enabled);
        assert_eq!(wt.update_channel, UpdateChannel::Beta);
        assert_eq!(handy.selected_model, "edda-v0.2-Q8_0");
        assert_eq!(applied.cleanup_api_key.as_deref(), Some("sk-company"));
        for field in [
            "relay_url",
            "selected_model",
            "cleanup_api_key",
            "update_checks_enabled",
        ] {
            assert!(
                applied.locked.contains(&field.to_string()),
                "{field} locked"
            );
        }
        // Every Appendix B key was handled.
        assert_eq!(
            values.len(),
            KEYS.len() - 1,
            "all but AllowCloudCleanup used here"
        );
    }

    #[test]
    fn invalid_values_are_rejected_not_locked() {
        let mut wt = WtSettings::default();
        let mut handy = get_default_settings();
        let values = managed(&[
            ("RelayUrl", text("ws://insecure.example")),
            ("CleanupMode", text("sometimes")),
            ("AllowPhonePairing", text("maybe")),
            ("Bogus", text("x")),
        ]);
        let applied = apply(&values, &mut wt, &mut handy);
        assert!(applied.locked.is_empty());
        assert_eq!(applied.rejected.len(), 4);
        assert_eq!(wt, WtSettings::default(), "user values untouched");
    }

    #[test]
    fn forbidding_cloud_cleanup_keeps_only_on_device_providers() {
        let values = managed(&[("AllowCloudCleanup", ManagedValue::Bool(false))]);

        let mut wt = WtSettings {
            cleanup_mode: CleanupMode::Always,
            cleanup_provider: Some("openai".into()),
            ..WtSettings::default()
        };
        apply(&values, &mut wt, &mut get_default_settings());
        assert_eq!(wt.cleanup_mode, CleanupMode::Off);

        let mut wt = WtSettings {
            cleanup_mode: CleanupMode::Always,
            cleanup_provider: Some("apple".into()),
            ..WtSettings::default()
        };
        apply(&values, &mut wt, &mut get_default_settings());
        assert_eq!(wt.cleanup_mode, CleanupMode::Always);

        let mut wt = WtSettings {
            cleanup_mode: CleanupMode::WhenNeeded,
            cleanup_provider: Some("custom".into()),
            cleanup_base_url: Some("http://localhost:11434/v1".into()),
            ..WtSettings::default()
        };
        apply(&values, &mut wt, &mut get_default_settings());
        assert_eq!(wt.cleanup_mode, CleanupMode::WhenNeeded);
    }

    #[test]
    fn registry_and_plist_value_shapes_are_understood() {
        assert_eq!(ManagedValue::Int(1).as_bool(), Some(true));
        assert_eq!(text("false").as_bool(), Some(false));
        assert_eq!(text("14").as_int(), Some(14));
        assert_eq!(text("  ").as_text(), None);
    }
}
