"""Værkstedet's data screen: what a config would train on, before training.

For a config in ``training/configs/``, the owner's takes as the dataset builder reads
them (``dataset.load_recordings``: a take marked for a new take is left out and listed),
split by sentence as the split record would deal them for the config's seed, fractions
and held-out terms (run 12: ``plan.prepare`` without writing, ``dataset.split_by_record``;
a take of a train or validation sentence with a held-out term is left out and listed),
per recording condition; and the leakage check (``dataset.leakage_problems``, and the
owner's own sentences by id, ``dataset.own_problems``) within the splits and against each
held-out set on its own: FLEURS da_dk test, the exam, the pilot. ``split`` says what the
record holds for that config: its parameters, the sentences per split, whether the test
set is locked, and the coverage warnings (``splits.py``).
A held-out set that cannot be loaded (FLEURS not downloaded) leaves its check unknown
(``ok: null``) and the others still run. Rehearsal clips are not drawn here; the build
adds them when it trains.

The studio's own folders win over a config's ``data`` paths when the studio was started
with others (tests, the end-to-end run). The answer is cached until a config, the
sentence list, the spelling or any folder of takes changes, so the screen is cheap to
poll; the first look hashes every take's audio and can take a few seconds.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from .. import paths
from ..conditions import BY_ID, IDS
from . import labels
from .places import StudioPaths
from .recording import StudioError


def config_names(folder: Path) -> list[str]:
    return sorted(p.stem for p in Path(folder).glob("*.yaml"))


def _tree(root: Path) -> tuple:
    """The modification times of ``root`` and every folder below it."""
    out = []
    for top, dirs, _ in os.walk(root):
        try:
            out.append((top, os.stat(top).st_mtime_ns))
        except OSError:
            continue
        dirs.sort()
    return tuple(out)


def _mtime(path: Path) -> int:
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return 0


class DataView:
    def __init__(self, places: StudioPaths):
        self.places = places
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[tuple, dict]] = {}

    def inputs(self, cfg) -> tuple[Path, Path, Path]:
        """(recordings, sentences, spelling): the studio's when they are not the workbench's own,
        else the config's."""
        p = self.places
        recordings = cfg.data.path("recordings") if p.default_recordings else Path(p.recordings)
        sentences = cfg.data.path("sentences") if Path(p.sentences) == paths.SENTENCES_CSV else Path(p.sentences)
        spelling = cfg.data.path("spelling") if Path(p.spelling) == paths.SPELLING_YAML else Path(p.spelling)
        return recordings, sentences, spelling

    def view(self, name: str | None = None) -> dict:
        from ..config import ConfigError, load_config

        names = config_names(self.places.configs)
        if not names:
            raise StudioError(404, "no-configs", f"no configs in {self.places.configs}")
        name = name or names[0]
        if name not in names:
            raise StudioError(404, "unknown", f"no config {name!r} in {self.places.configs}")
        path = Path(self.places.configs) / f"{name}.yaml"
        try:
            cfg = load_config(path)
        except ConfigError as e:
            raise StudioError(400, "config", str(e)) from None
        recordings, sentences, spelling = self.inputs(cfg)
        from .. import splits as split_record
        from ..testset import lock_path

        plan_path = self.plan_path(sentences)
        record = split_record.record_path(plan_path)
        own = paths.local_dir()
        key = (_mtime(path), _mtime(sentences), _mtime(spelling), _tree(recordings), _tree(self.places.pilot),
               _mtime(self.places.exam), _mtime(self.places.pilot_sentences),
               _mtime(paths.fleurs_dir() / ".complete"), tuple(names), _mtime(record),
               _mtime(split_record.params_path(record)), _mtime(lock_path(plan_path.parent)),
               _mtime(own / "sentences.csv"), _mtime(own / "own-words.yaml"), _mtime(own / "splits.csv"))
        with self._lock:
            hit = self._cache.get(name)
            if hit is not None and hit[0] == key:
                return hit[1]
        out = self._compute(name, names, cfg, recordings, sentences, spelling)
        with self._lock:
            self._cache[name] = (key, out)
        return out

    def plan_path(self, sentences: Path) -> Path:
        """The plan (and the split record beside it) of a sentence list: the studio's, when the list
        is the studio's, else the one beside the config's list."""
        return Path(self.places.plan) if Path(sentences) == Path(self.places.sentences) \
            else Path(sentences).with_name("plan.csv")

    def _compute(self, name: str, names: list[str], cfg, recordings: Path, sentences: Path, spelling: Path) -> dict:
        from .. import dataset, local, splits as split_record
        from ..config import ConfigError
        from ..plan import prepare
        from ..spelling import load_spelling

        error = None
        prepared = None
        spell = None
        items, skipped = [], []
        try:
            spell = load_spelling(spelling)
            prepared = prepare(sentences, self.plan_path(sentences), spelling_path=spelling, recordings=recordings,
                               params=split_record.Params.of(cfg.data), write=False)
            with_own = local.spelling_with_own_words(spell)
            items, skipped = dataset.load_recordings(recordings, prepared.sentences, with_own, self.places.pilot)
        except ConfigError as e:
            raise StudioError(400, "config", str(e)) from None
        except FileNotFoundError:
            items, skipped = [], []
        except ValueError as e:
            items, skipped, error = [], [], str(e)
        d = cfg.data
        listed = prepared.sentences if prepared is not None else []
        if prepared is not None:
            splits, left_out = dataset.split_by_record(items, prepared.splits, held_out_terms=d.held_out_terms,
                                                       spelling=spell)
            skipped = skipped + left_out
        else:
            splits = {s: [] for s in dataset.SPLITS}
        conditions = []
        for cid in IDS:
            own = [i for i in items if i.condition == cid]
            split = {s: {"takes": len(part), "minutes": round(sum(i.seconds for i in part) / 60, 1)}
                     for s in dataset.SPLITS for part in [[i for i in splits[s] if i.condition == cid]]}
            conditions.append({"id": cid, "label": BY_ID[cid].label, "takes": len(own),
                               "minutes": round(sum(i.seconds for i in own) / 60, 1), "split": split})
        return {
            "config": name,
            "configs": names,
            "fractions": {"validation": d.validation_fraction, "test": d.test_fraction},
            "sentences": {"total": len(listed), "plain": sum(s.kind == "plain" for s in listed),
                          "terms": sum(s.kind == "terms" for s in listed),
                          "recorded": len({i.sentence for i in items}),
                          "own": len(prepared.own) if prepared is not None else 0},
            "conditions": conditions,
            "skipped": skipped,
            "rehearsal": {"share": cfg.rehearsal.share, "validation_share": cfg.rehearsal.validation_share},
            "split": self._split(prepared),
            "leakage": self._leakage(splits, items, recordings, error, prepared, spell),
        }

    @staticmethod
    def _split(prepared) -> dict | None:
        """What the split record holds for this config (run 12)."""
        if prepared is None:
            return None
        dealt = prepared.dealt
        return {"params": dealt.params.as_dict(), "sentences": dealt.sizes(), "locked": prepared.lock is not None,
                "moved": len(dealt.moved), "warnings": dealt.warnings}

    def _leakage(self, splits: dict, items: list, recordings: Path, error: str | None, prepared=None,
                 spelling=None) -> dict:
        from .. import dataset

        checks = {cid: {"id": cid, "label": labels.LEAKAGE[cid]} for cid in dataset.LEAKAGE_CHECKS}
        if error is not None or not items:
            for c in checks.values():
                c.update(ok=None, overlap=None, detail=error or "no takes yet")
            return {"ran": False, "ok": None, "checks": list(checks.values()), "message": error}
        held, missing = None, {}
        try:
            held = dataset.fleurs_test_held_out(paths.fleurs_dir())
        except (FileNotFoundError, ValueError, OSError):
            missing["fleurs-test"] = f"FLEURS da_dk test is not downloaded ({paths.fleurs_dir()}); " \
                                     "wt-train fetch downloads it"
        exam = pilot = None
        try:
            exam = dataset.exam_held_out(recordings, self.places.exam)
        except (ValueError, OSError) as e:
            missing["exam"] = f"the exam could not be read: {e}"
        try:
            pilot = dataset.pilot_held_out(self.places.pilot, self.places.pilot_sentences)
        except (ValueError, OSError) as e:
            missing["pilot"] = f"the pilot could not be read: {e}"
        found = dataset.leakage_problems(splits, held, exam, pilot)
        if prepared is not None:
            found = dataset.own_problems(prepared.own, prepared.listed, held, exam, pilot, spelling) + found
        for cid, c in checks.items():
            if cid in missing:
                c.update(ok=None, overlap=None, detail=missing[cid])
            else:
                n = sum(1 for check, _ in found if check == cid)
                c.update(ok=n == 0, overlap=n)
        oks = [c["ok"] for c in checks.values()]
        ok = False if False in oks else (None if None in oks else True)
        message = "; ".join(text for _, text in found[:3]) + (" ..." if len(found) > 3 else "") if found else None
        return {"ran": True, "ok": ok, "checks": list(checks.values()), "message": message}
