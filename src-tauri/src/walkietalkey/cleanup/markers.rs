//! When "Når der er noget at rette" calls the provider (DESK-80): only if the
//! text, after the local steps, has a self-correction marker or a repeated
//! phrase. Every other dictation goes out at once with no network call. The
//! marker list is tuned in M5 against the test set.

/// Self-correction markers, Danish and English, matched as whole words.
pub const MARKERS: &[&str] = &[
    "nej vent",
    "nej",
    "jeg mener",
    "eller rettere",
    "undskyld",
    "i mean",
    "no wait",
    "sorry",
];

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// A marker appears as whole words.
pub fn has_self_correction(text: &str) -> bool {
    let words = words(text);
    MARKERS.iter().any(|marker| {
        let marker: Vec<&str> = marker.split(' ').collect();
        words
            .windows(marker.len())
            .any(|window| window.iter().zip(&marker).all(|(w, m)| w == m))
    })
}

/// The same phrase (one to four words) said twice in a row, such as "på
/// torsdag på torsdag" or "det det". Single letters and numbers do not count.
pub fn has_repeated_phrase(text: &str) -> bool {
    let words = words(text);
    for len in 1..=4 {
        for start in 0..words.len().saturating_sub(2 * len - 1) {
            let first = &words[start..start + len];
            let second = &words[start + len..start + 2 * len];
            let meaningful = first
                .iter()
                .any(|w| w.chars().count() >= 2 && !w.chars().all(|c| c.is_ascii_digit()));
            if meaningful && first == second {
                return true;
            }
        }
    }
    false
}

pub fn needs_cleanup(text: &str) -> bool {
    has_self_correction(text) || has_repeated_phrase(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn danish_and_english_corrections_are_found() {
        assert!(needs_cleanup("Vi ses onsdag, nej, torsdag."));
        assert!(needs_cleanup("Vi ses onsdag nej vent torsdag"));
        assert!(needs_cleanup("Send det til Peter, jeg mener Poul."));
        assert!(needs_cleanup("Kl. 10, eller rettere kl. 11."));
        assert!(needs_cleanup("We deploy Monday, I mean Tuesday."));
        assert!(needs_cleanup("Push the branch, no wait, merge it."));
    }

    #[test]
    fn markers_are_whole_words() {
        assert!(
            !needs_cleanup("Nejlikerne står i vinduet."),
            "nej inside a word"
        );
        assert!(!needs_cleanup("Undskyldningen var god."));
        assert!(!needs_cleanup("Hej, det her er min første diktering."));
    }

    #[test]
    fn repeated_phrases_are_found() {
        assert!(has_repeated_phrase(
            "Vi mødes på torsdag på torsdag kl. 10."
        ));
        assert!(has_repeated_phrase("Det det er fint."));
        assert!(
            !has_repeated_phrase("Det er fint, det er godt."),
            "not back to back"
        );
        assert!(
            !has_repeated_phrase("Version 2 2 kom ud."),
            "numbers do not count"
        );
        assert!(
            !has_repeated_phrase("Rum A A er ledigt."),
            "single letters do not count"
        );
    }
}
