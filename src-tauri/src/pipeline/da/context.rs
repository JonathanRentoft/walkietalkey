//! The context prompt for each chunk of a live decode (DESK-46, spec 6.4 step
//! 3): the end of the previous chunk's text, or for the first chunk a short,
//! well-punctuated Danish sentence, which pulls Whisper-family models towards
//! punctuated, cased output. transcribe.cpp fits it into Whisper's prompt slot
//! together with the vocabulary, trimming the context first.

/// The first chunk's context in Danish: short, with full stops and commas.
pub const FIRST_CHUNK_PROMPT_DA: &str =
    "Hej. Det her er en diktering på dansk, med punktum, komma og store bogstaver.";

/// How much of the previous chunk's text is passed on. Whisper's prompt slot
/// is 223 tokens shared with the vocabulary (about 150 tokens, DESK-66), and
/// transcribe.cpp keeps the most recent context tokens when it must trim.
pub const CONTEXT_TAIL_CHARS: usize = 300;

/// The context prompt for the next chunk: the end of `previous` (the last
/// chunk's text), or the Danish first-chunk sentence when there is none yet
/// and the run language is Danish.
pub fn chunk_prompt(previous: Option<&str>, language: Option<&str>) -> Option<String> {
    let previous = previous.map(str::trim).filter(|text| !text.is_empty());
    match previous {
        Some(text) => Some(tail_from_word_start(text, CONTEXT_TAIL_CHARS).to_string()),
        None if language == Some("da") => Some(FIRST_CHUNK_PROMPT_DA.to_string()),
        None => None,
    }
}

/// The last `max_chars` characters of `text`, moved forward to the start of a
/// word when the cut falls inside one.
fn tail_from_word_start(text: &str, max_chars: usize) -> &str {
    let count = text.chars().count();
    if count <= max_chars {
        return text;
    }
    let (cut, _) = text
        .char_indices()
        .nth(count - max_chars)
        .expect("count > max_chars, so the index exists");
    let tail = &text[cut..];
    if text[..cut].ends_with(char::is_whitespace) {
        return tail.trim_start();
    }
    match tail.find(char::is_whitespace) {
        Some(space) => tail[space..].trim_start(),
        None => tail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_danish_chunk_gets_the_punctuated_sentence() {
        assert_eq!(
            chunk_prompt(None, Some("da")).as_deref(),
            Some(FIRST_CHUNK_PROMPT_DA)
        );
        assert_eq!(
            chunk_prompt(Some("   "), Some("da")).as_deref(),
            Some(FIRST_CHUNK_PROMPT_DA)
        );
        assert!(FIRST_CHUNK_PROMPT_DA.ends_with('.'));
        assert!(FIRST_CHUNK_PROMPT_DA.contains(','));
    }

    #[test]
    fn other_languages_get_no_first_prompt() {
        assert_eq!(chunk_prompt(None, Some("en")), None);
        assert_eq!(chunk_prompt(None, None), None);
    }

    #[test]
    fn later_chunks_get_the_previous_text() {
        assert_eq!(
            chunk_prompt(Some(" Vi ses i morgen. "), Some("da")).as_deref(),
            Some("Vi ses i morgen.")
        );
        // Whatever the language, the previous text is the context.
        assert_eq!(
            chunk_prompt(Some("See you."), Some("en")).as_deref(),
            Some("See you.")
        );
    }

    #[test]
    fn long_previous_text_keeps_its_end_from_a_word_start() {
        let previous = "første ".repeat(80) + "og her er slutningen af det forrige stykke.";
        let prompt = chunk_prompt(Some(&previous), Some("da")).unwrap();
        assert!(prompt.chars().count() <= CONTEXT_TAIL_CHARS);
        assert!(prompt.ends_with("af det forrige stykke."));
        assert!(previous.ends_with(&prompt));
        // It starts at a word, not in the middle of one.
        let start = previous.len() - prompt.len();
        assert_eq!(&previous[start - 1..start], " ");
    }

    #[test]
    fn multibyte_text_is_cut_on_char_boundaries() {
        let previous = "æøå ".repeat(200);
        let prompt = chunk_prompt(Some(&previous), Some("da")).unwrap();
        assert!(prompt.chars().count() <= CONTEXT_TAIL_CHARS);
        assert!(prompt.starts_with("æøå"));
    }
}
