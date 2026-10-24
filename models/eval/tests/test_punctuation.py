import pytest

from wt_eval.punctuation import count_marks, marks_per_25_words, needs_pnc, word_count


def test_counts_sentence_marks():
    assert count_marks("Hej, mit navn er Emil. Hvordan går det? Godt!") == 4


def test_semicolon_and_colon_count():
    assert count_marks("Tre ting: a; b og c") == 2


def test_separators_inside_numbers_do_not_count():
    assert count_marks("over 800.000 soldater og 3,5 procent") == 0
    assert count_marks("i 1976.") == 1


def test_word_count_is_whitespace_tokens():
    assert word_count("Hej , mit  navn") == 4
    assert word_count("") == 0


@pytest.mark.parametrize(
    "text, rate",
    [
        ("en to tre fire fem.", 5.0),  # 1 mark / 5 words * 25
        ("", 0.0),
    ],
)
def test_marks_per_25_words(text, rate):
    assert marks_per_25_words(text) == rate


def test_desk41_trigger_is_fewer_than_one_mark_per_25_words():
    unpunctuated = " ".join(["ord"] * 10)
    assert needs_pnc(unpunctuated)
    # 1 mark in 25 words is exactly the threshold: no trigger
    assert not needs_pnc(" ".join(["ord"] * 24) + " ord.")
    # 1 mark in 26 words is below it: trigger
    assert needs_pnc(" ".join(["ord"] * 25) + " ord.")
    # nothing to punctuate
    assert not needs_pnc("")
