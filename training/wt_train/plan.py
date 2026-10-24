"""``wt-train plan``: which condition each sentence is recorded in.

Every sentence of ``sentences.csv`` gets exactly one condition (``conditions.py``:
40 % phone whispered, 40 % phone normal, 20 % Mac normal), and a session records
one condition. The plan is dealt per sentence so the mix holds inside each split,
not only overall: sentences are grouped by their split (the shipped experiment
configs' split, :data:`REFERENCE_SPLIT`: seed 1, 10 % validation, 10 % test) and
their kind (terms or plain), and inside a group each sentence, in a fixed order
from a hash of its id, takes the condition furthest below its share. So train,
validation and test each hold the 40/40/20 mix to within a sentence or two, and
every condition gets terms and plain sentences alike.

The plan is written to ``training/data/plan.csv`` (``id,condition``) and
committed, so a sentence keeps its condition, and its takes stay planned, when
the list changes: new sentences are dealt into the gaps, removed ones drop out
(``ensure``, which ``wt-train record`` runs at start). A config with another
seed or other fractions still gets the mix on average.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import os
import sys
from collections import Counter
from pathlib import Path

from .conditions import BY_ID, CONDITIONS, IDS
from .paths import PLAN_CSV, SENTENCES_CSV
from .sentences import Sentence, load_sentences

REFERENCE_SPLIT = {"seed": 1, "validation_fraction": 0.1, "test_fraction": 0.1}
COLUMNS = ["id", "condition"]


def _split(s: Sentence) -> str:
    from .dataset import sentence_key, split_of

    return split_of(sentence_key(s.text), **REFERENCE_SPLIT)


def _order(sentence_id: str) -> bytes:
    return hashlib.sha256(f"plan:{sentence_id}".encode("utf-8")).digest()


def assign(sentences: list[Sentence], existing: dict[str, str] | None = None) -> dict[str, str]:
    """A condition for every sentence; ``existing`` assignments of listed sentences are kept."""
    existing = existing or {}
    groups = {s.id: (_split(s), s.kind) for s in sentences}
    plan = {s.id: existing[s.id] for s in sentences if s.id in existing}
    counts: dict[tuple[str, str], Counter] = {}
    for sid, cid in plan.items():
        counts.setdefault(groups[sid], Counter())[cid] += 1
    for s in sorted((s for s in sentences if s.id not in plan), key=lambda s: _order(s.id)):
        group = counts.setdefault(groups[s.id], Counter())
        n = sum(group.values()) + 1
        best = max(CONDITIONS, key=lambda c: (c.share * n - group[c.id], -CONDITIONS.index(c)))
        plan[s.id] = best.id
        group[best.id] += 1
    return plan


def read_plan(path: Path = PLAN_CSV) -> dict[str, str]:
    with Path(path).open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != COLUMNS:
            raise ValueError(f"{path}: header must be {','.join(COLUMNS)}, got {reader.fieldnames}")
        plan = {}
        for row in reader:
            sid, cid = row["id"].strip(), row["condition"].strip()
            if cid not in BY_ID:
                raise ValueError(f"{path}: {sid} has condition {cid!r}, expected one of {', '.join(IDS)}")
            if sid in plan:
                raise ValueError(f"{path}: {sid} is planned twice")
            plan[sid] = cid
    return plan


def write_plan(path: Path, plan: dict[str, str]) -> None:
    path = Path(path)
    tmp = path.with_name(f".{path.name}.tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(COLUMNS)
        for sid in sorted(plan):
            w.writerow([sid, plan[sid]])
    os.replace(tmp, path)


def ensure(sentences: list[Sentence], path: Path = PLAN_CSV) -> tuple[dict[str, str], dict[str, int]]:
    """The plan for ``sentences``, written back when sentences were added or removed."""
    path = Path(path)
    before = read_plan(path) if path.is_file() else {}
    plan = assign(sentences, before)
    changes = {"added": len(set(plan) - set(before)), "removed": len(set(before) - set(plan))}
    if changes["added"] or changes["removed"] or not path.is_file():
        write_plan(path, plan)
    return plan, changes


def progress(plan: dict[str, str], recorded: dict[str, set[str]]) -> dict[str, dict[str, int]]:
    """Per condition: planned sentences, how many have a take, and takes beyond the plan."""
    out = {}
    for cid in IDS:
        planned = {sid for sid, c in plan.items() if c == cid}
        takes = recorded.get(cid, set())
        out[cid] = {"total": len(planned), "done": len(planned & takes), "extra": len(takes - planned)}
    return out


def mix_table(sentences: list[Sentence], plan: dict[str, str]) -> str:
    counts: dict[str, Counter] = {}
    for s in sentences:
        counts.setdefault(_split(s), Counter())[plan[s.id]] += 1
    width = max(len(c) for c in IDS)
    lines = [f"{'split':<11} " + " ".join(f"{c:>{width}}" for c in IDS) + f" {'total':>6}"]
    for name in ("train", "validation", "test"):
        c = counts.get(name, Counter())
        n = sum(c.values())
        cells = " ".join(f"{c[cid]:>{width - 7}} ({c[cid] / n * 100 if n else 0:>3.0f} %)" for cid in IDS)
        lines.append(f"{name:<11} {cells} {n:>6}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train plan", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sentences", type=Path, default=SENTENCES_CSV, help="sentence list (id,text,kind)")
    p.add_argument("--plan", type=Path, default=PLAN_CSV, help="the plan file to update")
    a = p.parse_args(argv)
    items = load_sentences(a.sentences)
    plan, changes = ensure(items, a.plan)
    print(f"plan {a.plan}: {len(plan)} sentences ({changes['added']} added, {changes['removed']} removed)")
    print(mix_table(items, plan))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
