//! WalkieTalkey's own settings (spec 6.14), stored next to Handy's in the same
//! store file under the key `walkietalkey`. Handy's settings keep what Handy
//! already has (key, sounds, pill position, start at login, model, model
//! unload, Ord); these are the rest. Managed values (Appendix B) are laid over
//! both at read time and are locked (DESK-101), see `managed`.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::pipeline::da::punctuation::PunctuationMode;
use crate::pipeline::da::vocabulary::Replacement;

/// Where a key dictation goes (DESK-50, DESK-51; managed `OutputMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum OutputMode {
    /// Indsæt automatisk.
    #[default]
    Paste,
    /// Kun udklipsholder.
    Clipboard,
}

/// "Ryd op med AI" (DESK-80; managed `CleanupMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum CleanupMode {
    /// Fra.
    #[default]
    Off,
    /// Når der er noget at rette.
    WhenNeeded,
    /// Altid.
    Always,
    /// Kun når jeg holder Shift med.
    Shift,
}

/// History retention (DESK-91; managed `HistoryRetentionDays`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum HistoryRetention {
    /// Gem ikke.
    DontKeep,
    /// 1 dag.
    Day,
    /// 14 dage.
    #[default]
    TwoWeeks,
    /// 90 dage.
    NinetyDays,
    /// Altid.
    Forever,
}

impl HistoryRetention {
    /// Days to keep, `None` for forever, `Some(0)` for not at all.
    pub fn days(self) -> Option<u32> {
        match self {
            Self::DontKeep => Some(0),
            Self::Day => Some(1),
            Self::TwoWeeks => Some(14),
            Self::NinetyDays => Some(90),
            Self::Forever => None,
        }
    }

    /// The setting for a managed `HistoryRetentionDays` value: 0 = Gem ikke,
    /// -1 = Altid, otherwise the nearest offered period at or above it.
    /// A managed `HistoryRetentionDays` (Appendix B). A retention period is
    /// a maximum, so other values round down to the periods the app offers.
    pub fn from_days(days: i64) -> Self {
        match days {
            d if d < 0 => Self::Forever,
            0 => Self::DontKeep,
            1..=13 => Self::Day,
            14..=89 => Self::TwoWeeks,
            _ => Self::NinetyDays,
        }
    }
}

/// Update channel (DESK-112; managed `UpdateChannel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

/// The public relay and phone app on walkietalkey.com (run 2). Both are
/// settings (Avanceret › relæ-adresse; managed `RelayUrl`, `PhoneAppUrl`),
/// never hard-coded elsewhere.
pub const DEFAULT_RELAY_URL: &str = "wss://relay.walkietalkey.com";
pub const DEFAULT_PHONE_APP_URL: &str = "https://app.walkietalkey.com";
/// v1's defaults, which still answer (the same Worker and Pages project), so
/// pairings made with them keep working; settings still on them move to the
/// new hosts once (`migrate`).
pub const V1_RELAY_URL: &str = "wss://walkietalkey-relay.jonathan0912.workers.dev";
pub const V1_PHONE_APP_URL: &str = "https://walkietalkey-app.pages.dev";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default)]
pub struct WtSettings {
    // Tekst
    pub output_mode: OutputMode,
    pub punctuation: PunctuationMode,
    /// "Del med mine andre enheder" (DESK-54): off keeps the clipboard on
    /// this computer only.
    pub share_clipboard_with_devices: bool,

    // Generelt
    /// "Vis teksten i notifikationen" (DESK-56).
    pub show_text_in_notifications: bool,
    /// "Vis aldrig" for the pill (DESK-55); its position is Handy's
    /// overlay_position.
    pub pill_hidden: bool,
    /// Show the pill for phone dictations too (DESK-58, on by default).
    pub pill_for_phone: bool,

    // Ordliste
    pub replacements: Vec<Replacement>,
    /// The built-in "Udviklerord" pack (DESK-67).
    pub developer_words: bool,
    /// Company word list, a path or an https URL (managed only, DESK-68).
    pub vocabulary_source: Option<String>,

    // Ryd op med AI
    pub cleanup_mode: CleanupMode,
    /// Provider id: apple, openai, anthropic, groq, cerebras, openrouter, custom.
    pub cleanup_provider: Option<String>,
    pub cleanup_model: Option<String>,
    /// For `custom` (any OpenAI-compatible endpoint, Azure OpenAI, Ollama).
    pub cleanup_base_url: Option<String>,
    /// Providers the user has agreed to send text to (DESK-82).
    pub cleanup_consented: Vec<String>,
    /// Managed `AllowCloudCleanup`: false allows only on-device cleanup.
    pub allow_cloud_cleanup: bool,

    // Telefon
    pub relay_url: String,
    pub phone_app_url: String,
    /// Managed `AllowPhonePairing`.
    pub allow_phone_pairing: bool,

    // Model
    /// Managed `ModelBaseUrl`; `None` is our Hugging Face organisation.
    pub model_base_url: Option<String>,

    // Historik
    pub history_retention: HistoryRetention,
    /// "Gem lyd til fejlfinding" (DESK-92), at most 7 days.
    pub keep_audio_for_debugging: bool,

    // Opdateringer
    pub auto_update: bool,
    pub update_channel: UpdateChannel,

    // Onboarding: the step to resume at after a restart (DESK-13).
    pub onboarding_resume_step: Option<String>,

    // Kept by the app itself; a save from the UI never changes these.
    /// Which defaults the stored settings were migrated to (`migrate`). A
    /// store written before the field existed reads as 0 (v1).
    #[serde(default)]
    pub settings_version: u32,
    /// "Ret det for mig" (DESK-20): WalkieTalkey set the Globe key to "Do
    /// Nothing" and restores `globe_key_previous` when fn stops being the key.
    pub globe_key_fixed: bool,
    /// The user's `AppleFnUsageType` before the fix; `None` when it was unset.
    pub globe_key_previous: Option<i64>,
    /// Accessibility was granted at least once (DESK-13). macOS drops the
    /// grant when an unsigned build's signature changes (an update) while
    /// System Settings still shows it on; this tells that apart from a
    /// first run.
    pub accessibility_granted_once: bool,
}

/// `onboarding_resume_step` once onboarding is finished (`ONBOARDING_DONE`
/// in `src/walkietalkey/lib/helpers.ts`).
pub const ONBOARDING_DONE: &str = "finished";

/// The defaults `WtSettings::default()` and `migrate` bring a store to.
pub const SETTINGS_VERSION: u32 = 2;

impl Default for WtSettings {
    fn default() -> Self {
        Self {
            output_mode: OutputMode::Paste,
            punctuation: PunctuationMode::Automatic,
            share_clipboard_with_devices: false,
            show_text_in_notifications: true,
            pill_hidden: false,
            pill_for_phone: true,
            replacements: Vec::new(),
            developer_words: true,
            vocabulary_source: None,
            cleanup_mode: CleanupMode::Off,
            cleanup_provider: None,
            cleanup_model: None,
            cleanup_base_url: None,
            cleanup_consented: Vec::new(),
            allow_cloud_cleanup: true,
            relay_url: DEFAULT_RELAY_URL.to_string(),
            phone_app_url: DEFAULT_PHONE_APP_URL.to_string(),
            allow_phone_pairing: true,
            model_base_url: None,
            history_retention: HistoryRetention::TwoWeeks,
            keep_audio_for_debugging: false,
            auto_update: true,
            update_channel: UpdateChannel::Stable,
            onboarding_resume_step: None,
            settings_version: SETTINGS_VERSION,
            globe_key_fixed: false,
            globe_key_previous: None,
            accessibility_granted_once: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_follow_the_spec() {
        let s = WtSettings::default();
        assert_eq!(s.output_mode, OutputMode::Paste, "DESK-50");
        assert_eq!(s.cleanup_mode, CleanupMode::Off, "DESK-80, PRIV-04");
        assert_eq!(s.history_retention, HistoryRetention::TwoWeeks, "DESK-91");
        assert!(!s.keep_audio_for_debugging, "DESK-92");
        assert!(!s.share_clipboard_with_devices, "DESK-54");
        assert!(s.show_text_in_notifications, "DESK-56");
        assert!(s.auto_update, "DESK-111");
        assert_eq!(s.update_channel, UpdateChannel::Stable);
        assert!(s.relay_url.starts_with("wss://"), "SEC-06");
        assert!(s.phone_app_url.starts_with("https://"));
        assert!(
            s.pill_for_phone,
            "DESK-58: the pill shows for phone dictations"
        );
        assert!(s.developer_words, "DESK-67: Udviklerord on by default");
        assert_eq!(s.settings_version, SETTINGS_VERSION);
        assert!(!s.globe_key_fixed);
    }

    #[test]
    fn a_v1_store_reads_as_version_zero() {
        // v1 wrote pill_for_phone and developer_words as false and had no
        // settings_version: that is what `migrate` recognises.
        let s: WtSettings = serde_json::from_value(serde_json::json!({
            "pill_for_phone": false,
            "developer_words": false
        }))
        .unwrap();
        assert_eq!(s.settings_version, 0);
        assert!(!s.pill_for_phone);
    }

    #[test]
    fn a_partial_store_keeps_defaults_for_missing_fields() {
        let s: WtSettings = serde_json::from_value(serde_json::json!({
            "cleanup_mode": "when-needed",
            "unknown_future_field": 1
        }))
        .unwrap();
        assert_eq!(s.cleanup_mode, CleanupMode::WhenNeeded);
        assert_eq!(s.relay_url, DEFAULT_RELAY_URL);
    }

    #[test]
    fn managed_retention_days_map_to_the_offered_periods() {
        assert_eq!(HistoryRetention::from_days(0), HistoryRetention::DontKeep);
        assert_eq!(HistoryRetention::from_days(-1), HistoryRetention::Forever);
        assert_eq!(HistoryRetention::from_days(14), HistoryRetention::TwoWeeks);
        // A policy is a maximum: other values round down.
        assert_eq!(HistoryRetention::from_days(2), HistoryRetention::Day);
        assert_eq!(HistoryRetention::from_days(30), HistoryRetention::TwoWeeks);
        assert_eq!(
            HistoryRetention::from_days(365),
            HistoryRetention::NinetyDays
        );
        assert_eq!(HistoryRetention::TwoWeeks.days(), Some(14));
        assert_eq!(HistoryRetention::Forever.days(), None);
    }

    #[test]
    fn cleanup_modes_use_the_managed_spelling() {
        let modes: Vec<CleanupMode> =
            serde_json::from_str(r#"["off","when-needed","always","shift"]"#).unwrap();
        assert_eq!(
            modes,
            vec![
                CleanupMode::Off,
                CleanupMode::WhenNeeded,
                CleanupMode::Always,
                CleanupMode::Shift
            ]
        );
    }
}
