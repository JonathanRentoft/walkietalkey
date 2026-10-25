"""``wt-train plan``: which condition each sentence is recorded in.

Every sentence of ``sentences.csv`` gets exactly one condition (``conditions.py``),
and a session records one condition. The mix says which share of the sentences
each condition gets, in percent: by default 40 % phone whispered, 40 % phone
normal, 20 % Mac normal and 0 % Mac whispered. ``wt-train plan --mix
phone-whisper=40,phone-normal=40,mac-normal=20`` sets another (whole percents
summing to 100; a condition left out gets 0). The mix is kept in ``mix.yaml``
next to the plan (``training/data/mix.yaml``, committed), so ``wt-train record``
follows it and records only the conditions with a share.

The plan is dealt per sentence so the mix holds inside each split, not only overall:
sentences are grouped by their split (the shipped experiment configs' split,
:data:`REFERENCE_SPLIT`: seed 1, 10 % validation, 10 % test) and their kind
(terms or plain), and inside a group each sentence, in a fixed order from a hash
of its id, takes the condition with a share that is furthest below that share. So
train, validation and test each hold the mix to within a sentence or two, and
every condition gets terms and plain sentences alike.

The plan is written to ``training/data/plan.csv`` (``id,condition``) and
committed, so a sentence keeps its condition, and its takes stay planned, when
the list changes: new sentences are dealt into the gaps, removed ones drop out
(``ensure``, which ``wt-train record`` runs at start). When ``--mix`` changes the
mix, every sentence that already has a take in its planned condition keeps that
condition, and every other sentence is dealt again to fit the new mix within each
split. Edit the mix with ``--mix`` rather than in mix.yaml: an edit there alone
deals nothing again. A config with another seed or other fractions still gets the
mix on average.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import os
import re
import sys
from collections import Counter
from pathlib import Path

import yaml

from .conditions import BY_ID, CONDITIONS, DEFAULT_MIX, IDS
from .paths import PLAN_CSV, RECORDINGS, SENTENCES_CSV
from .sentences import Sentence, load_sentences

REFERENCE_SPLIT = {"seed": 1, "validation_fraction": 0.1, "test_fraction": 0.1}
COLUMNS = ["id", "condition"]


def _split(s: Sentence) -> str:
    from .dataset import sentence_key, split_of

    return split_of(sentence_key(s.text), **REFERENCE_SPLIT)


def _order(sentence_id: str) -> bytes:
    return hashlib.sha256(f"plan:{sentence_id}".encode("utf-8")).digest()


def assign(sentences: list[Sentence], existing: dict[str, str] | None = None,
           mix: dict[str, int] | None = None) -> dict[str, str]:
    """A condition for every sentence; ``existing`` assignments of listed sentences are kept.
    The others are dealt to the conditions with a share in ``mix`` (percent; the default mix)."""
    existing = existing or {}
    shares = mix or DEFAULT_MIX
    dealt = [c for c in CONDITIONS if shares.get(c.id, 0) > 0]
    groups = {s.id: (_split(s), s.kind) for s in sentences}
    plan = {s.id: existing[s.id] for s in sentences if s.id in existing}
    counts: dict[tuple[str, str], Counter] = {}
    for sid, cid in plan.items():
        counts.setdefault(groups[sid], Counter())[cid] += 1
    for s in sorted((s for s in sentences if s.id not in plan), key=lambda s: _order(s.id)):
        group = counts.setdefault(groups[s.id], Counter())
        n = sum(group.values()) + 1
        best = max(dealt, key=lambda c: (shares[c.id] / 100 * n - group[c.id], -CONDITIONS.index(c)))
        plan[s.id] = best.id
        group[best.id] += 1
    return plan


# --- the mix ---------------------------------------------------------------------------


def mix_path(plan_path: Path = PLAN_CSV) -> Path:
    """The mix of a plan: ``mix.yaml`` beside it."""
    return Path(plan_path).with_name("mix.yaml")


def _percent(value: object, where: str) -> int:
    if isinstance(value, str) and re.fullmatch(r"\s*\d+\s*", value):
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
        raise ValueError(f"{where}: a share is a whole percent from 0 to 100, got {value!r}")
    return value


def _complete(given: dict[str, int], where: str) -> dict[str, int]:
    mix = {cid: given.get(cid, 0) for cid in IDS}
    total = sum(mix.values())
    if total != 100:
        raise ValueError(f"{where}: the shares add up to {total} %, not 100 %")
    return mix


def parse_mix(text: str) -> dict[str, int]:
    """``phone-whisper=40,phone-normal=40,mac-normal=20`` as a share in percent for every
    condition (0 for one left out); the shares must add up to 100."""
    given: dict[str, int] = {}
    for part in text.split(","):
        if not part.strip():
            continue
        cid, sep, value = (x.strip() for x in part.partition("="))
        if not sep:
            raise ValueError(f"--mix: write <condition>=<percent>, e.g. phone-whisper=40, not {part.strip()!r}")
        if cid not in BY_ID:
            raise ValueError(f"--mix: unknown condition {cid!r}; one of {', '.join(IDS)}")
        if cid in given:
            raise ValueError(f"--mix: {cid} is given twice")
        given[cid] = _percent(value, f"--mix {cid}")
    return _complete(given, "--mix")


def read_mix(path: Path) -> dict[str, int]:
    """The mix in ``path`` (``mix: {condition: percent}``), or the default mix if there is none."""
    path = Path(path)
    if not path.is_file():
        return dict(DEFAULT_MIX)
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict) or set(raw) != {"mix"} or not isinstance(raw["mix"], dict):
        raise ValueError(f"{path}: expected only 'mix', a mapping of condition to percent")
    unknown = sorted(str(k) for k in raw["mix"] if k not in BY_ID)
    if unknown:
        raise ValueError(f"{path}: unknown condition(s) {', '.join(unknown)}; one of {', '.join(IDS)}")
    return _complete({cid: _percent(v, f"{path} {cid}") for cid, v in raw["mix"].items()}, str(path))


MIX_HEADER = """\
# The recording mix: the share of the sentences each condition gets, in percent
# (conditions.py). Written by `wt-train plan --mix phone-whisper=40,...`, which also
# deals the sentences without a take again to fit it; `wt-train record` records only
# the conditions with a share. Change it with --mix: an edit here alone deals nothing
# again.
"""


def write_mix(path: Path, mix: dict[str, int]) -> None:
    path = Path(path)
    body = MIX_HEADER + "mix:\n" + "".join(f"  {cid}: {mix.get(cid, 0)}\n" for cid in IDS)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(body, encoding="utf-8")
    os.replace(tmp, path)


def format_mix(mix: dict[str, int]) -> str:
    """The conditions with a share: ``phone-whisper 40 %, phone-normal 40 %, mac-normal 20 %``."""
    return ", ".join(f"{cid} {mix[cid]} %" for cid in IDS if mix.get(cid, 0) > 0)


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


def ensure(sentences: list[Sentence], path: Path = PLAN_CSV, *, mix: dict[str, int] | None = None,
           recorded: dict[str, set[str]] | None = None) -> tuple[dict[str, str], dict[str, int]]:
    """The plan for ``sentences``, written back when it changed, under the mix kept beside it.

    ``mix`` (percent per condition) replaces that mix. If it differs, a sentence keeps its
    planned condition only when it has a take in it (``recorded``: condition -> sentence ids,
    :func:`takes_of`), and the rest are dealt again. Returns the plan and how many sentences
    were added, removed and moved to another condition."""
    path = Path(path)
    before = read_plan(path) if path.is_file() else {}
    where = mix_path(path)
    stored = read_mix(where)
    target = stored if mix is None else {cid: mix.get(cid, 0) for cid in IDS}
    if target != stored:
        recorded = recorded or {}
        kept = {sid: cid for sid, cid in before.items() if sid in recorded.get(cid, ())}
    else:
        kept = before
    plan = assign(sentences, kept, target)
    changes = {"added": len(set(plan) - set(before)), "removed": len(set(before) - set(plan)),
               "moved": sum(1 for sid, cid in plan.items() if sid in before and before[sid] != cid)}
    if plan != before or not path.is_file():
        write_plan(path, plan)
    if target != stored or not where.is_file():
        write_mix(where, target)
    return plan, changes


def takes_of(root: Path, sentences: list[Sentence]) -> dict[str, set[str]]:
    """Per condition, the sentences with a take in it in ``root`` (``recordings/``), its text
    current or not, as the recorder counts them (run 4's browser takes are not)."""
    from .recorder.takes import TakeStore

    texts = {s.id: s.text for s in sentences}
    return {cid: {sid for sid in texts if TakeStore(root, cid, texts).status(sid) != "missing"} for cid in IDS}


def progress(plan: dict[str, str], recorded: dict[str, set[str]]) -> dict[str, dict[str, int]]:
    """Per condition: planned sentences, how many have a take, and takes beyond the plan."""
    out = {}
    for cid in IDS:
        planned = {sid for sid, c in plan.items() if c == cid}
        takes = recorded.get(cid, set())
        out[cid] = {"total": len(planned), "done": len(planned & takes), "extra": len(takes - planned)}
    return out


def mix_table(sentences: list[Sentence], plan: dict[str, str], mix: dict[str, int] | None = None) -> str:
    """Per split, the sentences of each condition with a share (or with planned sentences)."""
    shares = mix or DEFAULT_MIX
    columns = [cid for cid in IDS if shares.get(cid, 0) > 0 or cid in plan.values()]
    counts: dict[str, Counter] = {}
    for s in sentences:
        counts.setdefault(_split(s), Counter())[plan[s.id]] += 1
    width = max(len(c) for c in columns)
    lines = [f"{'split':<11} " + " ".join(f"{c:>{width}}" for c in columns) + f" {'total':>6}"]
    for name in ("train", "validation", "test"):
        c = counts.get(name, Counter())
        n = sum(c.values())
        cells = " ".join(f"{c[cid]:>{width - 7}} ({c[cid] / n * 100 if n else 0:>3.0f} %)" for cid in columns)
        lines.append(f"{name:<11} {cells} {n:>6}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train plan", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sentences", type=Path, default=SENTENCES_CSV, help="sentence list (id,text,kind)")
    p.add_argument("--plan", type=Path, default=PLAN_CSV, help="the plan file to update (its mix.yaml beside it)")
    p.add_argument("--mix", help="the share of the sentences per condition in percent, adding up to 100, e.g. "
                                 "phone-whisper=40,phone-normal=40,mac-normal=20 (a condition left out gets 0)")
    p.add_argument("--recordings", type=Path, default=RECORDINGS,
                   help="the takes: with --mix, a sentence with a take keeps its condition")  # fmt: skip
    a = p.parse_args(argv)
    try:
        mix = parse_mix(a.mix) if a.mix is not None else None
    except ValueError as e:
        p.error(str(e))
    items = load_sentences(a.sentences)
    plan, changes = ensure(items, a.plan, mix=mix, recorded=takes_of(a.recordings, items) if mix else None)
    current = read_mix(mix_path(a.plan))
    print(f"plan {a.plan}: {len(plan)} sentences ({changes['added']} added, {changes['removed']} removed, "
          f"{changes['moved']} moved to another condition)")
    print(f"mix {mix_path(a.plan)}: {format_mix(current)}")
    print(mix_table(items, plan, current))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
