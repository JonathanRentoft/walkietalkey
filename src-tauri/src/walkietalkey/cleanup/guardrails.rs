//! Cleanup guardrails (DESK-84): the raw text is used instead, and the pill
//! says "Brugte teksten uden oprydning", if the result is more than 30%
//! longer than the input, if more than 20% of its words do not occur in the
//! input (ignoring case and punctuation, and allowing digits, "kl." and other
//! number and date forms that cleanup may write), or if no answer has arrived
//! within 3 s plus 1 s per 100 words.

use std::collections::HashSet;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum Violation {
    /// Longer than the input by more than 30% (characters).
    TooLong { ratio: f64 },
    /// More than 20% of the result's words are not in the input.
    NewWords { share: f64 },
    /// No answer within the deadline.
    Timeout,
    /// The provider failed or answered nothing.
    NoAnswer,
}

pub const MAX_GROWTH: f64 = 1.30;
pub const MAX_NEW_WORDS: f64 = 0.20;

/// 3 s plus 1 s per 100 words of input.
pub fn deadline(input: &str) -> Duration {
    let words = input.split_whitespace().count() as f64;
    Duration::from_secs(3) + Duration::from_secs_f64(words / 100.0)
}

/// Number and date forms cleanup may write that need not occur in the input:
/// "kl." for "klokken", ordinal dots, and abbreviated months and weekdays.
const NUMBER_FORMS: &[&str] = &[
    "kl", "ca", "nr", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "okt",
    "nov", "dec", "man", "tirs", "ons", "tors", "fre", "lør", "søn", "pct", "procent", "kr",
];

fn normalised_words(text: &str) -> Vec<String> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn is_number_form(word: &str) -> bool {
    word.chars().any(|c| c.is_ascii_digit()) || NUMBER_FORMS.contains(&word)
}

/// Checks a cleanup result against its input.
pub fn check(input: &str, output: &str) -> Result<(), Violation> {
    let output = output.trim();
    if output.is_empty() {
        return Err(Violation::NoAnswer);
    }
    let input_len = input.trim().chars().count().max(1) as f64;
    let ratio = output.chars().count() as f64 / input_len;
    if ratio > MAX_GROWTH {
        return Err(Violation::TooLong { ratio });
    }
    let known: HashSet<String> = normalised_words(input).into_iter().collect();
    let out_words = normalised_words(output);
    if !out_words.is_empty() {
        let new = out_words
            .iter()
            .filter(|w| !known.contains(*w) && !is_number_form(w))
            .count();
        let share = new as f64 / out_words.len() as f64;
        if share > MAX_NEW_WORDS {
            return Err(Violation::NewWords { share });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadline_is_3s_plus_1s_per_100_words() {
        assert_eq!(deadline(""), Duration::from_secs(3));
        assert_eq!(deadline(&"ord ".repeat(100)), Duration::from_secs(4));
        assert_eq!(deadline(&"ord ".repeat(250)), Duration::from_millis(5_500));
    }

    #[test]
    fn a_normal_cleanup_passes() {
        let input = "øh vi ses onsdag nej torsdag klokken ti";
        let output = "Vi ses torsdag kl. 10.";
        assert_eq!(check(input, output), Ok(()));
    }

    #[test]
    fn growing_more_than_30_percent_is_refused() {
        let input = "Vi ses torsdag.";
        let output = "Vi ses torsdag. Husk også at tage kaffe med til mødet.";
        assert!(matches!(check(input, output), Err(Violation::TooLong { .. })));
        // The same words, 20% longer: fine; 41% longer: refused.
        let words = |n: usize| vec!["ord"; n].join(" ");
        assert_eq!(check(&words(10), &words(12)), Ok(()));
        assert!(matches!(check(&words(10), &words(14)), Err(Violation::TooLong { .. })));
    }

    #[test]
    fn more_than_20_percent_new_words_is_refused() {
        let input = "kan du svare på hvad klokken er nu og hvor vi skal hen";
        let output = "Klokken er tre om eftermiddagen, vi skal til Aarhus.";
        assert!(matches!(check(input, output), Err(Violation::NewWords { .. })));
    }

    #[test]
    fn number_and_date_forms_are_allowed() {
        let input = "mødet er den tredje marts klokken ti";
        let output = "Mødet er den 3. marts kl. 10.";
        assert_eq!(check(input, output), Ok(()));
    }

    #[test]
    fn an_empty_answer_is_no_answer() {
        assert_eq!(check("hej", "   "), Err(Violation::NoAnswer));
    }
}
