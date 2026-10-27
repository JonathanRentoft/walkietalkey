"""What Værkstedet records from, read again whenever a file changes: the sentence list,
the plan and its mix (``plan.ensure``, as ``wt-train record`` runs it at start), the exam
paragraphs and the pilot sentences; and per folder of takes, which sentences have a
current take, its length and its review (cached by the folder's modification time, so
the progress screens stay cheap to poll).
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from ..conditions import IDS
from ..recorder.takes import TakeStore, review_status
from .places import StudioPaths


def _mtime(path: Path) -> int:
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return 0


class Sources:
    def __init__(self, places: StudioPaths):
        self.places = places
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[tuple, object]] = {}

    def _cached(self, name: str, key: tuple, load):
        with self._lock:
            hit = self._cache.get(name)
            if hit is not None and hit[0] == key:
                return hit[1]
        value = load()
        with self._lock:
            self._cache[name] = (key, value)
        return value

    def sentences(self) -> list:
        from ..sentences import load_sentences

        path = self.places.sentences
        return self._cached("sentences", (_mtime(path),), lambda: load_sentences(path))

    def plan(self) -> dict[str, str]:
        """The plan for the sentence list, written back when the list changed (``plan.ensure``)."""
        from ..plan import ensure

        key = (_mtime(self.places.sentences), _mtime(self.places.plan))
        return self._cached("plan", key, lambda: ensure(self.sentences(), self.places.plan)[0])

    def mix(self) -> dict[str, int]:
        from ..plan import mix_path, read_mix

        path = mix_path(self.places.plan)
        return self._cached("mix", (_mtime(path),), lambda: read_mix(path))

    def exam(self) -> list:
        from ..exam import load_exam

        path = self.places.exam
        return self._cached("exam", (_mtime(path),), lambda: load_exam(path) if Path(path).is_file() else [])

    def pilot_sentences(self) -> list:
        from ..pilot import load_pilot

        path = self.places.pilot_sentences
        return self._cached("pilot", (_mtime(path),), lambda: load_pilot(path) if Path(path).is_file() else [])

    def texts(self) -> dict[str, str]:
        return {s.id: s.text for s in self.sentences()}

    def takes(self, store: TakeStore) -> dict[str, dict]:
        """The current takes in ``store``'s folder: id -> ``{"seconds", "review", "microphone",
        "recorded_at"}`` (a take whose text changed since is not current)."""
        folder = store.folder
        key = (_mtime(folder), len(store.texts), hash(tuple(sorted(store.texts.items()))))
        return self._cached(f"takes:{folder}", key, lambda: _scan(store))

    def condition_takes(self, cid: str, exam: bool = False) -> dict[str, dict]:
        texts = {p.id: p.text for p in self.exam()} if exam else self.texts()
        return self.takes(TakeStore(self.places.recordings, cid, texts, exam=exam))

    def summary(self, cid: str) -> dict:
        """A condition's numbers for the progress screens: planned sentences, done (a current take
        not sent back), redo, minutes of current takes, and its exam."""
        plan = self.plan()
        planned = {sid for sid, c in plan.items() if c == cid}
        takes = self.condition_takes(cid)
        exam = self.condition_takes(cid, exam=True)
        redo = {sid for sid, t in takes.items() if t["review"] == "redo"}
        return {"planned": len(planned), "done": len((set(takes) - redo) & planned), "redo": len(redo & planned),
                "minutes": round(sum(t["seconds"] for t in takes.values()) / 60, 1),
                "exam_done": sum(1 for t in exam.values() if t["review"] != "redo"), "exam_total": len(self.exam())}

    def summaries(self) -> dict[str, dict]:
        return {cid: self.summary(cid) for cid in IDS}


def _scan(store: TakeStore) -> dict[str, dict]:
    folder = store.folder
    try:
        names = {e.name for e in os.scandir(folder) if e.is_file()}
    except OSError:
        return {}
    out = {}
    for item_id in store.texts:
        if f"{item_id}.wav" not in names or store.status(item_id) != "recorded":
            continue
        try:
            meta = json.loads((folder / f"{item_id}.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = {}
        meta = meta if isinstance(meta, dict) else {}
        seconds = meta.get("seconds")
        out[item_id] = {"seconds": float(seconds) if isinstance(seconds, (int, float)) else 0.0,
                        "review": review_status(meta), "microphone": meta.get("microphone"),
                        "recorded_at": meta.get("recorded_at")}
    return out
