//! Letters from other scripts in Danish text (run 2, Phase 2).
//!
//! On unclear or code-switched speech Edda sometimes answers with fragments
//! in other scripts ("Husk atали til grief", "Huskいます til운 chakra"), most
//! often when a vocabulary prompt is in play: on the owner's sentence "Husk at
//! deploye til staging før mødet" tiny differences in the audio flipped the
//! "Glossary:" run into such fragments, while the run without it stayed
//! Danish. Danish dictation never needs letters outside the Latin script, so
//! a Danish chunk that shows any is decoded again without the vocabulary
//! (`managers::transcription::chunked`), and whatever is left is removed when
//! the text is finished.

/// Whether `c` is a letter from a script Danish text never uses: anything but
/// the Latin script (ASCII, Latin-1, Latin Extended-A/B and Additional, and
/// Latin Extended-C/D).
pub fn is_foreign_letter(c: char) -> bool {
    c.is_alphabetic()
        && !c.is_ascii()
        && !matches!(
            c as u32,
            0x00A0..=0x024F | 0x1E00..=0x1EFF | 0x2C60..=0x2C7F | 0xA720..=0xA7FF
        )
}

/// Whether the text has any letter from another script.
pub fn has_foreign_letters(text: &str) -> bool {
    text.chars().any(is_foreign_letter)
}

/// The text without letters from other scripts. A word made only of them goes
/// with its space; spaces stay single.
pub fn strip_foreign_letters(text: &str) -> String {
    if !has_foreign_letters(text) {
        return text.to_string();
    }
    let words: Vec<String> = text
        .split_whitespace()
        .filter_map(|word| {
            let kept: String = word.chars().filter(|c| !is_foreign_letter(*c)).collect();
            kept.chars().any(char::is_alphanumeric).then_some(kept)
        })
        .collect();
    words.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn danish_and_other_latin_letters_are_not_foreign() {
        for text in [
            "Kan du tjekke, om det nye endpoint virker?",
            "Rødgrød med fløde på Ærø og Åbenrå.",
            "Café, naïve, Müller, Łódź, Kraków, señor, ß, µm, 1º",
            "Pull request #42: 3 × 4 = 12 kr. (ca. 50 %)",
        ] {
            assert!(!has_foreign_letters(text), "{text}");
            assert_eq!(strip_foreign_letters(text), text);
        }
    }

    #[test]
    fn letters_from_other_scripts_are_foreign() {
        // Seen in run 2 on the owner's sentence about deploying to staging.
        for text in [
            "Husk atали til grief før Mø Azerbai.",
            "Huskいます til운 chakra før mødet.",
            "Husk at confronting til었다ing før mødet.",
            "Jeg lige lavede en бел스럽 til dig.",
            "Ελληνικά, עברית, العربية, हिन्दी, ไทย, 中文",
        ] {
            assert!(has_foreign_letters(text), "{text}");
        }
    }

    #[test]
    fn stripping_drops_foreign_letters_and_words_made_of_them() {
        assert_eq!(
            strip_foreign_letters("Huskerer til dramatisk Никто før mødet."),
            "Huskerer til dramatisk før mødet."
        );
        assert_eq!(
            strip_foreign_letters("Husk atали til grief"),
            "Husk at til grief"
        );
        assert_eq!(
            strip_foreign_letters("Jeg lige lavede en бел스럽 til dig."),
            "Jeg lige lavede en til dig."
        );
        // Punctuation that only belonged to a foreign word goes with it.
        assert_eq!(strip_foreign_letters("Hej 안녕. Tak"), "Hej Tak");
    }
}
