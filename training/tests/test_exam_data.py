"""The committed exam (training/data/exam.yaml): six long paragraphs, kept apart from training."""

from __future__ import annotations

from wt_train.exam import load_exam
from wt_train.harness import normalize
from wt_train.paths import EXAM_YAML, SENTENCES_CSV, SPELLING_YAML
from wt_train.sentences import load_sentences, word_count
from wt_train.spelling import load_spelling

# Read aloud at 130 to 160 words a minute, one to two minutes.
MIN_WORDS, MAX_WORDS = 170, 300
MIN_TERMS = 10


def test_six_paragraphs_of_one_to_two_minutes():
    exam = load_exam(EXAM_YAML)
    assert [p.id for p in exam] == ["e01", "e02", "e03", "e04", "e05", "e06"]
    for p in exam:
        assert MIN_WORDS <= word_count(p.text) <= MAX_WORDS, (p.id, word_count(p.text))
        assert p.title


def test_terms_in_their_conventional_spellings():
    spelling = load_spelling(SPELLING_YAML)
    seen = set()
    for p in load_exam(EXAM_YAML):
        hits = spelling.find_terms(p.text)
        assert len(hits) >= MIN_TERMS, (p.id, len(hits))
        # Only `forms`: re-spelling changes nothing, so the references need no rewriting.
        assert spelling.apply(p.text) == p.text, p.id
        seen |= {h.term for h in hits}
    assert len(seen) >= 40, sorted(seen)


def test_user_facing_rules():
    for p in load_exam(EXAM_YAML):
        assert "—" not in p.text and "–" not in p.text, p.id
        assert not any(c.isdigit() for c in p.text), p.id


def test_no_training_sentence_is_inside_a_paragraph():
    # The exam must stay unseen: a sentence of the training list read inside a paragraph
    # would leak part of it into training.
    paragraphs = [normalize(p.text) for p in load_exam(EXAM_YAML)]
    for s in load_sentences(SENTENCES_CSV):
        key = normalize(s.text)
        if len(key.split()) < 5:
            continue
        assert not any(f" {key} " in f" {para} " for para in paragraphs), s.id
