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
//!
//! Broken characters (run 4) come from the same runs. The owner's iPhone
//! dictation ended a sentence in "før mødet��": Whisper's tokens are bytes,
//! and when a decode goes astray (transcribe.cpp falls back to sampling at a
//! higher temperature on unclear audio) it can emit part of a multi-byte
//! character and move on, so the engine's text holds bytes that are not
//! UTF-8, and transcribe-cpp turns each broken piece into U+FFFD. Re-decoding
//! the owner's sentence with the vocabulary gave such bytes in 3 of 22 runs
//! ("tilrous겠\xeb før", "før m\x88도"). Nothing in WalkieTalkey splits text:
//! chunks are decoded and joined as whole strings. So a broken character
//! counts like a foreign letter: the chunk is decoded again, and any left are
//! removed.

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

/// What transcribe-cpp writes for bytes of the engine's text that are not
/// UTF-8: a character the decode broke off part-way.
pub const BROKEN_CHARACTER: char = char::REPLACEMENT_CHARACTER;

/// Whether `c` never belongs in Danish dictation: a letter from another
/// script, or a broken character.
pub fn is_stray(c: char) -> bool {
    c == BROKEN_CHARACTER || is_foreign_letter(c)
}

/// Whether the text has a letter from another script or a broken character.
pub fn has_stray_characters(text: &str) -> bool {
    text.chars().any(is_stray)
}

/// The text without letters from other scripts and broken characters. A word
/// made only of them goes with its space; spaces stay single.
pub fn strip_stray_characters(text: &str) -> String {
    strip(text, is_stray)
}

/// The text without broken characters, for runs in other languages, where
/// other scripts are welcome.
pub fn strip_broken_characters(text: &str) -> String {
    strip(text, |c| c == BROKEN_CHARACTER)
}

fn strip(text: &str, stray: impl Fn(char) -> bool) -> String {
    if !text.chars().any(&stray) {
        return text.to_string();
    }
    let words: Vec<String> = text
        .split_whitespace()
        .filter_map(|word| {
            let kept: String = word.chars().filter(|c| !stray(*c)).collect();
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
            assert!(!has_stray_characters(text), "{text}");
            assert_eq!(strip_stray_characters(text), text);
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
            assert!(has_stray_characters(text), "{text}");
        }
    }

    #[test]
    fn stripping_drops_foreign_letters_and_words_made_of_them() {
        assert_eq!(
            strip_stray_characters("Huskerer til dramatisk Никто før mødet."),
            "Huskerer til dramatisk før mødet."
        );
        assert_eq!(
            strip_stray_characters("Husk atали til grief"),
            "Husk at til grief"
        );
        assert_eq!(
            strip_stray_characters("Jeg lige lavede en бел스럽 til dig."),
            "Jeg lige lavede en til dig."
        );
        // Punctuation that only belonged to a foreign word goes with it.
        assert_eq!(strip_stray_characters("Hej 안녕. Tak"), "Hej Tak");
    }

    /// The engine's own bytes from run 4's re-decodes of the owner's sentence,
    /// read the way transcribe-cpp reads them (lossy UTF-8).
    fn engine_text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    #[test]
    fn broken_characters_are_stray_and_removed() {
        // The owner's iPhone dictation (history id 86).
        let owner = "Husk at Hurlcomfort til BaşHEN før mødet\u{FFFD}\u{FFFD} Min datter";
        assert!(has_stray_characters(owner));
        assert_eq!(
            strip_stray_characters(owner),
            "Husk at Hurlcomfort til BaşHEN før mødet Min datter"
        );

        let cut_off = engine_text(
            b"Husk at \xec\x88\x98\xea\xb0\x80 tilrous\xea\xb2\xa0\xeb f\xc3\xb8r m\xc3\xb8det",
        );
        assert!(cut_off.contains(BROKEN_CHARACTER));
        assert!(has_stray_characters(&cut_off));
        assert_eq!(
            strip_stray_characters(&cut_off),
            "Husk at tilrous før mødet"
        );

        let broke_in = engine_text(b"f\xc3\xb8r m\x88\xeb\x8f\x84");
        assert_eq!(strip_stray_characters(&broke_in), "før m");

        // A word made only of broken characters goes with its space.
        assert_eq!(
            strip_stray_characters("før \u{FFFD}\u{FFFD} mødet."),
            "før mødet."
        );
    }

    #[test]
    fn other_languages_lose_only_broken_characters() {
        assert_eq!(
            strip_broken_characters("Ελληνικά \u{FFFD}\u{FFFD} 中文\u{FFFD}"),
            "Ελληνικά 中文"
        );
        assert_eq!(strip_broken_characters("Hello\nworld"), "Hello\nworld");
    }
}
