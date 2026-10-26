"""WER and CER use the accuracy job's normaliser; term accuracy is strict or lenient."""

import pytest

from wt_train.metrics import edit_distance, score_clip, summarize, term_counts
from wt_train.spelling import Spelling, Term


def spelling() -> Spelling:
    return Spelling([
        Term("deploy", ("deploye", "deployer", "deployede", "deployet"), {"deploy'e": "deploye"}),
        Term("PR", ("PR", "PR'en", "PR'er")),
        Term("GitHub", ("GitHub",)),
    ])


def test_wer_ignores_case_punctuation_and_number_spelling():
    row = score_clip("a", "Vi har 800.000 brugere.", "vi har otte hundrede tusind brugere")
    assert row["sub"] + row["del"] + row["ins"] == 0 and row["char_errors"] == 0


def test_wer_scores_the_same_speech_alike_however_it_is_written():
    # Run 8: FLEURS writes fractions, abbreviations and hyphenated compounds the model writes otherwise.
    row = score_clip("a", "Hjemkomst-chok (det måler 29¾ tommer) e.Kr.",
                     "Hjemkomstchok, der måler 29 trefjerdedele tommer efter Kristi fødsel")
    assert (row["ref_norm"], row["hyp_norm"]) == ("hjemkomstchok det måler niogtyve tre fjerdedele tommer efter kristus",
                                                  "hjemkomstchok der måler niogtyve tre fjerdedele tommer efter kristus")
    assert (row["sub"], row["del"], row["ins"]) == (1, 0, 0)


def test_wer_and_cer_count_errors():
    row = score_clip("a", "Hej med dig", "hej med mig")
    assert (row["sub"], row["del"], row["ins"], row["ref_words"]) == (1, 0, 0, 3)
    assert row["char_errors"] == 1 and row["ref_chars"] == len("hej med dig")


def test_edit_distance():
    assert edit_distance("kitten", "sitting") == 3
    assert edit_distance("", "abc") == 3 and edit_distance("abc", "abc") == 0


def test_strict_needs_the_same_form_and_lenient_any_form():
    t = term_counts(spelling(), "Vi deployede PR'en til GitHub.", "vi deployer pr'en til git hub")
    assert (t.total, t.strict, t.lenient) == (3, 1, 2)
    assert t.missed == ("deployede", "GitHub")


def test_the_hypothesis_is_respelled_before_matching():
    t = term_counts(spelling(), "Du skal deploye den.", "du skal deploy'e den")
    assert (t.strict, t.lenient) == (1, 1)


def test_terms_are_multiset_matched():
    t = term_counts(spelling(), "PR'en og PR'en igen og PR'er", "PR'en og noget andet og PR'er")
    assert (t.total, t.strict, t.lenient) == (3, 2, 2)


def test_no_spelling_means_no_terms():
    assert term_counts(None, "GitHub", "GitHub").total == 0


def test_summarize_pools_words_characters_and_terms():
    s = spelling()
    rows = [score_clip("a", "Vi deployede den.", "vi deployede den", s),
            score_clip("b", "Hej med dig", "hej", s)]
    out = summarize(rows)
    assert out["n"] == 2 and out["wer"] == pytest.approx(2 / 6)
    assert out["terms"] == 1 and out["term_accuracy_strict"] == 1.0
    assert summarize([score_clip("a", "hej", "hej")])["term_accuracy_strict"] is None
