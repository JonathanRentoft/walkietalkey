"""Word alignment for the reports (run 7): which words were substituted, deleted
or inserted, so a page can colour them.

The alignment is the accuracy job's (``models/eval/wt_eval/wer.py``): minimum
edits over the normalised words, ties preferring substitution, then deletion,
then insertion, so a diff never disagrees with the WER beside it. Also a
bootstrap interval for any error ratio (CER as well as WER), resampling clips
with a fixed seed like ``wt_eval.wer.bootstrap_ci``.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class Op:
    """``eq``, ``sub``, ``del`` or ``ins``, with the reference and the model's word."""

    kind: str
    ref: str | None
    hyp: str | None


def align(ref: Sequence[str], hyp: Sequence[str]) -> list[Op]:
    n, m = len(ref), len(hyp)
    # cost[i][j] = (edits, subs, dels, ins) for ref[:i] vs hyp[:j], as in wt_eval.wer.word_errors
    cost = [[(j, 0, 0, j) for j in range(m + 1)]]
    back = [["ins"] * (m + 1)]
    back[0][0] = ""
    for i in range(1, n + 1):
        row, moves = [(i, 0, i, 0)], ["del"]
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                row.append(cost[i - 1][j - 1])
                moves.append("eq")
                continue
            s, d, ins = cost[i - 1][j - 1], cost[i - 1][j], row[j - 1]
            options = [((s[0] + 1, s[1] + 1, s[2], s[3]), "sub"), ((d[0] + 1, d[1], d[2] + 1, d[3]), "del"),
                       ((ins[0] + 1, ins[1], ins[2], ins[3] + 1), "ins")]
            best = min(options, key=lambda o: o[0][0])  # first minimum: sub, then del, then ins
            row.append(best[0])
            moves.append(best[1])
        cost.append(row)
        back.append(moves)
    ops: list[Op] = []
    i, j = n, m
    while i or j:
        move = back[i][j]
        if move in ("eq", "sub"):
            ops.append(Op(move, ref[i - 1], hyp[j - 1]))
            i, j = i - 1, j - 1
        elif move == "del":
            ops.append(Op("del", ref[i - 1], None))
            i -= 1
        else:
            ops.append(Op("ins", None, hyp[j - 1]))
            j -= 1
    return ops[::-1]


def counts(ops: Sequence[Op]) -> tuple[int, int, int]:
    """(substitutions, deletions, insertions)."""
    return (sum(o.kind == "sub" for o in ops), sum(o.kind == "del" for o in ops),
            sum(o.kind == "ins" for o in ops))


def bootstrap_ratio_ci(errors: Sequence[int], totals: Sequence[int], resamples: int = 1000,
                       seed: int = 0) -> tuple[float, float]:
    """95 % percentile bootstrap interval of sum(errors) / sum(totals), resampling clips."""
    if not errors:
        return (0.0, 0.0)
    rng = random.Random(seed)
    n = len(errors)
    stats = []
    for _ in range(resamples):
        e = t = 0
        for _ in range(n):
            k = rng.randrange(n)
            e += errors[k]
            t += totals[k]
        stats.append(e / t if t else 0.0)
    stats.sort()
    return (round(stats[int(0.025 * (resamples - 1))], 6), round(stats[int(0.975 * (resamples - 1))], 6))
