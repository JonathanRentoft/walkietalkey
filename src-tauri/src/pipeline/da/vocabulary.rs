//! Indstillinger › Ordliste (DESK-66..68): "Ord" go to the model's vocabulary
//! field, within a token budget; "Erstatninger" are applied to the text after
//! recognition.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;

/// Whisper's prompt slot is 223 tokens, shared with the previous chunk's
/// context (DESK-46), so the words get about 150 of them (DESK-66).
pub const VOCABULARY_TOKEN_BUDGET: usize = 150;

/// A rough Whisper BPE estimate for Danish and English terms: about one
/// token per three characters, plus the ", " separator. Deliberately on the
/// high side, so the budget is not overrun.
fn estimated_tokens(term: &str) -> usize {
    term.chars().count().div_ceil(3) + 1
}

/// The terms for the model, most recent first (`words` is stored oldest
/// first), as many as fit in `budget` estimated tokens. Empty and repeated
/// terms are skipped.
pub fn vocabulary_terms(words: &[String], budget: usize) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut used = 0;
    for word in words.iter().rev() {
        let term = word.trim();
        if term.is_empty() || terms.iter().any(|t| t.eq_ignore_ascii_case(term)) {
            continue;
        }
        let cost = estimated_tokens(term);
        if used + cost > budget {
            break;
        }
        used += cost;
        terms.push(term.to_string());
    }
    terms
}

/// "Når jeg siger X, skriv Y".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Replacement {
    pub from: String,
    pub to: String,
}

/// Applies replacements in order: whole words or phrases, case-insensitive
/// match, and the replacement's own casing.
pub fn apply_replacements(text: &str, replacements: &[Replacement]) -> String {
    let mut out = text.to_string();
    for replacement in replacements {
        let from = replacement.from.trim();
        if from.is_empty() {
            continue;
        }
        let Ok(re) = Regex::new(&format!("(?i){}", regex::escape(from))) else {
            continue;
        };
        // A word boundary is only required where the phrase itself starts or
        // ends with a letter or digit.
        let check_before = from.chars().next().is_some_and(is_word_char);
        let check_after = from.chars().next_back().is_some_and(is_word_char);
        let mut replaced = String::with_capacity(out.len());
        let mut last = 0;
        for m in re.find_iter(&out) {
            let before = out[..m.start()].chars().next_back();
            let after = out[m.end()..].chars().next();
            let whole = !(check_before && before.is_some_and(is_word_char))
                && !(check_after && after.is_some_and(is_word_char));
            if whole {
                replaced.push_str(&out[last..m.start()]);
                replaced.push_str(&replacement.to);
                last = m.end();
            }
        }
        replaced.push_str(&out[last..]);
        out = replaced;
    }
    out
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The built-in "Udviklerord" pack (DESK-67): English terms that come up in
/// Danish speech at work, so the model spells them right.
pub const DEVELOPER_WORDS: &[&str] = &[
    "pull request",
    "deploy",
    "standup",
    "merge",
    "commit",
    "frontend",
    "backend",
    "branch",
    "rebase",
    "code review",
    "release",
    "staging",
    "production",
    "bug",
    "feature",
    "sprint",
    "backlog",
    "API",
    "endpoint",
    "refactor",
    "pipeline",
    "repository",
    "issue",
    "hotfix",
    "rollback",
    "deadline",
    "TypeScript",
    "JavaScript",
    "Kubernetes",
    "GitHub",
];

static REPLACEMENT_LINE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(.+?)\s*(?:=>|->|\t)\s*(.+?)\s*$").unwrap());

/// Plain-text import of "Ord": one entry per line (DESK-68).
pub fn parse_word_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// Plain-text export of "Ord".
pub fn format_word_lines(words: &[String]) -> String {
    words.iter().map(|w| format!("{w}\n")).collect()
}

/// Plain-text import of "Erstatninger": `X => Y` per line (also `X -> Y` or
/// tab-separated), DESK-68.
pub fn parse_replacement_lines(text: &str) -> Vec<Replacement> {
    text.lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .filter_map(|line| REPLACEMENT_LINE.captures(line))
        .map(|caps| Replacement {
            from: caps[1].to_string(),
            to: caps[2].to_string(),
        })
        .collect()
}

/// Plain-text export of "Erstatninger".
pub fn format_replacement_lines(replacements: &[Replacement]) -> String {
    replacements
        .iter()
        .map(|r| format!("{} => {}\n", r.from, r.to))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(from: &str, to: &str) -> Replacement {
        Replacement {
            from: from.into(),
            to: to.into(),
        }
    }

    #[test]
    fn newest_words_come_first_within_the_budget() {
        let words: Vec<String> = (0..200).map(|i| format!("Ordnummer{i}")).collect();
        let terms = vocabulary_terms(&words, VOCABULARY_TOKEN_BUDGET);
        assert_eq!(terms[0], "Ordnummer199", "most recent first");
        let used: usize = terms.iter().map(|t| estimated_tokens(t)).sum();
        assert!(used <= VOCABULARY_TOKEN_BUDGET);
        assert!(terms.len() < words.len(), "the budget cuts the old ones");
    }

    #[test]
    fn empty_and_duplicate_words_are_skipped() {
        let words = vec![
            "Jonathan".into(),
            " ".into(),
            "Navigent".into(),
            "jonathan".into(),
        ];
        assert_eq!(vocabulary_terms(&words, 150), vec!["jonathan", "Navigent"]);
    }

    #[test]
    fn replacements_match_whole_words_case_insensitively() {
        let rules = [r("walkie talkie", "WalkieTalkey"), r("pr", "PR")];
        assert_eq!(
            apply_replacements("Jeg åbner en pr i Walkie Talkie nu.", &rules),
            "Jeg åbner en PR i WalkieTalkey nu."
        );
        // Not inside other words.
        assert_eq!(apply_replacements("Et prisskilt", &rules), "Et prisskilt");
    }

    #[test]
    fn replacements_keep_their_own_casing_and_work_next_to_danish_letters() {
        let rules = [r("øresund", "Øresund")];
        assert_eq!(apply_replacements("over øresund.", &rules), "over Øresund.");
        assert_eq!(apply_replacements("ØRESUND!", &rules), "Øresund!");
        // "øresundsbroen" is another word.
        assert_eq!(apply_replacements("øresundsbroen", &rules), "øresundsbroen");
    }

    #[test]
    fn adjacent_matches_are_all_replaced() {
        let rules = [r("ok", "OK")];
        assert_eq!(apply_replacements("ok ok ok", &rules), "OK OK OK");
    }

    #[test]
    fn plain_text_round_trips() {
        let words = vec!["Edda".to_string(), "Ekko".to_string()];
        assert_eq!(parse_word_lines(&format_word_lines(&words)), words);
        assert_eq!(parse_word_lines("# kommentar\n\n Edda \n"), vec!["Edda"]);

        let rules = vec![r("walkie talkie", "WalkieTalkey"), r("kl", "kl.")];
        assert_eq!(
            parse_replacement_lines(&format_replacement_lines(&rules)),
            rules
        );
        assert_eq!(
            parse_replacement_lines("a -> b\nc\td\nugyldig linje\n"),
            vec![r("a", "b"), r("c", "d")]
        );
    }

    #[test]
    fn the_developer_pack_fits_the_budget() {
        let words: Vec<String> = DEVELOPER_WORDS.iter().map(|w| w.to_string()).collect();
        assert_eq!(
            vocabulary_terms(&words, VOCABULARY_TOKEN_BUDGET).len(),
            DEVELOPER_WORDS.len()
        );
    }
}
