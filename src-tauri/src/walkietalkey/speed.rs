//! Model choice by measured speed (DESK-31): after the download, the app
//! transcribes a bundled 10-second Danish clip. If Edda needs 1.5 s or less
//! it stays the default; if it needs more (older or CPU-only machines), the
//! app offers the fast model and says why in one sentence.

use serde::Serialize;
use specta::Type;

/// Edda's limit for the bundled 10-second clip.
pub const EDDA_LIMIT_SECS: f64 = 1.5;

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct SpeedVerdict {
    pub seconds: f64,
    /// Offer the fast model instead of Edda.
    pub offer_fast_model: bool,
    /// The one sentence the UI shows when it offers the fast model.
    pub reason: Option<String>,
}

pub fn verdict(seconds: f64, fast_model_available: bool) -> SpeedVerdict {
    let slow = seconds > EDDA_LIMIT_SECS;
    SpeedVerdict {
        seconds,
        offer_fast_model: slow && fast_model_available,
        // The sentence that explains the offer.
        reason: (slow && fast_model_available).then(|| {
            let danish_seconds = format!("{seconds:.1}").replace('.', ",");
            format!(
                "Din computer brugte {danish_seconds} sekunder på 10 sekunders tale, så en hurtigere model giver dig teksten hurtigere."
            )
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edda_stays_when_it_is_fast_enough() {
        let v = verdict(0.9, true);
        assert!(!v.offer_fast_model);
        assert!(v.reason.is_none());
        assert!(!verdict(1.5, true).offer_fast_model, "1.5 s is still fine");
    }

    #[test]
    fn slow_machines_are_offered_the_fast_model_with_a_reason() {
        let v = verdict(3.2, true);
        assert!(v.offer_fast_model);
        let reason = v.reason.unwrap();
        assert!(reason.contains("3,2 sekunder"), "{reason}");
        assert!(reason.ends_with("hurtigere."), "{reason}");
    }

    #[test]
    fn without_a_fast_model_nothing_is_offered() {
        assert!(!verdict(5.0, false).offer_fast_model);
    }
}
