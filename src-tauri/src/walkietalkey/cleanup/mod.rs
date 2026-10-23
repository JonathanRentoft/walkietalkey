//! "Ryd op med AI" (spec 6.10): optional, off by default, and the only step
//! that may use the network. Modes (DESK-80): Fra, Når der er noget at rette,
//! Altid, Kun når jeg holder Shift med. A cloud provider is only used after
//! the user agreed to "Teksten (ikke lyden) sendes til <udbyder>, hver gang
//! du dikterer." (DESK-82), or when the organisation configured it.

pub mod engine;
pub mod guardrails;
pub mod keys;
pub mod markers;
pub mod prompt;
pub mod provider;

use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use tauri::AppHandle;

use self::engine::{ChunkCleaner, Cleaned};
use self::provider::{AppleProvider, Format, HttpProvider, Provider};
use super::history::CleanupRecord;
use super::settings::CleanupMode;
use crate::managers::transcription::chunked::ChunkObserver;
use crate::settings::PostProcessApiFormat;

/// What the cleanup step did with a dictation's text.
#[derive(Debug, Clone, PartialEq)]
pub enum CleanupOutcome {
    /// Cleanup is off, or nothing needed fixing ("Når der er noget at rette").
    NotUsed,
    /// The provider's text passed the guardrails.
    Cleaned {
        text: String,
        /// For a cloud provider: what was sent, where, and how long it took.
        record: Option<CleanupRecord>,
    },
    /// A guardrail fired (DESK-84): the local text is used and the pill says
    /// "Brugte teksten uden oprydning". `record` is what was still sent.
    FellBack { record: Option<CleanupRecord> },
}

struct Plan {
    provider: Arc<dyn Provider>,
    only_when_needed: bool,
}

/// Whether a mode cleans this dictation, and if so whether only when there
/// is something to fix (DESK-80). `shift_held` is `None` while recording.
pub(crate) fn mode_applies(mode: CleanupMode, shift_held: Option<bool>) -> Option<bool> {
    match mode {
        CleanupMode::Off => None,
        CleanupMode::Shift if shift_held != Some(true) => None,
        CleanupMode::Shift | CleanupMode::Always => Some(false),
        CleanupMode::WhenNeeded => Some(true),
    }
}

/// Whether text may go to a cloud provider (DESK-82, Appendix B).
pub(crate) fn cloud_allowed(allow_cloud: bool, managed_provider: bool, consented: bool) -> bool {
    allow_cloud && (managed_provider || consented)
}

/// What a consent covers (DESK-82): the provider, and for a custom endpoint
/// also its host, so text never goes to a new destination unasked. The
/// settings screen builds the same key.
pub(crate) fn consent_key(id: &str, custom_base_url: Option<&str>) -> String {
    if id != "custom" {
        return id.to_string();
    }
    let host = custom_base_url
        .and_then(|url| tauri::Url::parse(url.trim()).ok())
        .map(|url| {
            let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
            match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            }
        })
        .unwrap_or_default();
    format!("custom:{host}")
}

/// The provider to use now, if cleanup applies. `shift_held` is `None` when
/// it is not known yet (while recording).
fn plan(app: &AppHandle, shift_held: Option<bool>) -> Option<Plan> {
    let (wt, applied) = super::store::effective(app);
    let only_when_needed = mode_applies(wt.cleanup_mode, shift_held)?;
    let id = wt.cleanup_provider.clone()?;
    let provider: Arc<dyn Provider> = if id == "apple" {
        Arc::new(AppleProvider)
    } else {
        let handy = crate::settings::get_settings(app);
        let preset = handy.post_process_providers.iter().find(|p| p.id == id)?;
        let base_url = if id == "custom" {
            wt.cleanup_base_url
                .clone()
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| preset.base_url.clone())
        } else {
            preset.base_url.clone()
        };
        let model = wt
            .cleanup_model
            .clone()
            .or_else(|| handy.post_process_models.get(&id).cloned())
            .filter(|m| !m.is_empty())?;
        // A company's key goes only to the provider (and endpoint) the
        // company chose, never to one the user picked (Appendix B).
        let managed_endpoint =
            id != "custom" || applied.locked.iter().any(|f| f == "cleanup_base_url");
        let company_key = applied
            .cleanup_api_key
            .clone()
            .filter(|_| applied.locked.iter().any(|f| f == "cleanup_provider") && managed_endpoint);
        let api_key = company_key.or_else(|| keys::get(&id));
        Arc::new(HttpProvider {
            label: preset.label.clone(),
            base_url,
            model,
            api_key,
            format: match preset.api_format {
                PostProcessApiFormat::Anthropic => Format::Anthropic,
                PostProcessApiFormat::OpenAi => Format::OpenAi,
            },
            id: id.clone(),
        })
    };
    let managed = applied.locked.iter().any(|f| f == "cleanup_provider");
    let consented = wt
        .cleanup_consented
        .contains(&consent_key(&id, wt.cleanup_base_url.as_deref()));
    if provider.is_cloud() && !cloud_allowed(wt.allow_cloud_cleanup, managed, consented) {
        return None;
    }
    Some(Plan {
        provider,
        only_when_needed,
    })
}

/// The cleaner following the key recording's chunks (DESK-47).
static KEY_CLEANER: Lazy<Mutex<Option<Arc<ChunkCleaner>>>> = Lazy::new(|| Mutex::new(None));

/// For the key recording's live decode: cleans each chunk while the user
/// talks, when a mode other than Shift is active (Shift is only known at
/// release).
pub(crate) fn key_chunk_observer(app: &AppHandle) -> Option<ChunkObserver> {
    // A new recording never inherits an earlier one's cleaned chunks.
    forget_key_cleaner();
    let plan = plan(app, None)?;
    let cleaner = Arc::new(ChunkCleaner::new(plan.provider, plan.only_when_needed));
    *KEY_CLEANER.lock().unwrap() = Some(Arc::clone(&cleaner));
    let app = app.clone();
    Some(Arc::new(move |raw: &str| {
        cleaner.push(local_chunk_text(&app, raw))
    }))
}

/// Drops the key recording's chunk cleaner (a cancel, or a new recording).
pub fn forget_key_cleaner() {
    KEY_CLEANER.lock().unwrap().take();
}

/// A chunk's text after the local steps (filler words, replacements), as
/// the whole dictation gets them.
fn local_chunk_text(app: &AppHandle, raw: &str) -> String {
    use crate::audio_toolkit::{
        normalize_transcription_output, remove_filler_words, OutputLanguageEvidence,
    };
    let settings = crate::settings::get_settings(app);
    // Punctuation before filler removal, in the whole dictation's order (DESK-41).
    let punctuated = super::punctuation::apply(app, raw.to_string());
    let without_fillers = remove_filler_words(
        &punctuated,
        &OutputLanguageEvidence::UserSelected(settings.selected_language.clone()),
        &settings.custom_filler_words,
        settings.filler_word_removal_enabled,
    );
    let normalised = normalize_transcription_output(&without_fillers);
    super::output::local_text(&normalised, &super::store::get(app))
}

/// Opens the connection to the provider while the user talks (DESK-87).
pub fn warm(app: &AppHandle) {
    if let Some(plan) = plan(app, Some(true)) {
        plan.provider.warm();
    }
}

fn outcome(cleaned: Cleaned) -> CleanupOutcome {
    if !cleaned.called {
        CleanupOutcome::NotUsed
    } else if cleaned.fell_back {
        CleanupOutcome::FellBack {
            record: cleaned.record,
        }
    } else {
        CleanupOutcome::Cleaned {
            text: cleaned.text,
            record: cleaned.record,
        }
    }
}

/// Runs the cleanup step on a finished dictation's local text. A key
/// dictation uses the chunk-by-chunk result when there is one.
pub async fn clean(
    app: &AppHandle,
    text: &str,
    key_dictation: bool,
    shift_held: bool,
) -> CleanupOutcome {
    let live = if key_dictation {
        KEY_CLEANER.lock().unwrap().take()
    } else {
        None
    };
    let Some(plan) = plan(app, Some(shift_held)) else {
        return CleanupOutcome::NotUsed;
    };
    if let Some(cleaner) = live {
        let cleaned = cleaner.finish().await;
        // The live result covers the chunks; trust it only if it saw text.
        if !cleaned.text.trim().is_empty() {
            return outcome(cleaned);
        }
    }
    if plan.only_when_needed && !markers::needs_cleanup(text) {
        return CleanupOutcome::NotUsed;
    }
    outcome(engine::clean_once(plan.provider.as_ref(), text).await)
}

/// Whether Shift is held right now (for "Kun når jeg holder Shift med").
pub fn shift_held() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventSourceFlagsState(state_id: i32) -> u64;
        }
        // kCGEventSourceStateCombinedSessionState = 0, kCGEventFlagMaskShift.
        unsafe { CGEventSourceFlagsState(0) & 0x0002_0000 != 0 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        wt_native::keyboard::shift_down()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_for_a_custom_endpoint_covers_only_its_host() {
        assert_eq!(consent_key("openai", None), "openai");
        assert_eq!(
            consent_key("custom", Some("https://Firma.openai.azure.com/v1")),
            "custom:firma.openai.azure.com"
        );
        assert_eq!(
            consent_key("custom", Some("http://gpu.lan:8080/v1")),
            "custom:gpu.lan:8080"
        );
        assert_ne!(
            consent_key("custom", Some("https://a.example/v1")),
            consent_key("custom", Some("https://b.example/v1"))
        );
    }

    #[test]
    fn every_mode_decides_as_the_spec_says() {
        assert_eq!(mode_applies(CleanupMode::Off, Some(true)), None, "Fra");
        assert_eq!(
            mode_applies(CleanupMode::Always, None),
            Some(false),
            "Altid"
        );
        assert_eq!(
            mode_applies(CleanupMode::WhenNeeded, None),
            Some(true),
            "Når der er noget at rette"
        );
        assert_eq!(
            mode_applies(CleanupMode::Shift, Some(true)),
            Some(false),
            "Shift held"
        );
        assert_eq!(
            mode_applies(CleanupMode::Shift, Some(false)),
            None,
            "Shift not held"
        );
        assert_eq!(
            mode_applies(CleanupMode::Shift, None),
            None,
            "not known while recording"
        );
    }

    #[test]
    fn cloud_text_needs_consent_or_the_organisation() {
        assert!(!cloud_allowed(true, false, false), "no consent yet");
        assert!(cloud_allowed(true, false, true));
        assert!(cloud_allowed(true, true, false), "managed provider");
        assert!(!cloud_allowed(false, true, true), "AllowCloudCleanup=false");
    }
}
