"""Word error rate: Levenshtein alignment over normalised words."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence


@dataclass(frozen=True)
class Counts:
    sub: int
    dele: int
    ins: int
    ref: int

    @property
    def errors(self) -> int:
        return self.sub + self.dele + self.ins


def word_errors(ref: Sequence[str], hyp: Sequence[str]) -> Counts:
    """Minimum edit alignment; ties prefer substitution, then deletion, then insertion."""
    n, m = len(ref), len(hyp)
    # cost[i][j] = (edits, subs, dels, ins) for ref[:i] vs hyp[:j]
    prev = [(j, 0, 0, j) for j in range(m + 1)]
    for i in range(1, n + 1):
        cur = [(i, 0, i, 0)] + [None] * m  # type: ignore[list-item]
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur[j] = prev[j - 1]
                continue
            s, d, ins = prev[j - 1], prev[j], cur[j - 1]
            cur[j] = min(
                (s[0] + 1, s[1] + 1, s[2], s[3]),
                (d[0] + 1, d[1], d[2] + 1, d[3]),
                (ins[0] + 1, ins[1], ins[2], ins[3] + 1),
                key=lambda t: t[0],
            )
        prev = cur
    _, sub, dele, ins = prev[m]
    return Counts(sub=sub, dele=dele, ins=ins, ref=n)


def corpus_wer(counts: Iterable[Counts]) -> float:
    errors = ref = 0
    for c in counts:
        errors += c.errors
        ref += c.ref
    return errors / ref if ref else 0.0


def bootstrap_ci(counts: Sequence[Counts], resamples: int = 1000, seed: int = 0) -> tuple[float, float]:
    """95 % percentile bootstrap interval of the corpus WER, resampling clips
    with replacement (fixed seed, so a rerun gives the same interval)."""
    import random

    if not counts:
        return (0.0, 0.0)
    rng = random.Random(seed)
    n = len(counts)
    errors = [c.errors for c in counts]
    refs = [c.ref for c in counts]
    stats = []
    for _ in range(resamples):
        e = r = 0
        for _ in range(n):
            i = rng.randrange(n)
            e += errors[i]
            r += refs[i]
        stats.append(e / r if r else 0.0)
    stats.sort()
    lo = stats[int(0.025 * (resamples - 1))]
    hi = stats[int(0.975 * (resamples - 1))]
    return (round(lo, 6), round(hi, 6))
