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
sentences are grouped by their split in the split record (run 12, ``splits.py``:
``training/data/splits.csv``, dealt first) and their kind (terms or plain), and
inside a group each sentence, in a fixed order from a hash of its id, takes the
condition with a share that is furthest below that share. So train, validation and
test each hold the mix to within a sentence or two, and every condition gets terms
and plain sentences alike.

The plan is written to ``training/data/plan.csv`` (``id,condition``) and
committed, so a sentence keeps its condition, and its takes stay planned, when
the list changes: new sentences are dealt into the gaps, removed ones drop out.
When ``--mix`` changes the mix, every sentence that already has a take in its
planned condition keeps that condition, and every other sentence is dealt again to
fit the new mix within each split. Edit the mix with ``--mix`` rather than in
mix.yaml: an edit there alone deals nothing again. When the split record moves a
sentence to another split (a config with other split parameters, or ``--redeal``),
the sentence is dealt a condition again in its new split unless it has a take in
its planned one.

:func:`prepare` does all of it in order, and ``wt-train plan``, ``wt-train record``
(at the start of a session), Værkstedet and ``wt-train build`` go through it: the
split record (with the takes on disk and the test lock), the plan, and the same for
the owner's own sentences (``local.py``), whose record and plan live beside them in
the git-ignored ``training/data/local/``. ``wt-train plan --config <yaml>`` deals the
record with that config's split parameters (``data.seed``, the fractions and
``data.held_out_terms``); without it, with the record's own. After the sentence list
changes, regenerate the committed files with::

    uv run --project training wt-train plan --redeal

which deals every sentence without a take again, its split and its condition.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import yaml

from . import splits as split_record
from .conditions import BY_ID, CONDITIONS, DEFAULT_MIX, IDS
from .paths import PLAN_CSV, RECORDINGS, SENTENCES_CSV, SPELLING_YAML
from .sentences import Sentence, load_sentences

COLUMNS = ["id", "condition"]


def _order(sentence_id: str) -> bytes:
    return hashlib.sha256(f"plan:{sentence_id}".encode("utf-8")).digest()


def assign(sentences: list[Sentence], existing: dict[str, str] | None = None,
           mix: dict[str, int] | None = None, splits: dict[str, str] | None = None) -> dict[str, str]:
    """A condition for every sentence; ``existing`` assignments of listed sentences are kept.
    The others are dealt to the conditions with a share in ``mix`` (percent; the default mix),
    per split (``splits``: the split record; a sentence missing from it counts as train) and kind."""
    existing = existing or {}
    shares = mix or DEFAULT_MIX
    dealt = [c for c in CONDITIONS if shares.get(c.id, 0) > 0]
    splits = splits or {}
    groups = {s.id: (splits.get(s.id, "train"), s.kind) for s in sentences}
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
           recorded: dict[str, set[str]] | None = None, splits: dict[str, str] | None = None, moved=(),
           redeal: bool = False, write: bool = True) -> tuple[dict[str, str], dict[str, int]]:
    """The plan for ``sentences``, written back when it changed, under the mix kept beside it.

    ``mix`` (percent per condition) replaces that mix. If it differs, or with ``redeal``, a
    sentence keeps its planned condition only when it has a take in it (``recorded``:
    condition -> sentence ids, :func:`takes_of`), and the rest are dealt again. ``splits`` is
    the split record (default: the one beside the plan, if there is one); a sentence in
    ``moved`` (it changed split) is dealt again too, unless it has a take in its condition.
    ``write=False`` only computes. Returns the plan and how many sentences were added, removed
    and moved to another condition."""
    path = Path(path)
    before = read_plan(path) if path.is_file() else {}
    where = mix_path(path)
    stored = read_mix(where)
    target = stored if mix is None else {cid: mix.get(cid, 0) for cid in IDS}
    recorded = recorded or {}
    moved = set(moved)
    if splits is None and split_record.record_path(path).is_file():
        splits = split_record.read_record(split_record.record_path(path))[0]

    def has_take(sid: str, cid: str) -> bool:
        return sid in recorded.get(cid, ())

    if target != stored or redeal:
        kept = {sid: cid for sid, cid in before.items() if has_take(sid, cid)}
    else:
        kept = {sid: cid for sid, cid in before.items() if sid not in moved or has_take(sid, cid)}
    plan = assign(sentences, kept, target, splits)
    changes = {"added": len(set(plan) - set(before)), "removed": len(set(before) - set(plan)),
               "moved": sum(1 for sid, cid in plan.items() if sid in before and before[sid] != cid)}
    if write and (plan != before or not path.is_file()):
        write_plan(path, plan)
    if write and (target != stored or not where.is_file()):
        write_mix(where, target)
    return plan, changes


# --- the split record, the plan and the owner's own sentences together (run 12) ----------------


@dataclass
class Prepared:
    """What a recording session, a build or Værkstedet works from."""

    sentences: list[Sentence]  # the list, then the owner's own sentences
    listed: list[Sentence]  # the list (sentences.csv)
    own: list[Sentence]  # the owner's own sentences (local.py)
    splits: dict[str, str]  # id -> split, both
    plan: dict[str, str]  # id -> condition, both
    dealt: split_record.Dealt  # the list's split record
    own_dealt: split_record.Dealt | None
    changes: dict[str, int]  # the plan's changes, both
    mix: dict[str, int]
    lock: dict | None
    lock_path: Path

    def describe(self) -> list[str]:
        lines = self.dealt.describe()
        if self.own_dealt is not None:
            lines += self.own_dealt.describe()
        return lines


def prepare(sentences_csv: Path = SENTENCES_CSV, plan_path: Path = PLAN_CSV, *,
            spelling_path: Path = SPELLING_YAML, recordings: Path = RECORDINGS,
            params: split_record.Params | None = None, mix: dict[str, int] | None = None, redeal: bool = False,
            write: bool = True, local_dir: Path | None = None) -> Prepared:
    """The split record and the plan for the list and the owner's own sentences, brought up to
    date in that order (``splits.ensure``, then :func:`ensure`) and written back when they
    changed (unless ``write=False``). The record, its parameters and the test lock are beside
    the plan; ``params`` (a config's, ``splits.Params.of``) default to the record's own."""
    from . import local, testset
    from .spelling import load_spelling

    plan_path = Path(plan_path)
    listed = load_sentences(sentences_csv)
    spelling = load_spelling(spelling_path)
    if params is not None:
        split_record.check_held_out(params, spelling, spelling_path)
    own = local.load_sentences(local_dir)
    local.check_ids(own, listed)
    every = listed + own
    taken = split_record.taken(recordings, [s.id for s in every])
    lock_file = testset.lock_path(plan_path.parent)
    lock = testset.read_lock(lock_file)
    dealt = split_record.ensure(listed, spelling, split_record.record_path(plan_path), params, taken=taken,
                                locked=lock["sentences"] if lock is not None else None, redeal=redeal, write=write)
    recorded = takes_of(recordings, every)
    target = read_mix(mix_path(plan_path)) if mix is None else {cid: mix.get(cid, 0) for cid in IDS}
    plan, changes = ensure(listed, plan_path, mix=target, recorded=recorded, splits=dealt.assignment,
                           moved=dealt.moved, redeal=redeal, write=write)
    assignment = dict(dealt.assignment)
    own_dealt = None
    if own:
        folder = local.folder(local_dir)
        own_dealt = split_record.ensure(own, spelling, folder / split_record.RECORD, dealt.params, taken=taken,
                                        redeal=redeal, local=True, write=write)
        own_plan, own_changes = ensure(own, folder / "plan.csv", mix=target, recorded=recorded,
                                       splits=own_dealt.assignment, moved=own_dealt.moved, redeal=redeal,
                                       write=write)
        plan = {**plan, **own_plan}
        assignment.update(own_dealt.assignment)
        changes = {k: changes[k] + own_changes[k] for k in changes}
    return Prepared(sentences=every, listed=listed, own=own, splits=assignment, plan=plan, dealt=dealt,
                    own_dealt=own_dealt, changes=changes, mix=target, lock=lock, lock_path=lock_file)


def takes_of(root: Path, sentences: list[Sentence]) -> dict[str, set[str]]:
    """Per condition, the sentences with a take in it in ``root`` (``recordings/``), its text
    current or not, as the recorder counts them (run 4's browser takes are not)."""
    from .recorder.takes import TakeStore

    texts = {s.id: s.text for s in sentences}
    stores = {cid: TakeStore(root, cid, texts) for cid in IDS}
    return {cid: {sid for sid in texts if store.status(sid) != "missing"} for cid, store in stores.items()}


def progress(plan: dict[str, str], recorded: dict[str, set[str]]) -> dict[str, dict[str, int]]:
    """Per condition: planned sentences, how many have a take, and takes beyond the plan."""
    out = {}
    for cid in IDS:
        planned = {sid for sid, c in plan.items() if c == cid}
        takes = recorded.get(cid, set())
        out[cid] = {"total": len(planned), "done": len(planned & takes), "extra": len(takes - planned)}
    return out


def mix_table(sentences: list[Sentence], plan: dict[str, str], mix: dict[str, int] | None = None,
              splits: dict[str, str] | None = None) -> str:
    """Per split (the split record), the sentences of each condition with a share (or with
    planned sentences)."""
    shares = mix or DEFAULT_MIX
    splits = splits or {}
    columns = [cid for cid in IDS if shares.get(cid, 0) > 0 or cid in plan.values()]
    counts: dict[str, Counter] = {}
    for s in sentences:
        counts.setdefault(splits.get(s.id, "train"), Counter())[plan[s.id]] += 1
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
                   help="the takes: a sentence with a take keeps its split, and its condition under a new mix")
    p.add_argument("--spelling", type=Path, default=SPELLING_YAML, help="spelling.yaml: the terms the split covers")
    p.add_argument("--config", type=Path,
                   help="deal the split record with this experiment config's split parameters (data.seed, "
                        "data.validation_fraction, data.test_fraction, data.held_out_terms); default: the "
                        "parameters splits.csv was dealt with")
    p.add_argument("--redeal", action="store_true",
                   help="deal every sentence without a take again: its split and its condition (after the "
                        "sentence list changed)")
    a = p.parse_args(argv)
    try:
        mix = parse_mix(a.mix) if a.mix is not None else None
    except ValueError as e:
        p.error(str(e))
    params = None
    if a.config is not None:
        from .config import load_config

        params = split_record.Params.of(load_config(a.config).data)
    prepared = prepare(a.sentences, a.plan, spelling_path=a.spelling, recordings=a.recordings, params=params,
                       mix=mix, redeal=a.redeal)
    plan, changes = prepared.plan, prepared.changes
    print(f"plan {a.plan}: {len(plan)} sentences ({changes['added']} added, {changes['removed']} removed, "
          f"{changes['moved']} moved to another condition)")
    print(f"mix {mix_path(a.plan)}: {format_mix(prepared.mix)}")
    print(mix_table(prepared.sentences, plan, prepared.mix, prepared.splits))
    for line in prepared.describe():
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
