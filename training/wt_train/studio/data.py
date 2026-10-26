"""Værkstedet's data screen: what a config would train on, before training.

For a config in ``training/configs/``, the owner's takes as the dataset builder reads
them (``dataset.load_recordings``: a take marked for a new take is left out and listed),
split by sentence with the config's fractions and seed (``dataset.split_by_sentence``),
per recording condition; and the leakage check (``dataset.leakage_problems``) within the
splits and against each held-out set on its own: FLEURS da_dk test, the exam, the pilot.
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
        key = (_mtime(path), _mtime(sentences), _mtime(spelling), _tree(recordings), _tree(self.places.pilot),
               _mtime(self.places.exam), _mtime(self.places.pilot_sentences),
               _mtime(paths.fleurs_dir() / ".complete"), tuple(names))
        with self._lock:
            hit = self._cache.get(name)
            if hit is not None and hit[0] == key:
                return hit[1]
        out = self._compute(name, names, cfg, recordings, sentences, spelling)
        with self._lock:
            self._cache[name] = (key, out)
        return out

    def _compute(self, name: str, names: list[str], cfg, recordings: Path, sentences: Path, spelling: Path) -> dict:
        from .. import dataset
        from ..sentences import load_sentences
        from ..spelling import load_spelling

        listed = load_sentences(sentences) if Path(sentences).is_file() else []
        error = None
        try:
            spell = load_spelling(spelling)
            items, skipped = dataset.load_recordings(recordings, sentences, spell, self.places.pilot)
        except FileNotFoundError:
            items, skipped = [], []
        except ValueError as e:
            items, skipped, error = [], [], str(e)
        d = cfg.data
        splits = dataset.split_by_sentence(items, d.validation_fraction, d.test_fraction, d.seed)
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
                          "recorded": len({i.sentence for i in items})},
            "conditions": conditions,
            "skipped": skipped,
            "rehearsal": {"share": cfg.rehearsal.share, "validation_share": cfg.rehearsal.validation_share},
            "leakage": self._leakage(splits, items, recordings, error),
        }

    def _leakage(self, splits: dict, items: list, recordings: Path, error: str | None) -> dict:
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
