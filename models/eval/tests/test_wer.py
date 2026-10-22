from wt_eval.wer import Counts, corpus_wer, word_errors


def test_identical():
    assert word_errors(["a", "b"], ["a", "b"]) == Counts(sub=0, dele=0, ins=0, ref=2)


def test_substitution_deletion_insertion():
    assert word_errors("a b c d".split(), "a x c d".split()) == Counts(sub=1, dele=0, ins=0, ref=4)
    assert word_errors("a b c d".split(), "a c d".split()) == Counts(sub=0, dele=1, ins=0, ref=4)
    assert word_errors("a b c d".split(), "a b c d e".split()) == Counts(sub=0, dele=0, ins=1, ref=4)
    c = word_errors("hej med dig min ven".split(), "hej dig min gode ven".split())
    assert (c.sub, c.dele, c.ins, c.errors) == (0, 1, 1, 2)


def test_equal_cost_alignments_count_the_minimum_number_of_edits():
    c = word_errors("the cat sat on the mat".split(), "the cat sit on mat now".split())
    assert c.errors == 3


def test_empty_hypothesis_is_all_deletions():
    assert word_errors(["a", "b", "c"], []) == Counts(sub=0, dele=3, ins=0, ref=3)


def test_empty_reference_counts_insertions():
    assert word_errors([], ["x"]) == Counts(sub=0, dele=0, ins=1, ref=0)


def test_corpus_wer_is_total_errors_over_total_reference_words():
    a = Counts(sub=1, dele=0, ins=0, ref=4)
    b = Counts(sub=0, dele=1, ins=1, ref=6)
    assert corpus_wer([a, b]) == 3 / 10


def test_corpus_wer_of_nothing_is_zero():
    assert corpus_wer([]) == 0.0
