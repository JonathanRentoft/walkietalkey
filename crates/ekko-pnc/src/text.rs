//! Python `str` semantics that the reference runtime (ekko-stt `pnc.py`) uses,
//! reproduced with CPython's own Unicode tables (`pyunicode.rs`).

use crate::pyunicode;

fn in_ranges(table: &[(u32, u32)], c: char) -> bool {
    let c = c as u32;
    table
        .binary_search_by(|&(lo, hi)| {
            if hi < c {
                std::cmp::Ordering::Less
            } else if lo > c {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// `chr(c).isspace()`.
pub fn py_isspace(c: char) -> bool {
    pyunicode::SPACE.binary_search(&(c as u32)).is_ok()
}

/// `chr(c).isalpha()`.
pub fn py_isalpha(c: char) -> bool {
    in_ranges(pyunicode::ALPHA, c)
}

/// `chr(c).isupper() or chr(c).istitle()`.
pub fn py_isupper_or_title(c: char) -> bool {
    in_ranges(pyunicode::UPPER_OR_TITLE, c)
}

/// `chr(c).title()`.
pub fn py_title(c: char) -> String {
    match pyunicode::TITLE.binary_search_by_key(&(c as u32), |&(k, _)| k) {
        Ok(i) => pyunicode::TITLE[i].1.to_string(),
        Err(_) => c.to_string(),
    }
}

/// `text.split()`: split on runs of Python whitespace, no empty items.
pub fn py_split(text: &str) -> Vec<&str> {
    text.split(py_isspace).filter(|w| !w.is_empty()).collect()
}

/// `Punctuator._capitalize_initial_preserving_case`: a word that already has an
/// upper or title case character is kept; otherwise its first alphabetic
/// character is title-cased.
pub fn capitalize_initial_preserving_case(word: &str) -> String {
    if word.chars().any(py_isupper_or_title) {
        return word.to_string();
    }
    match word.char_indices().find(|&(_, c)| py_isalpha(c)) {
        Some((i, c)) => {
            let mut out = String::with_capacity(word.len() + 2);
            out.push_str(&word[..i]);
            out.push_str(&py_title(c));
            out.push_str(&word[i + c.len_utf8()..]);
            out
        }
        None => word.to_string(),
    }
}

/// `is_abbreviation` inside `Punctuator._stabilize_sentence_case`: a "." with
/// an alphabetic character on both sides ("f.eks.", "a.m.").
pub fn is_abbreviation(word: &str) -> bool {
    let chars: Vec<char> = word.chars().collect();
    (1..chars.len().saturating_sub(1))
        .any(|i| chars[i] == '.' && py_isalpha(chars[i - 1]) && py_isalpha(chars[i + 1]))
}

/// `Punctuator._stabilize_sentence_case`: capitalise the first word and every
/// word after one that ends a sentence (".", "!", "?"), unless that word is an
/// abbreviation.
pub fn stabilize_sentence_case(words: Vec<String>) -> Vec<String> {
    if words.is_empty() {
        return words;
    }
    let mut rendered = words;
    rendered[0] = capitalize_initial_preserving_case(&rendered[0]);
    // Python iterates over a copy of rendered[:-1]; capitalising only changes a
    // word's first letter, which neither test below looks at, so reading the
    // live vector gives the same result.
    for i in 0..rendered.len() - 1 {
        let word = &rendered[i];
        if !word.ends_with(['.', '!', '?']) || is_abbreviation(word) {
            continue;
        }
        rendered[i + 1] = capitalize_initial_preserving_case(&rendered[i + 1]);
    }
    rendered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_matches_python_whitespace() {
        assert_eq!(py_split("  hej  med\tdig\n"), vec!["hej", "med", "dig"]);
        // U+001C..U+001F are whitespace for Python but not for Rust.
        assert_eq!(py_split("a\u{1c}b\u{1f}c"), vec!["a", "b", "c"]);
        // NBSP, ideographic space, line separator.
        assert_eq!(
            py_split("a\u{a0}b\u{3000}c\u{2028}d"),
            vec!["a", "b", "c", "d"]
        );
        // Zero-width space is not whitespace in Python.
        assert_eq!(py_split("a\u{200b}b"), vec!["a\u{200b}b"]);
        assert!(py_split("").is_empty());
        assert!(py_split(" \t ").is_empty());
    }

    #[test]
    fn character_classes_follow_python() {
        assert!(py_isalpha('æ') && py_isalpha('Ø') && py_isalpha('å'));
        assert!(!py_isalpha('1') && !py_isalpha('-') && !py_isalpha('.'));
        // Roman numeral Ⅻ is Nl: alphabetic for Rust, not for Python.
        assert!(!py_isalpha('\u{216b}'));
        assert!(py_isupper_or_title('Æ') && py_isupper_or_title('ǅ'));
        assert!(!py_isupper_or_title('æ') && !py_isupper_or_title('1'));
        assert!(py_isspace('\u{1e}') && !py_isspace('\u{200b}'));
    }

    #[test]
    fn title_case_of_one_character() {
        assert_eq!(py_title('e'), "E");
        assert_eq!(py_title('ø'), "Ø");
        assert_eq!(py_title('ß'), "Ss");
        assert_eq!(py_title('ǆ'), "ǅ");
        assert_eq!(py_title('ﬁ'), "Fi");
        assert_eq!(py_title('E'), "E");
        assert_eq!(py_title('3'), "3");
    }

    #[test]
    fn capitalize_initial() {
        assert_eq!(capitalize_initial_preserving_case("emil"), "Emil");
        assert_eq!(capitalize_initial_preserving_case("øl"), "Øl");
        assert_eq!(capitalize_initial_preserving_case("iPhone"), "iPhone");
        assert_eq!(capitalize_initial_preserving_case("Emil"), "Emil");
        assert_eq!(capitalize_initial_preserving_case("\"hej"), "\"Hej");
        assert_eq!(capitalize_initial_preserving_case("3d"), "3D");
        assert_eq!(capitalize_initial_preserving_case("123"), "123");
        assert_eq!(capitalize_initial_preserving_case("ßtraße"), "Sstraße");
        assert_eq!(capitalize_initial_preserving_case(""), "");
    }

    #[test]
    fn abbreviations() {
        assert!(is_abbreviation("f.eks."));
        assert!(is_abbreviation("a.m."));
        assert!(!is_abbreviation("dag."));
        assert!(!is_abbreviation("3.5"));
        assert!(!is_abbreviation(".."));
        assert!(!is_abbreviation("."));
    }

    #[test]
    fn sentence_case() {
        let words = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        assert_eq!(
            stabilize_sentence_case(words("hej. med dig? ja! nej")),
            words("Hej. Med dig? Ja! Nej")
        );
        assert_eq!(
            stabilize_sentence_case(words("f.eks. noget")),
            words("F.eks. noget")
        );
        assert_eq!(
            stabilize_sentence_case(words("slut. iPhone")),
            words("Slut. iPhone")
        );
        assert!(stabilize_sentence_case(Vec::new()).is_empty());
    }
}
