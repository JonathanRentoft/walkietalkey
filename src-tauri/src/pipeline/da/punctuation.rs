//! When to run Ekko PnC (DESK-41): when the recognised text has fewer than 1
//! punctuation mark per 25 words, or always or never by the "Tegnsætning"
//! setting. The model itself runs in the ekko-pnc crate; this stage only
//! decides.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The "Tegnsætning" setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PunctuationMode {
    /// Automatisk: only when the text lacks punctuation.
    #[default]
    Automatic,
    /// Altid.
    Always,
    /// Aldrig.
    Never,
}

/// One mark per this many words is enough punctuation.
const WORDS_PER_MARK: usize = 25;

/// Sentence and clause marks that count as punctuation.
fn is_mark(c: char) -> bool {
    matches!(c, '.' | ',' | '?' | '!' | ':' | ';')
}

/// Whether `text` has fewer than one mark per 25 words.
pub fn lacks_punctuation(text: &str) -> bool {
    let words = text.split_whitespace().count();
    if words == 0 {
        return false;
    }
    let marks = text.chars().filter(|&c| is_mark(c)).count();
    marks * WORDS_PER_MARK < words
}

/// Whether the punctuation model should run on `text`.
pub fn should_punctuate(mode: PunctuationMode, text: &str) -> bool {
    match mode {
        PunctuationMode::Never => false,
        PunctuationMode::Always => !text.trim().is_empty(),
        PunctuationMode::Automatic => lacks_punctuation(text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpunctuated_text_triggers() {
        assert!(lacks_punctuation("hej det her er en test uden tegn"));
        // FTSpeech style: lower case, no marks, a long stretch.
        let long = "og så skal vi huske at ".repeat(10);
        assert!(lacks_punctuation(&long));
    }

    #[test]
    fn one_mark_per_25_words_is_enough() {
        let words25 = "ord ".repeat(24) + "ord.";
        assert!(!lacks_punctuation(&words25), "1 mark in 25 words");
        let words26 = "ord ".repeat(25) + "ord.";
        assert!(lacks_punctuation(&words26), "1 mark in 26 words");
        assert!(!lacks_punctuation("Hej. Det her er en test."));
    }

    #[test]
    fn empty_text_never_triggers() {
        assert!(!lacks_punctuation(""));
        assert!(!lacks_punctuation("   "));
        assert!(!should_punctuate(PunctuationMode::Always, " "));
    }

    #[test]
    fn the_setting_overrides_the_rule() {
        let bare = "hej med dig";
        let punctuated = "Hej med dig.";
        assert!(should_punctuate(PunctuationMode::Automatic, bare));
        assert!(!should_punctuate(PunctuationMode::Automatic, punctuated));
        assert!(should_punctuate(PunctuationMode::Always, punctuated));
        assert!(!should_punctuate(PunctuationMode::Never, bare));
        assert_eq!(PunctuationMode::default(), PunctuationMode::Automatic);
    }
}
