"""Punctuation measure and the DESK-41 trigger, on raw (un-normalised) text.

A punctuation mark is one of . , ? ! ; : that does not sit between two digits
(so "800.000" and "3,5" count nothing). Words are whitespace-separated tokens.
DESK-41 runs Ekko PnC when a text has fewer than 1 mark per 25 words, that is
when marks * 25 < words. Empty text never triggers.
"""

from __future__ import annotations

MARKS = frozenset(".,?!;:")


def count_marks(text: str) -> int:
    n = 0
    for i, ch in enumerate(text):
        if ch not in MARKS:
            continue
        if 0 < i < len(text) - 1 and text[i - 1].isdigit() and text[i + 1].isdigit():
            continue
        n += 1
    return n


def word_count(text: str) -> int:
    return len(text.split())


def marks_per_25_words(text: str) -> float:
    words = word_count(text)
    return count_marks(text) / words * 25 if words else 0.0


def needs_pnc(text: str) -> bool:
    words = word_count(text)
    return words > 0 and count_marks(text) * 25 < words
