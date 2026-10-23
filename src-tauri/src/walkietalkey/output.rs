//! What happens to a dictation's text after recognition (spec 6.4 steps 6-8,
//! 6.6, 6.7). Recognition, punctuation and filler removal happen in Handy's
//! transcription path; here come the vocabulary replacements, the optional AI
//! cleanup and the output, and the decisions are pure functions.

use serde::Serialize;
use specta::Type;

use super::settings::{OutputMode, WtSettings};
use crate::pipeline::da::vocabulary::apply_replacements;

/// Where a dictation came from (DESK-90: "tast" or the phone's name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    Key,
    Phone { device_id: String, name: String },
}

impl Source {
    /// The history label: "tast", or the phone's name.
    pub fn label(&self) -> String {
        match self {
            Source::Key => "tast".to_string(),
            Source::Phone { name, .. } if !name.trim().is_empty() => name.clone(),
            // TODO(copy): label for a phone that never sent a name.
            Source::Phone { .. } => "en telefon uden navn".to_string(),
        }
    }
}

/// How the text reaches the user (DESK-50..52).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    /// Pasted at the cursor; the pill says "Indsat".
    Paste,
    /// On the clipboard; the pill (or a notification for a phone dictation)
    /// says "Tekst klar til at indsætte".
    Clipboard,
}

/// DESK-50..52: key dictations paste when allowed; "Kun udklipsholder", a
/// missing Accessibility permission (Mac) and every phone dictation use the
/// clipboard.
pub fn delivery_for(source: &Source, settings: &WtSettings, can_paste: bool) -> Delivery {
    match source {
        Source::Phone { .. } => Delivery::Clipboard,
        Source::Key if settings.output_mode == OutputMode::Paste && can_paste => Delivery::Paste,
        Source::Key => Delivery::Clipboard,
    }
}

/// The pill's last state for a key dictation (DESK-55, Appendix A).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PillEnd {
    /// "Indsat".
    Pasted,
    /// "Tekst klar til at indsætte ⌘V" (Ctrl+V on Windows).
    Clipboard,
    /// "Hørte ikke noget".
    NoSpeech,
    /// "Brugte teksten uden oprydning".
    CleanupSkipped,
}

pub fn pill_end(text: &str, delivery: Delivery, cleanup_fell_back: bool) -> PillEnd {
    if text.trim().is_empty() {
        PillEnd::NoSpeech
    } else if cleanup_fell_back {
        PillEnd::CleanupSkipped
    } else {
        match delivery {
            Delivery::Paste => PillEnd::Pasted,
            Delivery::Clipboard => PillEnd::Clipboard,
        }
    }
}

/// The paste shortcut for this platform, as the UI writes it.
pub fn paste_shortcut() -> &'static str {
    if cfg!(target_os = "macos") {
        "⌘V"
    } else {
        "Ctrl+V"
    }
}

/// Notification body for a phone dictation (DESK-56): the first 80
/// characters, or "Tryk ⌘V for at indsætte" when the text is hidden.
pub fn notification_body(text: &str, show_text: bool) -> String {
    if !show_text {
        return format!("Tryk {} for at indsætte", paste_shortcut());
    }
    let trimmed = text.trim();
    if trimmed.chars().count() <= 80 {
        trimmed.to_string()
    } else {
        let cut: String = trimmed.chars().take(79).collect();
        format!("{}…", cut.trim_end())
    }
}

/// Step 6: the user's replacements ("når jeg siger X, skriv Y").
pub fn local_text(text: &str, settings: &WtSettings) -> String {
    apply_replacements(text, &settings.replacements)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::da::vocabulary::Replacement;

    fn phone() -> Source {
        Source::Phone {
            device_id: "p1".into(),
            name: "Jonathans iPhone".into(),
        }
    }

    #[test]
    fn key_dictations_paste_when_they_can() {
        let s = WtSettings::default();
        assert_eq!(delivery_for(&Source::Key, &s, true), Delivery::Paste);
        assert_eq!(
            delivery_for(&Source::Key, &s, false),
            Delivery::Clipboard,
            "no Accessibility: clipboard (DESK-51)"
        );
        let clipboard_only = WtSettings {
            output_mode: OutputMode::Clipboard,
            ..WtSettings::default()
        };
        assert_eq!(delivery_for(&Source::Key, &clipboard_only, true), Delivery::Clipboard);
    }

    #[test]
    fn phone_dictations_never_paste() {
        assert_eq!(
            delivery_for(&phone(), &WtSettings::default(), true),
            Delivery::Clipboard,
            "DESK-52"
        );
    }

    #[test]
    fn the_pill_ends_with_the_right_state() {
        assert_eq!(pill_end("Hej", Delivery::Paste, false), PillEnd::Pasted);
        assert_eq!(pill_end("Hej", Delivery::Clipboard, false), PillEnd::Clipboard);
        assert_eq!(pill_end("  ", Delivery::Paste, false), PillEnd::NoSpeech);
        assert_eq!(pill_end("Hej", Delivery::Paste, true), PillEnd::CleanupSkipped);
    }

    #[test]
    fn notifications_show_80_characters_or_the_shortcut() {
        assert_eq!(notification_body(" Kort tekst ", true), "Kort tekst");
        let long = "a".repeat(200);
        let body = notification_body(&long, true);
        assert_eq!(body.chars().count(), 80);
        assert!(body.ends_with('…'));
        let hidden = notification_body("hemmeligt", false);
        assert!(hidden.starts_with("Tryk ") && hidden.ends_with(" for at indsætte"));
        assert!(!hidden.contains("hemmeligt"));
    }

    #[test]
    fn sources_have_history_labels() {
        assert_eq!(Source::Key.label(), "tast");
        assert_eq!(phone().label(), "Jonathans iPhone");
        let nameless = Source::Phone {
            device_id: "p2".into(),
            name: " ".into(),
        };
        assert_eq!(nameless.label(), "en telefon uden navn");
    }

    #[test]
    fn replacements_are_the_local_step() {
        let s = WtSettings {
            replacements: vec![Replacement {
                from: "walkie talkie".into(),
                to: "WalkieTalkey".into(),
            }],
            ..WtSettings::default()
        };
        assert_eq!(local_text("Åbn walkie talkie.", &s), "Åbn WalkieTalkey.");
    }
}
