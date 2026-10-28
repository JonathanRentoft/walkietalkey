"""Scores per recording condition (device x style: phone whispered, phone normal, Mac normal,
Mac whispered; ``conditions.py``).

The workbench records most takes on the phone, many of them whispered, so one
overall WER hides what matters. Every condition is scored alike, whatever its share
of the mix (run 7 added Mac whispered). ``summaries`` groups per-clip rows (from
``metrics.score_clip`` with a ``condition`` key) and summarises each group with
``metrics.summarize``: WER with its confidence interval, CER and English-term
accuracy, strict and lenient. Clips without a condition (FLEURS, rehearsal, a
plain folder) are left out of the groups; the overall summary covers them.

``for_logging`` flattens the overall and per-condition summaries into one flat
``{name: number}`` dict (``"<dataset>/wer"``, ``"<dataset>/phone-whisper/wer"``,
...), the shape an experiment tracker takes as it is (MLflow's ``log_metrics``).
Run 12: with held-out terms, each summary's ``seen`` and ``unseen`` blocks add
``"<dataset>/seen/term_accuracy_strict"``, ``"<dataset>/<condition>/unseen/terms"``
and so on (terms, strict and lenient accuracy).
``wt-train eval`` returns it and writes it to the run's summary.json.
"""

from __future__ import annotations

from .conditions import IDS
from .metrics import TERM_BLOCKS, summarize

# What a tracker gets of each summary (numbers only; an accuracy without terms is left out).
LOGGED = ("n", "wer", "cer", "terms", "term_accuracy_strict", "term_accuracy_lenient", "failed")


def summaries(rows: list[dict]) -> dict[str, dict]:
    """``{condition: summary}`` for the conditions present, in the order of ``conditions.IDS``."""
    out = {}
    for cid in IDS:
        part = [r for r in rows if r.get("condition") == cid]
        if part:
            out[cid] = summarize(part)
    return out


def _numbers(summary: dict, prefix: str) -> dict[str, float]:
    out = {}
    for key in LOGGED:
        value = summary.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        out[f"{prefix}/{key}"] = value
    lo_hi = summary.get("wer_ci95")
    if isinstance(lo_hi, (list, tuple)) and len(lo_hi) == 2:
        out[f"{prefix}/wer_ci95_low"], out[f"{prefix}/wer_ci95_high"] = float(lo_hi[0]), float(lo_hi[1])
    # Run 12: the terms the model trained on and the held-out ones, apart.
    for block in TERM_BLOCKS:
        part = summary.get(block)
        if isinstance(part, dict):
            for key in ("terms", "term_accuracy_strict", "term_accuracy_lenient"):
                value = part.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    out[f"{prefix}/{block}/{key}"] = value
    return out


def for_logging(overall: dict, by_condition: dict[str, dict], prefix: str) -> dict[str, float]:
    """One flat dict of numbers: ``<prefix>/<metric>`` and ``<prefix>/<condition>/<metric>``."""
    out = _numbers(overall, prefix)
    for cid, summary in by_condition.items():
        out.update(_numbers(summary, f"{prefix}/{cid}"))
    return out
