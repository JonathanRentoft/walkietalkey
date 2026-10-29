"""Which split each sentence is in (run 12): a deterministic, stratified deal, recorded.

Until run 11 a sentence's split was a pure hash of the seed and its text, so a term could end up
with no test sentence at all (20 of the 71 terms of spelling.yaml had none). Now the split is
dealt so that test measures every term, and the deal is written down, so a sentence keeps its
split once it is recorded.

The deal (:func:`deal`)
    A sentence is its text after spelling.yaml's conventions and the accuracy job's normaliser
    (``dataset.sentence_key``): two ids with the same text are one sentence and share a split.
    Every sentence gets a rank, ``sha256(f"{seed}\\0{text}")``, which orders every choice below,
    so the same sentences, spelling and parameters always give the same deal, in any order.

    1. Held-out terms (``data.held_out_terms``): every sentence holding one goes to test, while
       test is open (no lock, and not the owner's own sentences).
    2. Coverage: each term of spelling.yaml that is not held out gets at least
       :data:`MIN_TEST` (2) test sentences and :data:`MIN_VALIDATION` (1) validation sentence,
       test first. Terms are taken rarest first (fewest sentences, then by name); for each, the
       sentence chosen is the one that helps the most terms still short of that split (then the
       lowest rank). A sentence is never taken when it would leave one of its terms without a
       sentence that training can have (:data:`MIN_TRAIN`), so a term with too few sentences
       gets what it can, and a warning names it.
    3. Fractions, per kind (terms, plain): test and validation each get ``fraction x sentences``,
       or more when coverage needs more, and every kind its share of that, so the split does
       not skew the kinds: when coverage puts extra terms sentences in test, plain sentences
       join in proportion. The sizes are split over the kinds by largest remainder (ties: terms
       first), and each kind is filled in rank order. The held-out sentences of step 1 come on
       top and are not counted here. So the fractions are targets: coverage may push test and
       validation a little above them; the record reports the actual sizes.
    4. Everything else is train.

    The recording conditions are dealt after this, per split and kind (``plan.assign``), so the
    mix holds in each split.

The record (:func:`ensure`)
    ``splits.csv`` (``id,split``, sorted by id) beside the plan (``training/data/splits.csv``,
    committed), and the parameters it was dealt with in ``split.yaml`` beside it (``seed``,
    ``validation_fraction``, ``test_fraction``, ``held_out_terms``). ``wt-train plan``, the
    recorder at the start of a session, Værkstedet and ``wt-train build`` all go through it:

    * Once a sentence has a take (any take, in any condition, current or replaced; run 4's
      browser takes too; :func:`taken`), its split never changes.
    * With the same parameters every assignment in the record is kept, taken or not; new
      sentences are dealt into the gaps (their terms' coverage first, then the fractions), and
      a sentence removed from the list drops out.
    * With other parameters (a config that asks for another seed, other fractions or other
      held-out terms), every sentence without a take is dealt again for them and the record is
      rewritten; the result says what moved. ``--redeal`` (``wt-train plan``) does that on
      purpose with the same parameters.
    * After the test set is locked (``testset.py``), test holds exactly the locked sentences:
      sentences added later go to train or validation only, and a test sentence that was not
      locked (it had no take when the lock was written) leaves test at the next deal. A
      sentence with a newly held-out term can then no longer go to test either: it is dealt to
      train or validation like the owner's own sentences, and the build leaves its takes out.
    * The owner's own sentences (``local.py``) have their own record beside them and never go
      to test.

    Regenerate the committed record and plan after the sentence list changes with
    ``uv run --project training wt-train plan --redeal`` (it keeps every sentence that has a
    take where it is).
"""

from __future__ import annotations

import csv
import hashlib
import math
import os
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Collection, Iterable

import yaml

from .conditions import IDS
from .sentences import KINDS, Sentence
from .spelling import Spelling

SPLITS = ("train", "validation", "test")
COLUMNS = ["id", "split"]
RECORD = "splits.csv"
PARAMS = "split.yaml"
# What coverage asks for each term that is not held out, and what it leaves for training.
MIN_TEST = 2
MIN_VALIDATION = 1
MIN_TRAIN = 1


@dataclass(frozen=True)
class Params:
    """What a deal follows: the experiment config's ``data.seed``, fractions and held-out terms."""

    seed: int = 1
    validation_fraction: float = 0.1
    test_fraction: float = 0.1
    held_out_terms: tuple[str, ...] = ()

    def __post_init__(self):
        object.__setattr__(self, "held_out_terms", tuple(sorted(set(self.held_out_terms))))
        object.__setattr__(self, "validation_fraction", float(self.validation_fraction))
        object.__setattr__(self, "test_fraction", float(self.test_fraction))

    @classmethod
    def of(cls, data) -> "Params":
        """The parameters of a config's ``data`` section (``config.DataConfig``)."""
        return cls(seed=data.seed, validation_fraction=data.validation_fraction, test_fraction=data.test_fraction,
                   held_out_terms=tuple(data.held_out_terms))

    def as_dict(self) -> dict:
        return {"seed": self.seed, "validation_fraction": self.validation_fraction,
                "test_fraction": self.test_fraction, "held_out_terms": list(self.held_out_terms)}

    def describe(self) -> str:
        held = f", held out {', '.join(self.held_out_terms)}" if self.held_out_terms else ""
        return (f"seed {self.seed}, validation {_pct(self.validation_fraction)}, "
                f"test {_pct(self.test_fraction)}{held}")


def _pct(x: float) -> str:
    return f"{x * 100:g} %"


def check_held_out(params: Params, spelling: Spelling, where: str | Path = "spelling.yaml") -> None:
    """Every held-out term must be a term of spelling.yaml (a ConfigError names the first that is not)."""
    from .config import ConfigError

    names = {t.name for t in spelling.terms}
    for term in params.held_out_terms:
        if term not in names:
            raise ConfigError(f"data.held_out_terms: {term!r} is not a term in {where}; "
                              f"the terms are the names under 'terms' there")


# --- the deal -----------------------------------------------------------------------------


def rank(seed: int, key: str) -> bytes:
    """The order of a sentence in every choice of the deal."""
    return hashlib.sha256(f"{seed}\0{key}".encode("utf-8")).digest()


def key_of(text: str, spelling: Spelling | None = None) -> str:
    from .dataset import sentence_key

    return sentence_key(spelling.apply(text) if spelling is not None else text)


def terms_of(sentences: Iterable[Sentence], spelling: Spelling) -> dict[str, frozenset[str]]:
    """The terms of spelling.yaml each sentence holds."""
    return {s.id: frozenset(h.term for h in spelling.find_terms(spelling.apply(s.text))) for s in sentences}


@dataclass(eq=False)
class _Unit:
    """One sentence: every id with the same text."""

    key: str
    ids: list[str]
    kind: str
    terms: frozenset[str]
    rank: bytes
    split: str | None = None


def _units(sentences: list[Sentence], spelling: Spelling, seed: int) -> list[_Unit]:
    by_key: dict[str, _Unit] = {}
    terms = terms_of(sentences, spelling)
    for s in sorted(sentences, key=lambda s: s.id):
        key = key_of(s.text, spelling)
        unit = by_key.get(key)
        if unit is None:
            by_key[key] = _Unit(key, [s.id], s.kind, terms[s.id], rank(seed, key))
        else:
            unit.ids.append(s.id)
            unit.terms |= terms[s.id]
    return sorted(by_key.values(), key=lambda u: u.rank)


def _apportion(total: int, counts: dict[str, int], present: dict[str, int]) -> dict[str, int]:
    """``total`` over the kinds in proportion to ``present`` (largest remainder, ties in KINDS
    order), never below what a kind holds already (``counts``)."""
    n = sum(present.values())
    if n == 0:
        return dict(counts)
    exact = {k: total * present[k] / n for k in KINDS}
    target = {k: max(counts.get(k, 0), math.floor(exact[k])) for k in KINDS}
    left = total - sum(target.values())
    order = sorted(KINDS, key=lambda k: (-(exact[k] - math.floor(exact[k])), KINDS.index(k)))
    for k in order:
        if left <= 0:
            break
        if target[k] < present[k] and target[k] == math.floor(exact[k]):
            target[k] += 1
            left -= 1
    return target


def deal(sentences: list[Sentence], spelling: Spelling, params: Params, *, given: dict[str, str] | None = None,
         test_open: bool = True, coverage: bool = True) -> tuple[dict[str, str], list[str]]:
    """A split for every sentence, and the warnings (terms below coverage). ``given`` sentences
    keep their split (a take, a lock, or the record with the same parameters); the rest are
    dealt as the module says. ``test_open=False`` deals nothing to test (after the lock, and
    for the owner's own sentences); ``coverage=False`` skips the term coverage (own sentences)."""
    given = given or {}
    held = set(params.held_out_terms)
    units = _units(sentences, spelling, params.seed)
    for u in units:
        splits = [given[i] for i in u.ids if i in given]
        if splits:
            u.split = splits[0]

    names = [t.name for t in spelling.terms]
    seen = [t for t in names if t not in held]
    by_term: dict[str, list[_Unit]] = {t: [] for t in names}
    for u in units:
        for t in u.terms:
            by_term.setdefault(t, []).append(u)
    count: dict[str, Counter] = {t: Counter(u.split for u in by_term[t] if u.split) for t in by_term}
    room = {t: sum(1 for u in by_term[t] if u.split in (None, "train")) for t in by_term}

    def assign(u: _Unit, split: str) -> None:
        u.split = split
        for t in u.terms:
            count[t][split] += 1
            if split != "train":
                room[t] -= 1

    def allowed(u: _Unit) -> bool:
        return all(room[t] - 1 >= MIN_TRAIN for t in u.terms if t not in held)

    # 1. Held-out terms: test only.
    if test_open and held:
        for u in units:
            if u.split is None and u.terms & held:
                assign(u, "test")

    # 2. Coverage: rarest terms first; per term test, then validation.
    measure_test = test_open and params.test_fraction > 0
    wants = ([("test", MIN_TEST)] if measure_test else []) + [("validation", MIN_VALIDATION)]
    if coverage:
        for t in sorted(seen, key=lambda t: (len(by_term[t]), t.casefold(), t)):
            for split, need in wants:
                while count[t][split] < need:
                    free = [u for u in by_term[t] if u.split is None and allowed(u)]
                    if not free:
                        break

                    def helps(u: _Unit) -> int:
                        return sum(1 for x in u.terms if x not in held and count[x][split] < need)

                    assign(min(free, key=lambda u: (-helps(u), u.rank)), split)

    # 3. Fractions per kind, over the sentences that are not held out.
    pool = [u for u in units if not (test_open and u.terms & held)]
    present = Counter(u.kind for u in pool)
    fractions = ([("test", params.test_fraction)] if test_open else []) + [("validation", params.validation_fraction)]
    for split, fraction in fractions:
        if fraction <= 0 or not pool:
            continue
        have = Counter(u.kind for u in pool if u.split == split)
        size = fraction * len(pool)
        for k in KINDS:
            if present[k] and have[k]:
                size = max(size, have[k] * len(pool) / present[k])
        total = max(1, math.floor(size + 0.5))
        target = _apportion(total, have, present)
        for k in KINDS:
            for u in pool:
                if have[k] >= target[k]:
                    break
                if u.kind == k and u.split is None and allowed(u):
                    assign(u, split)
                    have[k] += 1

    # 4. The rest.
    for u in units:
        if u.split is None:
            assign(u, "train")

    out: dict[str, str] = {}
    for u in units:
        for i in u.ids:
            out[i] = given.get(i, u.split)
    return out, _warnings(seen, held, by_term, count, test_open, coverage, measure_test)


def _warnings(seen, held, by_term, count, test_open: bool, coverage: bool, measure_test: bool) -> list[str]:
    if not coverage:
        return []
    out = []
    lock = "; the test set is locked" if not test_open else ""
    min_test = MIN_TEST if measure_test or not test_open else 0
    for t in seen:
        c = count[t]
        if c["test"] < min_test or c["validation"] < MIN_VALIDATION:
            n = len(by_term[t])
            out.append(f"{t}: {n} sentence{'s' if n != 1 else ''}, {c['test']} in test and {c['validation']} "
                       f"in validation (wants {MIN_TEST} and {MIN_VALIDATION}){lock}")
    for t in sorted(held):
        c = count.get(t, Counter())
        if not by_term.get(t):
            out.append(f"{t} is held out, but no sentence holds it")
        elif c["train"] or c["validation"]:
            out.append(f"{t} is held out, but {c['train'] + c['validation']} of its sentences are in train or "
                       "validation (the build leaves their takes out)")
    return out


def coverage(assignment: dict[str, str], sentences: list[Sentence], spelling: Spelling) -> dict[str, dict[str, int]]:
    """Per term of spelling.yaml, its sentences in each split."""
    terms = terms_of(sentences, spelling)
    out = {t.name: {s: 0 for s in SPLITS} for t in spelling.terms}
    for s in sentences:
        split = assignment.get(s.id)
        for t in terms[s.id]:
            if split in SPLITS:
                out.setdefault(t, {x: 0 for x in SPLITS})[split] += 1
    return out


# --- the record ------------------------------------------------------------------------------


def record_path(plan_path: Path) -> Path:
    """The record of a plan: ``splits.csv`` beside it."""
    return Path(plan_path).with_name(RECORD)


def params_path(record: Path) -> Path:
    return Path(record).with_name(PARAMS)


def read_record(path: Path) -> tuple[dict[str, str], Params | None]:
    """The record and the parameters it was dealt with (None when split.yaml is missing)."""
    path = Path(path)
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != COLUMNS:
            raise ValueError(f"{path}: header must be {','.join(COLUMNS)}, got {reader.fieldnames}")
        out: dict[str, str] = {}
        for row in reader:
            sid, split = (row["id"] or "").strip(), (row["split"] or "").strip()
            if split not in SPLITS:
                raise ValueError(f"{path}: {sid} has split {split!r}, expected one of {', '.join(SPLITS)}")
            if sid in out:
                raise ValueError(f"{path}: {sid} is listed twice")
            out[sid] = split
    return out, read_params(params_path(path))


def read_params(path: Path) -> Params | None:
    path = Path(path)
    if not path.is_file():
        return None
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    keys = {"seed", "validation_fraction", "test_fraction", "held_out_terms"}
    if not isinstance(raw, dict) or set(raw) != keys:
        raise ValueError(f"{path}: expected exactly {', '.join(sorted(keys))}")
    held = raw["held_out_terms"] or []
    if not isinstance(held, list) or not all(isinstance(t, str) for t in held):
        raise ValueError(f"{path}: held_out_terms must be a list of term names")
    return Params(seed=int(raw["seed"]), validation_fraction=float(raw["validation_fraction"]),
                  test_fraction=float(raw["test_fraction"]), held_out_terms=tuple(held))


PARAMS_HEADER = """\
# The parameters splits.csv beside this file was dealt with (training/wt_train/splits.py):
# the seed, the validation and test fractions and the held-out terms of an experiment config.
# Written by `wt-train plan`, `wt-train record`, Værkstedet and `wt-train build`. A config with
# other parameters deals every sentence without a take again and rewrites both files; a
# sentence with a take keeps its split. Do not edit by hand.
"""


def _atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_record(path: Path, assignment: dict[str, str], params: Params) -> None:
    path = Path(path)
    rows = "".join(f"{sid},{assignment[sid]}\n" for sid in sorted(assignment))
    _atomic(path, ",".join(COLUMNS) + "\n" + rows)
    body = yaml.safe_dump(params.as_dict(), sort_keys=False, allow_unicode=True, default_flow_style=False)
    _atomic(params_path(path), PARAMS_HEADER + body)


@dataclass
class Dealt:
    """The record after :func:`ensure`, and what changed."""

    path: Path
    assignment: dict[str, str]
    params: Params
    previous: Params | None
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    # Sentences that changed split: id -> (from, to).
    moved: dict[str, tuple[str, str]] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    locked: bool = False
    local: bool = False
    written: bool = False

    def sizes(self) -> dict[str, int]:
        c = Counter(self.assignment.values())
        return {s: c[s] for s in SPLITS}

    def describe(self) -> list[str]:
        """What the console says about the record."""
        what = "own sentences' split record" if self.local else "split record"
        sizes = self.sizes()
        lines = [f"{what} {self.path}: {self.params.describe()}" + ("; the test set is locked" if self.locked else ""),
                 "  " + ", ".join(f"{s} {sizes[s]}" for s in SPLITS) + " sentences"]
        if self.previous is not None and self.previous != self.params:
            lines.append(f"  dealt again for these parameters (before: {self.previous.describe()})")
        if self.added or self.removed:
            lines.append(f"  {len(self.added)} sentence(s) added, {len(self.removed)} removed")
        if self.moved:
            ways = Counter(f"{a} -> {b}" for a, b in self.moved.values())
            ids = sorted(self.moved)
            lines.append(f"  moved {len(self.moved)}: " + ", ".join(f"{n} {w}" for w, n in sorted(ways.items()))
                         + f" ({', '.join(ids[:8])}{' ...' if len(ids) > 8 else ''})")
        if not self.local:
            if self.warnings:
                lines.append(f"  {len(self.warnings)} warning(s):")
                lines += [f"    {w}" for w in self.warnings]
            else:
                lines.append(f"  every term has at least {MIN_TEST} test and {MIN_VALIDATION} validation sentences")
        return lines


def ensure(sentences: list[Sentence], spelling: Spelling, path: Path, params: Params | None = None, *,
           taken: Collection[str] = (), locked: Collection[str] | None = None, redeal: bool = False,
           local: bool = False, write: bool = True) -> Dealt:
    """The record for ``sentences`` at ``path`` (``splits.csv``), written back when it changed.

    ``params`` (None: the record's own, or the defaults) are the parameters to deal with;
    ``taken`` the sentences with a take (:func:`taken`); ``locked`` the sentence ids of the
    test lock (None: no lock); ``redeal`` deals every sentence without a take again; ``local``
    marks the owner's own sentences (never test, no coverage); ``write=False`` only computes."""
    path = Path(path)
    before, previous = read_record(path) if path.is_file() else ({}, None)
    params = params or previous or Params()
    if not local:
        check_held_out(params, spelling)
    listed = [s.id for s in sentences]
    same = previous == params and not redeal
    locked_ids = None if locked is None or local else set(locked)
    taken = set(taken)
    given: dict[str, str] = {}
    for sid in listed:
        if locked_ids is not None and sid in locked_ids:
            given[sid] = "test"
            continue
        old = before.get(sid)
        if old is None or (old == "test" and (local or locked_ids is not None)):
            continue
        if sid in taken or same:
            given[sid] = old
    assignment, warnings = deal(sentences, spelling, params, given=given,
                                test_open=locked_ids is None and not local, coverage=not local)
    out = Dealt(path=path, assignment=assignment, params=params, previous=previous,
                added=sorted(set(listed) - set(before)), removed=sorted(set(before) - set(listed)),
                moved={sid: (before[sid], to) for sid, to in sorted(assignment.items())
                       if sid in before and before[sid] != to},
                warnings=warnings, locked=locked_ids is not None, local=local)
    if write and (assignment != before or params != previous or not path.is_file()):
        write_record(path, assignment, params)
        out.written = True
    return out


def taken(recordings: Path, ids: Iterable[str]) -> set[str]:
    """The sentences among ``ids`` with a take in ``recordings``: current or replaced, in any
    condition, and run 4's browser takes in the top folder (the exam and the pilot are not
    sentences of the list)."""
    from .recorder.takes import REPLACED

    root = Path(recordings)
    found: set[str] = set()

    def scan(folder: Path, replaced: bool) -> None:
        try:
            entries = list(os.scandir(folder))
        except OSError:
            return
        for e in entries:
            if e.name.endswith(".wav") and e.is_file():
                stem = e.name[:-4]
                found.add(stem.split(".", 1)[0] if replaced else stem)

    scan(root, False)
    scan(root / REPLACED, True)
    for cid in IDS:
        scan(root / cid, False)
        scan(root / REPLACED / cid, True)
    return found & set(ids)
