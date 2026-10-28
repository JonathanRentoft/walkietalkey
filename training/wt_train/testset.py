"""The owner's test set (run 12): frozen at the first baseline, and every use of it logged.

A test set that keeps changing measures nothing, and one that is looked at after every change
is slowly trained on by the person looking. So:

The lock, ``training/data/test-lock.json`` (beside the sentence list; committed by the owner)
    Written by the first ``wt-train eval --dataset test`` on the owner's test split (from
    ``--run`` or ``--build``; never FLEURS test, the exam, a manifest or a folder), from the
    whole test split of that build, whatever ``--limit`` scores::

        {"created": "2026-10-28T12:00:00+01:00",       # when, with the time zone
         "build": "first-frozen-encoder",              # the build (its config's name)
         "params": {"seed": 1, "validation_fraction": 0.1, "test_fraction": 0.1,
                    "held_out_terms": []},              # the split parameters of that build
         "sentences": ["s0004", ...],                   # the test sentence ids, sorted
         "clips": [{"id": "s0004.phone-whisper", "audio_sha256": "..."}, ...],   # by id
         "sha256": "..."}

    ``sha256`` is the SHA-256, in hex, of the UTF-8 bytes of
    ``json.dumps(lock_without_sha256, sort_keys=True, ensure_ascii=False, separators=(",", ":"))``
    (:func:`lock_sha256`); ``audio_sha256`` is the build's content hash of the take
    (``audio.content_sha256``: the decoded samples, so a copy with another header is the same
    take). :func:`read_lock` refuses a lock whose sha256 does not match.

    After the lock, the split record (``splits.py``) keeps test to exactly these sentences:
    sentences added later go to train or validation, and a test sentence that had no take when
    the lock was written leaves test at the next deal. Anything that would change the frozen
    set stops ``wt-train build`` and ``wt-train eval --dataset test`` (:class:`TestSetChanged`,
    :func:`changes`): a locked sentence removed from the list or its text changed, a locked
    take missing, marked for a new take or with other audio, a new take of a locked sentence,
    or a locked sentence the record would move out of test. The message names what changed and
    says what to do: put the take (or the text) back, or delete test-lock.json on purpose,
    which makes earlier test results incomparable with later ones; the next evaluation on test
    then locks the test set again.

The use log, ``<work>/test-uses.jsonl`` (``paths.test_uses_log()``)
    One line per ``wt-train eval`` on the owner's test split, once it has scored::

        {"at": "2026-10-28T12:01:13+01:00", "runs": ["first-frozen-encoder-3"], "backend": "lora",
         "build": "first-frozen-encoder", "eval_run": "20261028-120102-lora-first-frozen-encoder-3",
         "source": "cli"}

    ``runs`` names what was measured (the training run, or the model when there is none),
    ``eval_run`` is the folder under ``<work>/runs/eval/``, and ``source`` comes from
    ``WT_TEST_USE_SOURCE`` (``cli`` by default; Værkstedet sets ``studio``).

:func:`read_lock` and :func:`read_uses` are what Værkstedet reads; these two formats are fixed.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from pathlib import Path

from . import paths

LOCK_NAME = "test-lock.json"
LOCK_KEYS = ("created", "build", "params", "sentences", "clips", "sha256")
USE_KEYS = ("at", "runs", "backend", "build", "eval_run", "source")
SOURCE_ENV = "WT_TEST_USE_SOURCE"


class TestSetChanged(RuntimeError):
    """The frozen test set would change; the message says what and what to do."""

    __test__ = False  # not a pytest test class


def lock_path(data_dir: Path | None = None) -> Path:
    """The lock beside a sentence list: ``training/data/test-lock.json`` by default."""
    return (Path(data_dir) if data_dir is not None else paths.DATA) / LOCK_NAME


def uses_path() -> Path:
    return paths.test_uses_log()


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# --- the lock -----------------------------------------------------------------------------


def lock_sha256(lock: dict) -> str:
    body = {k: v for k, v in lock.items() if k != "sha256"}
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def make_lock(*, build: str, params: dict, clips, created: str | None = None) -> dict:
    """The lock of a test split: its recordings (``dataset.Item``), sentence ids and audio hashes."""
    takes = sorted((i for i in clips if i.source == "recording"), key=lambda i: i.id)
    lock = {"created": created or _now(), "build": str(build), "params": dict(params),
            "sentences": sorted({i.sentence or i.id.split(".")[0] for i in takes}),
            "clips": [{"id": i.id, "audio_sha256": i.audio_sha256} for i in takes]}
    lock["sha256"] = lock_sha256(lock)
    return lock


def write_lock(path: Path, lock: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_lock(path: Path | None = None) -> dict | None:
    """The lock (``training/data/test-lock.json`` by default), or None when there is none.
    A file that is not a lock, or whose sha256 does not match its content, is a ValueError."""
    path = Path(path) if path is not None else lock_path()
    if not path.is_file():
        return None
    try:
        lock = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{path}: not valid JSON ({e})") from None
    if not isinstance(lock, dict) or set(lock) != set(LOCK_KEYS):
        raise ValueError(f"{path}: a test lock has exactly the keys {', '.join(LOCK_KEYS)}")
    if lock_sha256(lock) != lock["sha256"]:
        raise ValueError(f"{path}: its sha256 does not match its content (edited by hand?); restore it from git, "
                         "or delete it on purpose to lock the test set again")
    return lock


# --- what changed -------------------------------------------------------------------------


def on_disk(items) -> tuple[list, list[dict]]:
    """The manifest's takes as they are on disk now: their audio hashed again; a take that is
    gone or marked for a new take is listed (``{"id", "reason"}``) instead."""
    from dataclasses import replace

    from . import audio
    from .recorder.takes import REDO_REASON, review_status

    out, missing = [], []
    for item in items:
        wav = Path(item.audio)
        if not wav.is_file():
            missing.append({"id": item.id, "reason": "the take is missing"})
            continue
        try:
            meta = json.loads(wav.with_suffix(".json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = {}
        if review_status(meta) == "redo":
            missing.append({"id": item.id, "reason": REDO_REASON})
            continue
        out.append(replace(item, audio_sha256=audio.content_sha256(wav)))
    return out, missing


def changes(lock: dict, *, clips, sentences: dict[str, str] | None = None, record: dict[str, str] | None = None,
            skipped=(), spelling=None) -> list[str]:
    """What differs from the frozen test set, one line each, by id: ``clips`` are the test
    split's takes (``dataset.Item``), ``sentences`` the list now (id -> text), ``record`` the
    split record, ``skipped`` the takes left out with their reason."""
    from .recorder.takes import REDO_REASON
    from .splits import key_of

    locked = list(lock.get("sentences") or [])
    locked_clips = {c["id"]: c["audio_sha256"] for c in lock.get("clips") or []}
    current = {i.id: i for i in clips if i.source == "recording"}
    reasons = {s["id"]: s["reason"] for s in skipped}
    problems: list[str] = []
    removed = set()
    if sentences is not None:
        for sid in locked:
            if sid not in sentences:
                removed.add(sid)
                problems.append(f"{sid}: removed from the sentence list (sentences.csv)")
        for i in sorted(current.values(), key=lambda i: i.id):
            sid = i.sentence or i.id.split(".")[0]
            if sid in sentences and sid not in removed and key_of(sentences[sid], spelling) != key_of(i.text):
                problems.append(f"{sid}: its text changed in sentences.csv since {i.id} was recorded")
    for cid in sorted(locked_clips):
        if cid.split(".")[0] in removed:
            continue
        item = current.get(cid)
        if item is None:
            reason = reasons.get(cid)
            if reason == REDO_REASON:
                problems.append(f"{cid}: marked for a new take")
            elif reason == "the take is missing" or reason is None:
                problems.append(f"{cid}: the take is missing")
            else:
                problems.append(f"{cid}: the take is missing ({reason})")
        elif item.audio_sha256 != locked_clips[cid]:
            problems.append(f"{cid}: other audio than when the test set was locked (recorded again?)")
    for cid in sorted(set(current) - set(locked_clips)):
        problems.append(f"{cid}: a new take in the test set")
    if record is not None:
        for sid in locked:
            if sid not in removed and record.get(sid, "test") != "test":
                problems.append(f"{sid}: the split would move it to {record[sid]}")
    return problems


def stop_message(lock_file: Path, lock: dict, problems: list[str]) -> str:
    shown = problems[:20] + ([f"... and {len(problems) - 20} more"] if len(problems) > 20 else [])
    return (f"The frozen test set changed ({lock_file}, locked {lock.get('created')} from build "
            f"{lock.get('build')}):\n" + "".join(f"  - {p}\n" for p in shown)
            + "Put back what changed (a replaced take is kept in recordings/.replaced/; a sentence's text in "
              f"sentences.csv), or delete {Path(lock_file).name} on purpose: test results from before then "
              "cannot be compared with later ones, and the next evaluation on test locks the test set again.")


# --- the use log --------------------------------------------------------------------------


def log_use(*, runs, backend: str, build: str, eval_run: str, path: Path | None = None) -> dict:
    """One line in the use log (``<work>/test-uses.jsonl``)."""
    entry = {"at": _now(), "runs": [str(r) for r in runs], "backend": str(backend), "build": str(build),
             "eval_run": str(eval_run), "source": os.environ.get(SOURCE_ENV) or "cli"}
    path = Path(path) if path is not None else uses_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def read_uses(path: Path | None = None) -> list[dict]:
    """Every use, oldest first; a line that is not a JSON object is passed over."""
    path = Path(path) if path is not None else uses_path()
    if not path.is_file():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict):
            out.append(entry)
    return out
