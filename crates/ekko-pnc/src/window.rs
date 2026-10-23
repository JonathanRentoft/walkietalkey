//! The reference runtime's windowing (`Punctuator._punctuate_words_locked`):
//! windows of at most `max_length` tokens (special tokens included) that
//! re-read `overlap_words` words of left context and hold back up to
//! `overlap_words` words of right context, which the next window emits.

/// One model call: words `[context_start, end)` are fed to the model and the
/// predictions for words `[emit_start, emit_end)` are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub context_start: usize,
    pub end: usize,
    pub emit_start: usize,
    pub emit_end: usize,
}

/// `token_counts[i]` is the number of tokens word `i` encodes to when the whole
/// text is encoded once; `special_tokens` is the number of tokens without a
/// word (`[CLS]`, `[SEP]`) in that encoding.
pub fn plan(
    token_counts: &[usize],
    special_tokens: usize,
    max_length: usize,
    overlap_words: usize,
) -> Vec<Window> {
    let n = token_counts.len();
    // prefix[i] = tokens of words [0, i).
    let mut prefix = Vec::with_capacity(n + 1);
    prefix.push(0usize);
    for &c in token_counts {
        prefix.push(prefix.last().unwrap() + c);
    }
    // bisect.bisect_right(prefix, x) - 1, computed in i64 like Python ints.
    let last_fitting = |budget: i64| -> i64 {
        let idx = prefix.partition_point(|&p| (p as i64) <= budget);
        idx as i64 - 1
    };
    let max_window_end = |start: usize| -> usize {
        let budget = prefix[start] as i64 + max_length as i64 - special_tokens as i64;
        let fitting = last_fitting(budget).max(start as i64 + 1) as usize;
        n.min(start + max_length).min(fitting)
    };

    let mut windows = Vec::new();
    let mut next_word = 0usize;
    while next_word < n {
        let mut context_start = next_word.saturating_sub(overlap_words);
        let mut end = max_window_end(context_start);
        if end <= next_word {
            context_start = next_word;
            end = max_window_end(context_start);
        }
        let emit_end = if end == n {
            end
        } else {
            (next_word + 1).max(end.saturating_sub(overlap_words))
        };
        windows.push(Window {
            context_start,
            end,
            emit_start: next_word,
            emit_end,
        });
        next_word = emit_end;
    }
    windows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(context_start: usize, end: usize, emit_start: usize, emit_end: usize) -> Window {
        Window {
            context_start,
            end,
            emit_start,
            emit_end,
        }
    }

    #[test]
    fn short_text_is_one_window() {
        assert_eq!(plan(&[1, 2, 1], 2, 128, 12), vec![w(0, 3, 0, 3)]);
    }

    #[test]
    fn empty_text_has_no_windows() {
        assert!(plan(&[], 2, 128, 12).is_empty());
    }

    #[test]
    fn overlapping_windows() {
        // 10 one-token words, 6 tokens of budget per window, 2 words of overlap.
        assert_eq!(
            plan(&[1; 10], 2, 8, 2),
            vec![w(0, 6, 0, 4), w(2, 8, 4, 6), w(4, 10, 6, 10)]
        );
    }

    #[test]
    fn a_word_longer_than_the_budget_gets_its_own_window() {
        assert_eq!(
            plan(&[1, 20, 1], 2, 8, 2),
            vec![w(0, 1, 0, 1), w(1, 2, 1, 2), w(2, 3, 2, 3)]
        );
    }

    #[test]
    fn words_without_tokens_ride_along() {
        // Word 1 encodes to nothing (e.g. a lone control character).
        assert_eq!(plan(&[1, 0, 1], 2, 128, 12), vec![w(0, 3, 0, 3)]);
    }

    #[test]
    fn no_overlap() {
        assert_eq!(
            plan(&[1; 5], 2, 4, 0),
            vec![w(0, 2, 0, 2), w(2, 4, 2, 4), w(4, 5, 4, 5)]
        );
    }

    #[test]
    fn every_word_is_emitted_exactly_once() {
        let counts: Vec<usize> = (0..500).map(|i| 1 + (i * 7) % 4).collect();
        let windows = plan(&counts, 2, 128, 12);
        let mut next = 0;
        for win in &windows {
            assert_eq!(win.emit_start, next);
            assert!(win.context_start <= win.emit_start && win.emit_end <= win.end);
            let tokens: usize = counts[win.context_start..win.end].iter().sum();
            assert!(tokens + 2 <= 128 || win.end - win.context_start == 1);
            next = win.emit_end;
        }
        assert_eq!(next, counts.len());
    }
}
