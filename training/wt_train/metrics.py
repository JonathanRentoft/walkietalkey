"""Scores: WER, CER and English-term accuracy.

Text normalisation is the accuracy job's own, imported from
``models/eval/wt_eval/normalize.py`` and applied identically to reference and
hypothesis: Unicode NFKC and lower case; numbers written as spoken Danish
("800.000" -> "otte hundrede tusind", "3,5" -> "tre komma fem", a lone
1100-1999 read as a year); "%" and "&" spelled out; every character that is
not a letter or digit becomes a space; number-word variants folded
("tusinde" -> "tusind"); whitespace collapsed. Its docstring lists the known
limits (ordinals, clock times, abbreviations).

* **WER** is the word-level Levenshtein distance between the normalised texts
  (``wt_eval/wer.py``), summed over clips and divided by the reference words.
* **CER** is the same over characters of the normalised texts, single spaces
  included, divided by the reference characters.
* **English terms**: the reference's terms are found with
  ``Spelling.find_terms`` (training/data/spelling.yaml). The hypothesis is first
  re-spelled with ``Spelling.apply`` (so "deploy'e" counts as "deploye"), then
  its terms are found the same way. Both counts are multiset matches, so a term
  said twice must come out twice; positions are not compared.
    - strict: the same form of the same term ("deployede" for "deployede").
    - lenient: any form of the same term ("deployer" for "deployede"), like the
      owner's ten-sentence test ("3 of 8"), which accepts any Danish ending.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from .harness import Counts, bootstrap_ci, corpus_wer, normalize, word_errors
from .spelling import Spelling


def edit_distance(a: str, b: str) -> int:
    """Levenshtein distance between two strings (one row of integers)."""
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


@dataclass(frozen=True)
class TermCounts:
    total: int
    strict: int
    lenient: int
    missed: tuple[str, ...]

    @staticmethod
    def zero() -> "TermCounts":
        return TermCounts(0, 0, 0, ())


def term_counts(spelling: Spelling | None, reference: str, hypothesis: str) -> TermCounts:
    if spelling is None:
        return TermCounts.zero()
    ref = spelling.find_terms(reference)
    hyp = spelling.find_terms(spelling.apply(hypothesis))
    ref_forms = Counter(h.form.casefold() for h in ref)
    hyp_forms = Counter(h.form.casefold() for h in hyp)
    ref_terms = Counter(h.term for h in ref)
    hyp_terms = Counter(h.term for h in hyp)
    strict = sum((ref_forms & hyp_forms).values())
    lenient = sum((ref_terms & hyp_terms).values())
    # The reference forms the hypothesis did not have (strict), in reference order.
    left = Counter(hyp_forms)
    missed = []
    for h in ref:
        key = h.form.casefold()
        if left[key] > 0:
            left[key] -= 1
        else:
            missed.append(h.form)
    return TermCounts(total=len(ref), strict=strict, lenient=lenient, missed=tuple(missed))


def score_clip(clip_id: str, reference: str, hypothesis: str, spelling: Spelling | None = None,
               error: str | None = None) -> dict:
    """One per-clip row: normalised texts, word and character edits, term counts."""
    ref_norm, hyp_norm = normalize(reference), normalize(hypothesis)
    words = word_errors(ref_norm.split(), hyp_norm.split())
    terms = term_counts(spelling, reference, hypothesis)
    return {
        "id": clip_id, "reference": reference, "hypothesis": hypothesis,
        "ref_norm": ref_norm, "hyp_norm": hyp_norm,
        "sub": words.sub, "del": words.dele, "ins": words.ins, "ref_words": words.ref,
        "char_errors": edit_distance(ref_norm, hyp_norm), "ref_chars": len(ref_norm),
        "terms": terms.total, "terms_strict": terms.strict, "terms_lenient": terms.lenient,
        "terms_missed": list(terms.missed), "error": error,
    }


def summarize(rows: list[dict]) -> dict:
    counts = [Counts(sub=r["sub"], dele=r["del"], ins=r["ins"], ref=r["ref_words"]) for r in rows]
    ref_chars = sum(r["ref_chars"] for r in rows)
    terms = sum(r["terms"] for r in rows)
    strict = sum(r["terms_strict"] for r in rows)
    lenient = sum(r["terms_lenient"] for r in rows)
    return {
        "n": len(rows),
        "wer": corpus_wer(counts),
        "wer_ci95": list(bootstrap_ci(counts)),
        "cer": sum(r["char_errors"] for r in rows) / ref_chars if ref_chars else 0.0,
        "reference_words": sum(c.ref for c in counts),
        "terms": terms,
        "terms_strict": strict,
        "terms_lenient": lenient,
        "term_accuracy_strict": strict / terms if terms else None,
        "term_accuracy_lenient": lenient / terms if terms else None,
        "failed": sum(1 for r in rows if r.get("error")),
        "empty": sum(1 for r in rows if not r["hypothesis"]),
    }
