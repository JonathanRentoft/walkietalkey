"""Værkstedet's mix (run 12): the shares of the four conditions, what a new mix would deal,
and how long each condition takes to record.

* The mix and the plan are the recorder's (``plan.py``: ``mix.yaml`` beside the plan).
  Dealing again is exactly ``wt-train plan --mix``: ``plan.prepare(..., mix=...)``, the split
  record first, then the plan, for the list and his own sentences, so a sentence with a take
  keeps its condition and every other one is dealt again to fit the new mix within each split.
* A preview runs that same ``prepare`` with ``write=False``, so it shows exactly what dealing
  would do and writes nothing of the owner's.
* Dealing is refused while a recording is picked (its sentences would move under it).
* The time a condition takes: the sentences left to record (planned, without a take that
  was kept) times the owner's pace in that condition, the median gap between two takes in
  a row of one session (``recorded_at`` in the takes' metadata, the pilot's and the real
  recordings'), leaving out breaks over :data:`MAX_GAP_S`. With fewer than
  :data:`MIN_GAPS` gaps in a condition, the pilot's measured medians stand in
  (:data:`PILOT_PACE_S`).
"""

from __future__ import annotations

import json
import os
import statistics
import threading
from collections import Counter, defaultdict
from collections.abc import Iterable
from datetime import datetime
from itertools import pairwise
from pathlib import Path

from ..conditions import BY_ID, CONDITIONS, IDS
from ..recorder.takes import SAFE_SETUP
from .places import StudioPaths
from .recording import StudioError

# The pilot's measured medians, seconds per sentence (run 12's brief).
PILOT_PACE_S = {"phone-whisper": 8.0, "phone-normal": 11.0, "mac-normal": 8.0, "mac-whisper": 5.0}
# A gap longer than this between two takes is a break, not the pace.
MAX_GAP_S = 60.0
# The fewest gaps a condition needs before its own pace replaces the pilot's.
MIN_GAPS = 5


def _when(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        when = datetime.fromisoformat(value)
    except ValueError:
        return None
    return when if when.tzinfo else when.astimezone()


def gaps(takes: Iterable[dict]) -> dict[str, list[float]]:
    """Per condition, the seconds between two takes in a row of one session. ``takes`` are
    ``{"condition", "session", "recorded_at"}`` (a take's metadata); a gap over
    :data:`MAX_GAP_S` (a break) and a take without a time are left out."""
    sessions: dict[tuple, list[datetime]] = defaultdict(list)
    for t in takes:
        when = _when(t.get("recorded_at"))
        cid, session = t.get("condition"), t.get("session")
        if when is not None and cid in BY_ID and session:
            sessions[(cid, str(session))].append(when)
    out: dict[str, list[float]] = {cid: [] for cid in IDS}
    for (cid, _), times in sessions.items():
        times.sort()
        for a, b in pairwise(times):
            gap = (b - a).total_seconds()
            if 0 < gap <= MAX_GAP_S:
                out[cid].append(gap)
    return out


def pace(takes: Iterable[dict]) -> dict[str, dict]:
    """Per condition: ``{"seconds", "source", "gaps"}``, the median gap (``source`` ``takes``)
    or the pilot's median (``pilot``) with fewer than :data:`MIN_GAPS` gaps."""
    out = {}
    for cid, found in gaps(takes).items():
        if len(found) >= MIN_GAPS:
            out[cid] = {"seconds": round(statistics.median(found), 1), "source": "takes", "gaps": len(found)}
        else:
            out[cid] = {"seconds": PILOT_PACE_S[cid], "source": "pilot", "gaps": len(found)}
    return out


def _metas(folder: Path, condition: str | None) -> list[dict]:
    """The metadata of the takes in one folder (``<id>.json`` beside ``<id>.wav``)."""
    out = []
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return out
    names = {e.name for e in entries}
    for e in entries:
        if not e.name.endswith(".json") or e.name.startswith(".") or f"{e.name[:-5]}.wav" not in names:
            continue
        try:
            meta = json.loads(Path(e.path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(meta, dict):
            continue
        cid = condition or meta.get("condition")
        out.append({"condition": cid, "session": meta.get("session"), "recorded_at": meta.get("recorded_at")})
    return out


def take_times(recordings: Path, pilot: Path) -> list[dict]:
    """Every take's condition, session and time: the real recordings (not the exam) and the
    pilot's setups."""
    out = []
    for cid in IDS:
        out += _metas(Path(recordings) / cid, cid)
    try:
        setups = [p for p in Path(pilot).iterdir() if p.is_dir() and SAFE_SETUP.fullmatch(p.name)]
    except OSError:
        setups = []
    for folder in setups:
        from ..pilot import parse_setup

        fallback = parse_setup(folder.name).condition.id
        out += [{**m, "condition": m["condition"] if m["condition"] in BY_ID else fallback}
                for m in _metas(folder, None)]
    return out


def _tree(root: Path) -> tuple:
    out = []
    for top, dirs, _ in os.walk(root):
        try:
            out.append((top, os.stat(top).st_mtime_ns))
        except OSError:
            continue
        dirs.sort()
    return tuple(out)


def parse_body_mix(value) -> dict[str, int]:
    """A mix from the page: ``{condition: whole percent}``, every condition known, summing to
    100 (a condition left out gets 0)."""
    if not isinstance(value, dict):
        raise StudioError(400, "mix", "mix must be an object of condition to percent")
    mix = {}
    for cid, share in value.items():
        if cid not in BY_ID:
            raise StudioError(400, "mix", f"unknown condition {cid!r}; one of {', '.join(IDS)}")
        if isinstance(share, bool) or not isinstance(share, int) or not 0 <= share <= 100:
            raise StudioError(400, "mix", f"{cid}: a share is a whole percent from 0 to 100")
        mix[cid] = share
    full = {cid: mix.get(cid, 0) for cid in IDS}
    if sum(full.values()) != 100:
        raise StudioError(400, "mix", f"the shares add up to {sum(full.values())} %, not 100 %")
    return full


class MixView:
    def __init__(self, places: StudioPaths, sources, recorder):
        self.places = places
        self.sources = sources
        self.recorder = recorder
        self._lock = threading.Lock()
        self._pace: tuple[tuple, dict] | None = None
        self._recorded: tuple[tuple, dict] | None = None

    def pace(self) -> dict[str, dict]:
        key = (_tree(self.places.recordings), _tree(self.places.pilot))
        hit = self._pace
        if hit is not None and hit[0] == key:
            return hit[1]
        value = pace(take_times(self.places.recordings, self.places.pilot))
        self._pace = (key, value)
        return value

    def _takes_of(self) -> dict[str, set[str]]:
        """``plan.takes_of`` (the sentences with a take, per condition), as dealing reads it."""
        from ..plan import takes_of

        key = (_tree(self.places.recordings), os.stat(self.places.sentences).st_mtime_ns)
        hit = self._recorded
        if hit is not None and hit[0] == key:
            return hit[1]
        value = takes_of(self.places.recordings, self.sources.sentences())
        self._recorded = (key, value)
        return value

    def _done(self) -> dict[str, set[str]]:
        """Per condition, the sentences with a current take that was not sent back."""
        return {cid: {sid for sid, t in self.sources.condition_takes(cid).items() if t["review"] != "redo"}
                for cid in IDS}

    def _rows(self, mix: dict[str, int], plan: dict[str, str]) -> dict:
        done, paces = self._done(), self.pace()
        rows = []
        for c in CONDITIONS:
            planned = {sid for sid, cid in plan.items() if cid == c.id}
            left = len(planned - done[c.id])
            p = paces[c.id]
            rows.append({"id": c.id, "label": c.label, "share": mix.get(c.id, 0), "planned": len(planned),
                         "done": len(planned & done[c.id]), "left": left, "pace": p,
                         "minutes": round(left * p["seconds"] / 60, 1)})
        return {"mix": mix, "sentences": len(plan), "conditions": rows,
                "minutes": round(sum(r["minutes"] for r in rows), 1)}

    def _picked(self) -> bool:
        return self.recorder.summary()["label"] is not None

    def view(self) -> dict:
        return {**self._rows(self.sources.mix(), self.sources.plan()), "recording": self._picked()}

    @staticmethod
    def moved(before: dict[str, str], after: dict[str, str]) -> dict:
        pairs = Counter((before[sid], cid) for sid, cid in after.items() if sid in before and before[sid] != cid)
        order = {cid: i for i, cid in enumerate(IDS)}
        return {"total": sum(pairs.values()),
                "pairs": [{"from": a, "to": b, "n": n}
                          for (a, b), n in sorted(pairs.items(), key=lambda kv: (-kv[1], order[kv[0][0]],
                                                                                 order[kv[0][1]]))]}

    def _deal(self, mix: dict[str, int], *, write: bool) -> dict[str, str]:
        """``wt-train plan --mix`` (``plan.prepare``): the split record first, then the plan, for
        the list and his own sentences; ``write=False`` only computes (the preview)."""
        from ..plan import prepare

        return prepare(self.places.sentences, Path(self.places.plan), spelling_path=self.places.spelling,
                       recordings=self.places.recordings, mix=mix, write=write,
                       local_dir=self.places.local).plan

    def preview(self, body: dict) -> dict:
        mix = parse_body_mix(body.get("mix"))
        before = self.sources.plan()
        after = self._deal(mix, write=False)
        return {**self._rows(mix, after), "moved": self.moved(before, after),
                "changed": mix != self.sources.mix(), "recording": self._picked()}

    def deal(self, body: dict) -> dict:
        mix = parse_body_mix(body.get("mix"))
        with self._lock:
            if self._picked():
                raise StudioError(409, "recording", "a recording is picked; stop it before the sentences are "
                                                    "dealt again")
            before = self.sources.plan()
            after = self._deal(mix, write=True)
        return {**self._rows(self.sources.mix(), self.sources.plan()), "moved": self.moved(before, after),
                "changed": False, "recording": False}
