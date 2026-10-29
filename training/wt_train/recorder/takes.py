"""The takes on disk, in training/data/recordings/ (git-ignored; the owner's voice
never leaves this Mac).

Layout::

    <condition>/<id>.wav          16 kHz mono 16-bit PCM, as the app received it (before VAD);
                                  a Mac take from 0.3 s before the press (run 12, session.py)
    <condition>/<id>.txt          the text exactly as shown, plus a newline
    <condition>/<id>.json         its metadata (``Session._meta``: device, microphone, style,
                                  session, take number, time, check results, ...; a Mac
                                  take's margins: pre_roll_s, post_roll_s, trimmed_s)
    exam/<condition>/<id>.*       the exam paragraphs, the same three files
    .replaced/<condition>/<id>.<UTC time>.wav|txt|json    every earlier take of a sentence
    .replaced/exam/<condition>/...
    sessions.jsonl                one line when a session starts and one when it ends
    <id>.wav, <id>.txt            run 4's browser takes (Mac, normal voice), still read by
    .replaced/<id>.<time>.*       the dataset builder as condition mac-normal

Run 7, the pilot (``wt-train pilot record``), in training/data/pilot/ (git-ignored too,
and never read by the dataset builder): one folder per recording setup instead of per
condition, the same three files::

    <setup>/<id>.wav|txt|json     the twelve pilot sentences read in one setup
    .replaced/<setup>/...         every earlier take
    sessions.jsonl

A redo moves the previous trio into ``.replaced/``, so a slip never loses a take;
the dataset builder reads only the current one.

Run 9, Værkstedet (``wt-train studio``): a take's metadata may hold its ``review``,
``{"status": "approved" | "redo", "by": "check" | "owner", "problems": [...], "heard": ...,
"wer": ...}``, written in place (:meth:`TakeStore.update_meta`). A take whose review is
``redo`` is read again: the recorder's queue comes back to it, and the dataset builder
leaves it out. Saving a take and writing into its metadata share one lock (:data:`LOCK`), and
a write names the take it is for (:func:`take_identity`), so a verdict on a take that was
just replaced never lands on the new one. Files are written to unique temporary names in the
same folder, then renamed into place. A take counts as recorded while
its ``.txt`` matches the text; if the owner edits a sentence (a spelling
convention changed), the old take is "stale" and the recorder comes back to it.

Paths are built only from ids in the sentence list (or the exam), and those must
be plain (letters, digits, ``_`` and ``-``), and from setup names, which must be
lower-case letters, digits and ``-``, so nothing outside the folder is touched.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from ..conditions import IDS
from ..exam import EXAM_FOLDER
from .audio import write_wav

SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
# A pilot setup's folder name: lower-case letters, digits and "-", starting and ending with
# a letter or digit (so never ".replaced", "sessions.jsonl" or "..").
SAFE_SETUP = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?")
STATUSES = ("missing", "recorded", "stale")
REVIEWS = ("approved", "redo")
REPLACED = ".replaced"
SESSIONS_LOG = "sessions.jsonl"
# Why a take marked for a new take is left out, wherever takes are listed (dataset, pilot).
REDO_REASON = "marked for a new take"
# Held while a take is saved or its metadata written, in every thread and every store.
LOCK = threading.RLock()


class UnknownItem(KeyError):
    """An id that is not in the sentence list (or the exam)."""


def review_status(meta: dict | None) -> str | None:
    """``approved`` or ``redo`` when a take's metadata holds a review (run 9), else None."""
    review = meta.get("review") if isinstance(meta, dict) else None
    status = review.get("status") if isinstance(review, dict) else None
    return status if status in REVIEWS else None


def take_identity(meta: dict | None) -> tuple:
    """Which take a metadata file describes: its session, take number and time."""
    meta = meta or {}
    return (meta.get("session"), meta.get("take"), meta.get("recorded_at"))


def write_atomic(path: Path, text: str) -> None:
    """``text`` (UTF-8) at ``path`` through a unique temporary file beside it."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".part", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def condition_folder(root: Path, condition: str, exam: bool = False) -> Path:
    if condition not in IDS:
        raise ValueError(f"unknown condition {condition!r}")
    return Path(root) / EXAM_FOLDER / condition if exam else Path(root) / condition


class TakeStore:
    """The takes of one condition (or of its exam) for the texts in ``texts`` (id -> text).
    With ``setup`` (run 7's pilot), the takes of that recording setup, in ``<root>/<setup>/``."""

    def __init__(self, root: Path, condition: str, texts: dict[str, str], exam: bool = False,
                 setup: str | None = None):
        for item_id in texts:
            if not SAFE_ID.fullmatch(item_id):
                raise ValueError(f"id {item_id!r} must be letters, digits, '_' or '-' (at most 64)")
        self.root = Path(root)
        self.condition = condition
        self.exam = exam
        self.setup = setup
        self.texts = dict(texts)
        if setup is not None:
            if exam:
                raise ValueError("a pilot setup has no exam")
            if not SAFE_SETUP.fullmatch(setup):
                raise ValueError(f"setup {setup!r} must be lower-case letters, digits and '-' (at most 40)")
            if condition not in IDS:
                raise ValueError(f"unknown condition {condition!r}")
            self.folder, sub = self.root / setup, Path(setup)
        else:
            self.folder = condition_folder(root, condition, exam)
            sub = Path(EXAM_FOLDER) / condition if exam else Path(condition)
        self.replaced = self.root / REPLACED / sub

    def text(self, item_id: str) -> str:
        try:
            return self.texts[item_id]
        except KeyError:
            raise UnknownItem(item_id) from None

    def _path(self, item_id: str, suffix: str) -> Path:
        self.text(item_id)
        return self.folder / f"{item_id}{suffix}"

    def wav_path(self, item_id: str) -> Path:
        return self._path(item_id, ".wav")

    def txt_path(self, item_id: str) -> Path:
        return self._path(item_id, ".txt")

    def meta_path(self, item_id: str) -> Path:
        return self._path(item_id, ".json")

    def status(self, item_id: str) -> str:
        """``missing``, ``recorded``, or ``stale`` (recorded, but the text changed since)."""
        if not self.wav_path(item_id).is_file():
            return "missing"
        try:
            shown = self.txt_path(item_id).read_text(encoding="utf-8").rstrip("\n")
        except FileNotFoundError:
            return "stale"
        return "recorded" if shown == self.text(item_id) else "stale"

    def recorded(self) -> set[str]:
        return {i for i in self.texts if self.status(i) == "recorded"}

    def meta(self, item_id: str) -> dict | None:
        try:
            return json.loads(self.meta_path(item_id).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def update_meta(self, item_id: str, changes: dict, expect: tuple | None = None) -> dict | None:
        """Merge ``changes`` into the current take's metadata (top-level keys), written
        atomically; returns the new metadata. With ``expect`` (:func:`take_identity`), only
        when the current take is that one: None, and nothing written, when it is not (or
        there is none)."""
        with LOCK:
            meta = self.meta(item_id)
            if expect is not None and (meta is None or take_identity(meta) != tuple(expect)):
                return None
            if not isinstance(meta, dict):
                raise ValueError(f"{self.meta_path(item_id)}: no metadata to update")
            meta.update(changes)
            write_atomic(self.meta_path(item_id), json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
            return meta

    def earlier_takes(self, item_id: str) -> int:
        """How many takes of this item were replaced so far."""
        self.text(item_id)
        if not self.replaced.is_dir():
            return 0
        return sum(1 for p in self.replaced.glob(f"{item_id}.*.wav"))

    def save(self, item_id: str, samples: np.ndarray, meta: dict) -> bool:
        """Write the take, its text and its metadata; an earlier take goes to ``.replaced/``.
        Returns whether one was replaced."""
        text = self.text(item_id)
        wav, txt, js = self.wav_path(item_id), self.txt_path(item_id), self.meta_path(item_id)
        with LOCK:
            self.folder.mkdir(parents=True, exist_ok=True)
            replaced = any(p.exists() for p in (wav, txt, js))
            if replaced:
                self._keep(item_id, wav, txt, js)
            # Text and metadata first: a take only counts once its WAV is in place.
            write_atomic(txt, text + "\n")
            write_atomic(js, json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
            write_wav(wav, samples)
        return replaced

    def _keep(self, item_id: str, *paths: Path) -> None:
        self.replaced.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        stem, n = f"{item_id}.{stamp}", 1
        while any((self.replaced / f"{stem}{s}").exists() for s in (".wav", ".txt", ".json")):
            n += 1
            stem = f"{item_id}.{stamp}-{n}"
        for path in paths:
            if path.exists():
                shutil.move(str(path), self.replaced / f"{stem}{path.suffix}")


def log_session(root: Path, event: dict) -> None:
    """One line in ``sessions.jsonl``."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    with (root / SESSIONS_LOG).open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
