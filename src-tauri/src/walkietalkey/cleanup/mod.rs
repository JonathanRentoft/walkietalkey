//! "Ryd op med AI" (spec 6.10). The engine (modes, markers, guardrails, the
//! per-chunk window, warm connection) is built here; until it is wired in,
//! cleanup is off and the local text goes out unchanged.

pub mod engine;
pub mod guardrails;
pub mod markers;
pub mod prompt;
pub mod provider;

use tauri::AppHandle;

use super::history::CleanupRecord;

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
    /// "Brugte teksten uden oprydning".
    FellBack,
}

/// Runs the cleanup step on the local text of a finished dictation.
pub async fn clean(_app: &AppHandle, _text: &str, _shift_held: bool) -> CleanupOutcome {
    CleanupOutcome::NotUsed
}
