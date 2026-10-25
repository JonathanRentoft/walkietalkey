"""The committed pilot sentences (training/data/pilot.csv, run 7): twelve sentences a person
dictates at work, half plain Danish and half with English terms, apart from everything else."""

from __future__ import annotations

from functools import cache

from test_sentences_data import OWNER_TEST_SENTENCES, jaccard, squash
from wt_train.exam import load_exam
from wt_train.harness import normalize
from wt_train.paths import EXAM_YAML, PILOT_CSV, SENTENCES_CSV, SPELLING_YAML
from wt_train.pilot import load_pilot
from wt_train.sentences import load_sentences, word_count
from wt_train.spelling import load_spelling

NEAR_DUPLICATE = 0.6


@cache
def rows():
    return tuple(load_pilot(PILOT_CSV))


def test_twelve_sentences_half_with_terms():
    assert [s.id for s in rows()] == [f"pilot-{i:02d}" for i in range(1, 13)]
    assert sum(s.kind == "terms" for s in rows()) == 6 and sum(s.kind == "plain" for s in rows()) == 6


def test_terms_in_their_forms_and_plain_without():
    spelling = load_spelling(SPELLING_YAML)
    for s in rows():
        hits = spelling.find_terms(s.text)
        assert (len(hits) >= 2) if s.kind == "terms" else not hits, (s.id, [h.form for h in hits])
        assert spelling.unconventional(s.text) == [], s.id
    assert len({h.term for s in rows() for h in spelling.find_terms(s.text)}) >= 12


def test_like_the_sentence_list_typography():
    for s in rows():
        assert 4 <= word_count(s.text) <= 20, s.id
        assert s.text[0].isupper() and s.text[-1] in ".?", s.id
        assert not any(c in s.text for c in "—–\"’“”«»;"), s.id
        assert not any(c.isdigit() for c in s.text), s.id
    assert len({squash(s.text) for s in rows()}) == 12


def test_no_pilot_sentence_is_in_the_sentence_list_or_close_to_one():
    sentences = load_sentences(SENTENCES_CSV)
    keys = {normalize(s.text) for s in sentences}
    for p in rows():
        assert normalize(p.text) not in keys, p.id
        assert p.id not in {s.id for s in sentences}
        close = [s.id for s in sentences if jaccard(s.text, p.text) >= NEAR_DUPLICATE]
        assert close == [], (p.id, close)


def test_no_pilot_sentence_is_in_the_exam_or_among_the_owners_test_sentences():
    paragraphs = [normalize(p.text) for p in load_exam(EXAM_YAML)]
    for p in rows():
        key = normalize(p.text)
        assert not any(f" {key} " in f" {para} " for para in paragraphs), p.id
        for owner in OWNER_TEST_SENTENCES:
            assert jaccard(p.text, owner) < 0.5, (p.id, owner)


def test_the_pilot_takes_are_git_ignored():
    from wt_train.paths import REPO

    assert "training/data/pilot/" in (REPO / ".gitignore").read_text().splitlines()
