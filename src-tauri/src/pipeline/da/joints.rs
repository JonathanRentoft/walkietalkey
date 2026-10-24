//! Joints between chunks (run 4, DESK-46).
//!
//! A dictation is decoded one speech segment at a time, cut at pauses, and
//! Whisper writes every segment as if it were a whole utterance: a capital
//! first letter, often a full stop at the end. Where the pause falls inside a
//! sentence, the joined text reads "... og ikke bare Kaster mig hovedløst ud
//! i det ..." (the owner's dictation, run 4). Neither signal can be trusted at
//! a joint, because each segment was decoded without the other.
//!
//! So each joint is read again with both sides in view: the punctuation model
//! (Ekko PnC, the [`JointJudge`]) sees the last words before it and the first
//! words after it, without marks or capitals, and says whether a sentence ends
//! there and whether the next word is written with a capital (a name). Then:
//!
//! * a sentence ends: the text before gets a full stop (or the model's
//!   question or exclamation mark) if it has none, and the next chunk starts
//!   with a capital;
//! * no sentence ends: a full stop Whisper put at the end of the segment goes
//!   (the model's comma, if it reads one, takes its place), and the next
//!   chunk's first word is lower-cased unless the model writes it with a
//!   capital or it is an acronym or a mixed-case name ("GitHub", "iPhone").
//!   That includes "I": at a segment start it is nearly always the
//!   preposition "i" ("I Paris"), and the model knows the pronoun from it.
//!
//! A question or exclamation mark Whisper heard stays: the voice carries it.
//! Without a judge (the "Tegnsætning" setting is "Aldrig", the model files are
//! missing, or an Intel Mac) the chunks are joined as they are.

/// How the punctuation model reads a joint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JointReading {
    /// The mark after the last word before the joint: none, ",", ".", "?" ...
    pub mark: Option<String>,
    /// Whether the first word after the joint is written with a capital.
    pub next_upper: bool,
}

/// Reads a joint. `before` and `after` are the words around it, lower case
/// and without marks.
pub trait JointJudge {
    fn read(&self, before: &[String], after: &[String]) -> Option<JointReading>;
}

/// Words of context on each side of a joint.
pub const WINDOW_WORDS: usize = 12;

/// Marks that end a sentence.
fn ends_sentence(mark: &str) -> bool {
    mark.contains(['.', '?', '!', '…'])
}

/// The text without its trailing marks, and those marks.
fn split_trailing_mark(text: &str) -> (&str, &str) {
    let stem = text.trim_end_matches(['.', ',', ';', ':', '?', '!', '…']);
    (stem, &text[stem.len()..])
}

/// A word as the punctuation model reads it: lower case, letters, digits and
/// the apostrophes and hyphens inside it.
fn bare(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_alphanumeric())
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '\'' | '’' | '-'))
        .flat_map(char::to_lowercase)
        .collect()
}

fn window(words: impl Iterator<Item = String>) -> Vec<String> {
    words.filter(|w| !w.is_empty()).collect()
}

/// Whether `word` may have its capital only because it starts a segment: a
/// capital first letter and nothing else upper case. Acronyms ("PR", "API")
/// and mixed-case names ("GitHub") keep their capitals whatever the model reads.
fn capital_only_first(word: &str) -> bool {
    let mut letters = word.chars().filter(|c| c.is_alphabetic());
    let Some(first) = letters.next() else {
        return false;
    };
    first.is_uppercase() && letters.all(|c| !c.is_uppercase())
}

fn with_first_letter(text: &str, upper: bool) -> String {
    let Some((at, c)) = text.char_indices().find(|(_, c)| c.is_alphabetic()) else {
        return text.to_string();
    };
    let changed: String = if upper {
        c.to_uppercase().collect()
    } else {
        c.to_lowercase().collect()
    };
    format!("{}{}{}", &text[..at], changed, &text[at + c.len_utf8()..])
}

/// The joint between `before` (the text so far) and `after` (the next chunk),
/// read again by `judge`. Returns both texts, repaired.
pub fn repair(before: &str, after: &str, judge: &dyn JointJudge) -> (String, String) {
    let (before, after) = (before.trim_end(), after.trim_start());
    let unchanged = || (before.to_string(), after.to_string());
    let (stem, mark) = split_trailing_mark(before);
    let left = window(stem.split_whitespace().rev().take(WINDOW_WORDS).map(bare));
    let right = window(after.split_whitespace().take(WINDOW_WORDS).map(bare));
    if left.is_empty() || right.is_empty() {
        return unchanged();
    }
    let left: Vec<String> = left.into_iter().rev().collect();
    let Some(reading) = judge.read(&left, &right) else {
        return unchanged();
    };
    let read_mark = reading.mark.as_deref().unwrap_or("");
    let heard_question_or_exclamation = mark.contains(['?', '!']);
    let boundary = heard_question_or_exclamation || ends_sentence(read_mark);

    let before = if boundary {
        if ends_sentence(mark) {
            before.to_string()
        } else {
            let end = if ends_sentence(read_mark) {
                read_mark
            } else {
                "."
            };
            format!("{stem}{end}")
        }
    } else if ends_sentence(mark) || mark.is_empty() {
        // Whisper's full stop at the end of a segment goes; the model's comma
        // (if any) takes its place.
        let comma = if read_mark == "," { "," } else { "" };
        format!("{stem}{comma}")
    } else {
        before.to_string()
    };

    let first = after.split_whitespace().next().unwrap_or_default();
    let after = if boundary {
        with_first_letter(after, true)
    } else if capital_only_first(first) && !reading.next_upper {
        with_first_letter(after, false)
    } else {
        after.to_string()
    };
    (before, after)
}

/// Chunk texts joined with every joint read again by `judge`; without one,
/// joined as they are.
pub fn join<S: AsRef<str>>(texts: &[S], judge: Option<&dyn JointJudge>) -> String {
    let Some(judge) = judge else {
        return crate::audio_toolkit::chunking::join_transcripts(texts);
    };
    let mut joined = String::new();
    for text in texts {
        let text = text.as_ref().trim();
        if text.is_empty() {
            continue;
        }
        if joined.is_empty() {
            joined = text.to_string();
            continue;
        }
        let (before, after) = repair(&joined, text, judge);
        joined = crate::audio_toolkit::chunking::join_transcripts(&[before, after]);
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A judge that answers from a script and records what it was shown.
    struct Scripted {
        reading: Option<JointReading>,
        seen: RefCell<Vec<(Vec<String>, Vec<String>)>>,
    }

    fn judge(mark: Option<&str>, next_upper: bool) -> Scripted {
        Scripted {
            reading: Some(JointReading {
                mark: mark.map(str::to_string),
                next_upper,
            }),
            seen: RefCell::new(Vec::new()),
        }
    }

    impl JointJudge for Scripted {
        fn read(&self, before: &[String], after: &[String]) -> Option<JointReading> {
            self.seen
                .borrow_mut()
                .push((before.to_vec(), after.to_vec()));
            self.reading.clone()
        }
    }

    fn fix(before: &str, after: &str, j: &Scripted) -> String {
        let (b, a) = repair(before, after, j);
        format!("{b} | {a}")
    }

    #[test]
    fn a_continuing_sentence_loses_the_segments_capital() {
        // The owner's dictation, run 4.
        let j = judge(None, false);
        assert_eq!(
            fix("og ikke bare", "Kaster mig hovedløst ud i det,", &j),
            "og ikke bare | kaster mig hovedløst ud i det,"
        );
        assert_eq!(
            fix("så de ikke bare spiller perfekt", "For første gang", &j),
            "så de ikke bare spiller perfekt | for første gang"
        );
        // Whisper's full stop at the end of the segment goes too.
        assert_eq!(
            fix("Selvfølgelig vil jeg gerne have hjælp.", "Men med", &j),
            "Selvfølgelig vil jeg gerne have hjælp | men med"
        );
    }

    #[test]
    fn the_judge_sees_bare_lower_case_words_around_the_joint() {
        let j = judge(None, false);
        repair(
            "Jeg har lige lavet en PR'en, til dig.",
            "Kan du kigge på GitHub-issuet?",
            &j,
        );
        let seen = j.seen.borrow();
        assert_eq!(
            seen[0].0,
            ["jeg", "har", "lige", "lavet", "en", "pr'en", "til", "dig"]
        );
        assert_eq!(seen[0].1, ["kan", "du", "kigge", "på", "github-issuet"]);
    }

    #[test]
    fn a_sentence_boundary_gets_its_mark_and_capital() {
        let j = judge(Some("."), true);
        assert_eq!(
            fix(
                "Jeg har lige lavet en pull request til dig",
                "Kan du sende mig rapporten?",
                &j
            ),
            "Jeg har lige lavet en pull request til dig. | Kan du sende mig rapporten?"
        );
        assert_eq!(
            fix(
                "Min datter skal til tandlæge på torsdag,",
                "vi skal merge branchen.",
                &j
            ),
            "Min datter skal til tandlæge på torsdag. | Vi skal merge branchen."
        );
        // The model's own end mark is used, and a full stop already there stays.
        assert_eq!(
            fix(
                "Hvad tid kommer du",
                "Vi spiser klokken seks.",
                &judge(Some("?"), true)
            ),
            "Hvad tid kommer du? | Vi spiser klokken seks."
        );
        assert_eq!(
            fix("Tak for i dag.", "Vi ses.", &j),
            "Tak for i dag. | Vi ses."
        );
    }

    #[test]
    fn a_comma_the_model_reads_replaces_a_segment_full_stop() {
        let j = judge(Some(","), false);
        assert_eq!(
            fix(
                "Det vigtige for mig er at jeg lærer.",
                "Hvordan det fungerer.",
                &j
            ),
            "Det vigtige for mig er at jeg lærer, | hvordan det fungerer."
        );
        // A comma, colon or semicolon Whisper wrote stays as it is.
        assert_eq!(
            fix("Først det her;", "Så det andet", &judge(None, false)),
            "Først det her; | så det andet"
        );
    }

    #[test]
    fn names_acronyms_and_mixed_case_keep_their_capitals() {
        let name = judge(None, true);
        assert_eq!(
            fix("vi mødes med", "Mette i Aarhus", &name),
            "vi mødes med | Mette i Aarhus"
        );
        let lower = judge(None, false);
        for word in ["PR'en", "API", "GitHub", "iPhone"] {
            let after = format!("{word} er klar");
            assert_eq!(
                fix("så er", &after, &lower),
                format!("så er | {after}"),
                "{word}"
            );
        }
        // "I" at a segment start is nearly always the preposition; the model decides.
        assert_eq!(
            fix("den bedste måde er", "I Paris", &lower),
            "den bedste måde er | i Paris"
        );
        assert_eq!(
            fix("hvad synes", "I om det?", &name),
            "hvad synes | I om det?"
        );
    }

    #[test]
    fn a_heard_question_or_exclamation_mark_stays() {
        let j = judge(None, false);
        assert_eq!(
            fix("Kan du komme i morgen?", "Det ville være godt.", &j),
            "Kan du komme i morgen? | Det ville være godt."
        );
        assert_eq!(
            fix("Pas på!", "der kommer en bil", &j),
            "Pas på! | Der kommer en bil"
        );
    }

    #[test]
    fn without_a_reading_or_words_nothing_changes() {
        let silent = Scripted {
            reading: None,
            seen: RefCell::new(Vec::new()),
        };
        assert_eq!(
            fix("og ikke bare", "Kaster mig", &silent),
            "og ikke bare | Kaster mig"
        );
        let j = judge(None, false);
        assert_eq!(fix("...", "Kaster mig", &j), "... | Kaster mig");
        assert_eq!(fix("og ikke bare", "", &j), "og ikke bare | ");
        assert!(j.seen.borrow().is_empty());
    }

    #[test]
    fn join_repairs_every_joint_or_joins_as_is_without_a_judge() {
        let texts = [
            "Det er vigtigt for mig",
            "At jeg lærer det.",
            "Og at det virker",
        ];
        assert_eq!(
            join(&texts, Some(&judge(None, false))),
            "Det er vigtigt for mig at jeg lærer det og at det virker"
        );
        assert_eq!(
            join(&texts, None),
            "Det er vigtigt for mig At jeg lærer det. Og at det virker"
        );
        assert_eq!(join(&["", "Hej", "  "], Some(&judge(None, false))), "Hej");
    }
}
