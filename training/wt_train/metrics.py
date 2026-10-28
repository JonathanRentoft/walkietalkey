"""Scores: WER, CER and English-term accuracy.

Text normalisation is the accuracy job's own, imported from
``models/eval/wt_eval/normalize.py`` and applied identically to reference and
hypothesis, so the same spoken words score the same however they are written:
Unicode NFKC, accents other than å's ring dropped, lower case; fractions,
abbreviations, units, signs, clock times, ranges and ordinals as their spoken
words (run 8: "29¾" -> "niogtyve tre fjerdedele", "e.Kr." -> "efter kristus",
"11." before a word -> "ellevte"); numbers written as spoken Danish
("800.000" -> "otte hundrede tusind", "3,5" -> "tre komma fem", a lone
1100-1999 read as a year); every character that is not a letter or digit
becomes a space; spelling variants folded ("tusinde" -> "tusind", "selv om" ->
"selvom"); whitespace collapsed. A clip is scored with ``normalize_pair``: a
compound with a hyphen in one text is joined where the other writes it closed.
Its docstring lists the known limits.

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
  Run 8: terms are counted on the owner's own takes only (``counts_terms``).
  FLEURS is plain Danish read aloud, and what spelling.yaml finds there
  ("test", "bug") are ordinary Danish words, so a FLEURS dataset leaves every
  term number empty (``without_terms``).
  Run 12, seen and unseen: with held-out terms (``data.held_out_terms`` of the
  run's or build's config, never trained on), each clip also counts the terms
  among them (``terms_unseen``, ``terms_unseen_strict``, ``terms_unseen_lenient``),
  and a summary carries ``seen`` and ``unseen`` blocks (terms, strict and lenient
  hits and accuracies). Both counts add up per term, so seen is the total minus
  unseen. Without held-out terms everything is seen and there are no blocks.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Collection

from .harness import Counts, bootstrap_ci, corpus_wer, normalize_pair, word_errors
from .spelling import Spelling


TERM_KEYS = ("terms", "terms_strict", "terms_lenient", "term_accuracy_strict", "term_accuracy_lenient")


def counts_terms(dataset: str) -> bool:
    """Whether English-term accuracy means anything on ``dataset``: not on FLEURS
    ("fleurs-da_dk-test", as wt-train eval names it, and its FLEURS check)."""
    return not str(dataset or "").startswith("fleurs-")


def without_terms(summary: dict) -> dict:
    """``summary`` with every term number empty (None) and no seen/unseen blocks: a FLEURS summary."""
    out = {k: v for k, v in summary.items() if k not in TERM_BLOCKS}
    return {**out, **{key: None for key in TERM_KEYS}}


# Run 12: the blocks a summary has when terms were held out.
TERM_BLOCKS = ("seen", "unseen")
UNSEEN_KEYS = ("terms_unseen", "terms_unseen_strict", "terms_unseen_lenient")


def term_block(terms: int, strict: int, lenient: int) -> dict:
    return {"terms": terms, "terms_strict": strict, "terms_lenient": lenient,
            "term_accuracy_strict": strict / terms if terms else None,
            "term_accuracy_lenient": lenient / terms if terms else None}


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


def term_counts(spelling: Spelling | None, reference: str, hypothesis: str,
                only: Collection[str] | None = None) -> TermCounts:
    """The reference's terms and how many the hypothesis has; ``only`` limits it to those terms."""
    if spelling is None:
        return TermCounts.zero()
    ref = spelling.find_terms(reference)
    hyp = spelling.find_terms(spelling.apply(hypothesis))
    if only is not None:
        ref = [h for h in ref if h.term in only]
        hyp = [h for h in hyp if h.term in only]
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
               error: str | None = None, unseen: Collection[str] = ()) -> dict:
    """One per-clip row: normalised texts, word and character edits, term counts (and, with
    held-out terms in ``unseen``, the counts of those alone)."""
    ref_norm, hyp_norm = normalize_pair(reference, hypothesis)
    words = word_errors(ref_norm.split(), hyp_norm.split())
    terms = term_counts(spelling, reference, hypothesis)
    row = {
        "id": clip_id, "reference": reference, "hypothesis": hypothesis,
        "ref_norm": ref_norm, "hyp_norm": hyp_norm,
        "sub": words.sub, "del": words.dele, "ins": words.ins, "ref_words": words.ref,
        "char_errors": edit_distance(ref_norm, hyp_norm), "ref_chars": len(ref_norm),
        "terms": terms.total, "terms_strict": terms.strict, "terms_lenient": terms.lenient,
        "terms_missed": list(terms.missed), "error": error,
    }
    if unseen:
        held = term_counts(spelling, reference, hypothesis, only=frozenset(unseen))
        row.update(terms_unseen=held.total, terms_unseen_strict=held.strict, terms_unseen_lenient=held.lenient)
    return row


def summarize(rows: list[dict]) -> dict:
    counts = [Counts(sub=r["sub"], dele=r["del"], ins=r["ins"], ref=r["ref_words"]) for r in rows]
    ref_chars = sum(r["ref_chars"] for r in rows)
    terms = sum(r["terms"] for r in rows)
    strict = sum(r["terms_strict"] for r in rows)
    lenient = sum(r["terms_lenient"] for r in rows)
    out = {
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
    if any(UNSEEN_KEYS[0] in r for r in rows):
        u = [sum(r.get(k, 0) for r in rows) for k in UNSEEN_KEYS]
        out["seen"] = term_block(terms - u[0], strict - u[1], lenient - u[2])
        out["unseen"] = term_block(*u)
    return out
