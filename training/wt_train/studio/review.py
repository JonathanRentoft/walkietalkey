"""Værkstedet's checks of each take, and the worker that lets base Edda listen.

A take the recorder kept (``recorder/checks.py``: a silent take, or one with gaps, is
refused and never saved) is checked once more, as ``wt-train check`` checks a session:

* its audio (``audiostats``, ``check.audio_problems``): too quiet, clipped, cut off,
  short, too loud, noisy; and its level over 48 slices of the take (``envelope``, dBFS)
  for the page's small level meter;
* what Edda heard (``check.judge_match``): base Edda (``paths.SHIPPED_EDDA_ID``)
  through the app's headless batch (``check.pick_app``, ``evaluate.AppTranscriber``),
  the text re-spelled like the training data, run 7's rule for a take that does not
  match its text. A background thread takes every waiting take in one
  ``--transcribe-list`` call (the model loads once); takes that come in meanwhile wait
  for the next. When Edda cannot listen (no app with the batch interface, the model is
  missing, the batch failed), ``edda_error`` says why, the audio alone decides, and the
  app is looked for again after :data:`RETRY_APP_S`.

The verdict: a take with a problem in :data:`REDO` goes back (``redo``, by ``check``);
``loud`` and ``noisy`` are warnings only; any other take is ``approved`` (by ``check``)
once Edda has heard it, or could not. It is written into the take's metadata as
``review`` (``TakeStore.update_meta``), with the numbers the page shows, so a restart
shows the same rows without measuring again. A take replaced while it was checked is
left alone (its metadata names another take); a verdict of the owner's ("Tag om",
"Godkend alligevel") is never overwritten by the check, which only adds its numbers.
"""

from __future__ import annotations

import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np
import soundfile as sf

from .. import audiostats, paths
from ..align import align
from ..recorder import checks
from ..recorder.takes import TakeStore, review_status

# Problems that send a take back; "silent" only reaches a take saved before these checks.
REDO = frozenset({"quiet", "clipped", "cut", "short", "mismatch", "silent", "gaps"})
WARNINGS = frozenset({"loud", "noisy"})
ENVELOPE_POINTS = 48
RETRY_APP_S = 60.0
# Every write of a review goes through this lock, so the check and the owner never race.
WRITE_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def envelope(x: np.ndarray, points: int = ENVELOPE_POINTS) -> list[float]:
    """The RMS level (dBFS, one decimal) of each of ``points`` equal slices of float samples."""
    x = np.asarray(x, dtype=np.float64)
    if len(x) == 0:
        return [-120.0] * points
    edges = np.linspace(0, len(x), points + 1).astype(int)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        part = x[a:max(b, a + 1)]
        rms = float(np.sqrt(np.mean(part**2))) if len(part) else 0.0
        out.append(round(20 * float(np.log10(max(rms, 1e-6))), 1))
    return out


def identity(meta: dict | None) -> tuple:
    """Which take a metadata file describes: its session, take number and time."""
    meta = meta or {}
    return (meta.get("session"), meta.get("take"), meta.get("recorded_at"))


def diff_ops(ref_norm: str, hyp_norm: str) -> list[dict]:
    return [{"op": o.kind, "ref": o.ref, "hyp": o.hyp} for o in align(ref_norm.split(), hyp_norm.split())]


@dataclass(eq=False)
class Entry:
    """One current take and what is known about it. Fields change under :data:`Entry.lock`."""

    store: TakeStore
    item_id: str
    text: str
    style: str
    device: str
    meta: dict
    audio: dict | None = None
    envelope: list | None = None
    problems: list = field(default_factory=list)
    heard: str | None = None
    wer: float | None = None
    diff: list | None = None
    edda_error: str | None = None
    review: dict | None = None
    pending: bool = False

    lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self.store.wav_path(self.item_id)

    @property
    def identity(self) -> tuple:
        return identity(self.meta)

    @property
    def status(self) -> str:
        """``received`` until it has a review, then ``approved`` or ``redo``."""
        return review_status({"review": self.review}) or "received"

    @property
    def seconds(self) -> float:
        value = self.meta.get("seconds")
        return float(value) if isinstance(value, (int, float)) else 0.0

    @classmethod
    def from_meta(cls, store: TakeStore, item_id: str, text: str, style: str, device: str, meta: dict) -> "Entry":
        entry = cls(store, item_id, text, style, device, dict(meta))
        review = meta.get("review") if isinstance(meta.get("review"), dict) else None
        if review_status({"review": review}):
            entry.review = dict(review)
            entry.problems = [p for p in review.get("problems") or [] if isinstance(p, dict) and p.get("kind")]
            entry.heard = review.get("heard")
            entry.wer = review.get("wer")
            entry.edda_error = review.get("edda_error")
            entry.audio = review.get("audio") if isinstance(review.get("audio"), dict) else None
            entry.envelope = review.get("envelope") if isinstance(review.get("envelope"), list) else None
        return entry

    def row(self, url: str) -> dict:
        """The take as a row of the recording state shows it (``training/studio/API.md``)."""
        with self.lock:
            audio = self.audio or {}
            review = {k: self.review[k] for k in ("status", "by") if k in self.review} if self.review else None
            return {
                "n": self.meta.get("take"),
                "url": url,
                "seconds": round(self.seconds, 2),
                "recorded_at": self.meta.get("recorded_at"),
                "microphone": self.meta.get("microphone"),
                "level_dbfs": audio.get("level_dbfs"),
                "peak_dbfs": audio.get("peak_dbfs"),
                "noise_dbfs": audio.get("noise_dbfs"),
                "snr_db": audio.get("snr_db"),
                "envelope": self.envelope,
                "problems": [dict(p) for p in self.problems],
                "transcribing": self.pending,
                "heard": self.heard,
                "wer": self.wer,
                "diff": self.diff,
                "edda_error": self.edda_error,
                "review": review,
            }


def _samples(path: Path) -> tuple[np.ndarray, int]:
    x, rate = sf.read(str(path), dtype="int16", always_2d=True)
    return (x[:, 0] if x.shape[1] == 1 else x.mean(axis=1).astype(np.int16)), rate


def measure(entry: Entry) -> tuple[dict, list[float], dict[str, str]]:
    """The audio numbers, the envelope and the audio problems of a take (``wt-train check``'s)."""
    from ..check import audio_problems

    samples, rate = _samples(entry.path)
    x = samples.astype(np.float32) / 32768.0
    stats = audiostats.measure_samples(x, rate)
    result = checks.check_take(samples, style=entry.style, device=entry.device, text=entry.text, rate=rate)
    numbers = {k: float(getattr(stats, k)) for k in ("level_dbfs", "peak_dbfs", "noise_dbfs", "snr_db")}
    return numbers, envelope(x), audio_problems(stats, result, entry.style)


class NoEdda(Exception):
    """Edda cannot listen; the message says why (English, for the log)."""


def app_transcriber(app_bin: Path | None = None):
    """The default: base Edda through the app's headless batch, the binary as ``wt-train check``
    picks it (``--app-bin`` / ``WT_APP_BIN``, else the installed app first)."""

    def make():
        from ..check import pick_app
        from ..evaluate import AppTranscriber

        found = pick_app(app_bin)
        found.check_model(paths.SHIPPED_EDDA_ID)
        return AppTranscriber(found, paths.SHIPPED_EDDA_ID)

    return make


class Reviewer:
    """The checks and the background worker. ``transcriber`` makes the object that transcribes
    (``.transcribe(wavs) -> [(text, error)]``), or raises when there is none; ``on_result`` is
    called (from the worker, holding no lock) after each change to an entry."""

    def __init__(self, *, spelling: Path | None = None, transcriber=None, app_bin: Path | None = None,
                 on_result=None, clock=time.monotonic):
        self.spelling_path = spelling
        self.make_transcriber = transcriber or app_transcriber(app_bin)
        self.on_result = on_result or (lambda entry: None)
        self.clock = clock
        self._cond = threading.Condition()
        self._queue: list[Entry] = []
        self._busy = False
        self._stopped = False
        self._thread: threading.Thread | None = None
        self._transcriber = None
        self._failed: tuple[float, str] | None = None
        self._spelling = None
        self._spelling_loaded = False

    # --- the queue ----------------------------------------------------------------------

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, daemon=True, name="studio-review")
            self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        with self._cond:
            self._stopped = True
            self._cond.notify_all()
        if self._thread is not None:
            self._thread.join(timeout)

    def submit(self, entry: Entry) -> None:
        """Check ``entry`` in the background (its row says ``transcribing`` meanwhile)."""
        with Entry.lock:
            entry.pending = True
        with self._cond:
            if entry not in self._queue:
                self._queue.append(entry)
            self._cond.notify_all()

    def idle(self, timeout: float = 10.0) -> bool:
        """Wait until nothing is queued or being checked (tests)."""
        with self._cond:
            return self._cond.wait_for(lambda: not self._queue and not self._busy, timeout=timeout)

    def _run(self) -> None:
        while True:
            with self._cond:
                self._cond.wait_for(lambda: self._queue or self._stopped)
                if self._stopped:
                    return
                batch, self._queue = self._queue, []
                self._busy = True
            try:
                self.check(batch)
            except Exception as e:  # noqa: BLE001 - the worker never dies
                for entry in batch:
                    self._unchecked(entry, f"the check failed: {type(e).__name__}: {e}")
            finally:
                with self._cond:
                    self._busy = False
                    self._cond.notify_all()

    # --- the checks ---------------------------------------------------------------------

    def spelling(self):
        if not self._spelling_loaded:
            from ..spelling import load_spelling

            path = self.spelling_path
            self._spelling = load_spelling(path) if path and Path(path).is_file() else None
            self._spelling_loaded = True
        return self._spelling

    def restore(self, entry: Entry) -> None:
        """A reviewed take loaded from disk: its diff from what Edda heard, its audio numbers if
        the review has none (measured here, once)."""
        from ..check import judge_match

        if entry.heard is not None and entry.diff is None:
            judged = judge_match(entry.text, entry.heard, self.spelling())
            with Entry.lock:
                entry.diff = diff_ops(judged["ref_norm"], judged["hyp_norm"])
        if entry.audio is None and entry.path.is_file():
            numbers, env, _ = measure(entry)
            with Entry.lock:
                entry.audio, entry.envelope = numbers, env

    def check(self, batch: list[Entry]) -> None:
        """Audio first (the rows get their numbers at once), then one batch through Edda."""
        audio: dict[int, dict[str, str]] = {}
        for entry in batch:
            if not entry.path.is_file():
                with Entry.lock:
                    entry.pending = False
                continue
            try:
                numbers, env, found = measure(entry)
            except (OSError, ValueError, RuntimeError) as e:
                self._unchecked(entry, f"the audio could not be read: {e}")
                continue
            audio[id(entry)] = found
            with Entry.lock:
                entry.audio, entry.envelope = numbers, env
                entry.problems = [{"kind": k, "detail": v} for k, v in found.items()]
            self.on_result(entry)
        listen = [e for e in batch if id(e) in audio and "silent" not in audio[id(e)]]
        heard: dict[int, tuple[str, str | None]] = {}
        reason = None
        if listen:
            try:
                results = self._transcribe([e.path for e in listen])
                heard = {id(e): r for e, r in zip(listen, results)}
            except NoEdda as e:
                reason = str(e)
        for entry in batch:
            if id(entry) not in audio:
                continue
            if id(entry) in heard:
                text, error = heard[id(entry)]
                self._decide(entry, None if error else text, error, audio[id(entry)])
            else:
                self._decide(entry, None, reason, audio[id(entry)])

    def _transcribe(self, wavs: list[Path]) -> list[tuple[str, str | None]]:
        if self._transcriber is None:
            if self._failed is not None and self.clock() - self._failed[0] < RETRY_APP_S:
                raise NoEdda(self._failed[1])
            try:
                self._transcriber = self.make_transcriber()
            except (FileNotFoundError, ValueError, RuntimeError, OSError, subprocess.SubprocessError) as e:
                self._failed = (self.clock(), " ".join(str(e).split())[:300] or type(e).__name__)
                raise NoEdda(self._failed[1]) from None
            self._failed = None
        try:
            return list(self._transcriber.transcribe(wavs))
        except (FileNotFoundError, ValueError, RuntimeError, OSError, subprocess.SubprocessError) as e:
            self._transcriber = None
            raise NoEdda(" ".join(str(e).split())[:300] or type(e).__name__) from None

    def _decide(self, entry: Entry, transcript: str | None, error: str | None, found: dict[str, str]) -> None:
        from ..check import judge_match

        problems = [{"kind": k, "detail": v} for k, v in found.items()]
        wer = diff = None
        if transcript is not None:
            judged = judge_match(entry.text, transcript, self.spelling())
            wer = round(judged["wer"], 4)
            diff = diff_ops(judged["ref_norm"], judged["hyp_norm"])
            if judged["mismatch"]:
                problems.append({"kind": "mismatch", "detail": judged["mismatch"]})
        status = "redo" if any(p["kind"] in REDO for p in problems) else "approved"
        with Entry.lock:
            numbers, env = entry.audio, entry.envelope
        review = {"status": status, "by": "check", "problems": problems, "heard": transcript, "wer": wer,
                  "edda_error": error, "audio": numbers, "envelope": env, "checked_at": _now()}
        written = self._write(entry, review)
        with Entry.lock:
            entry.problems, entry.heard, entry.wer, entry.diff, entry.edda_error = problems, transcript, wer, diff, error
            entry.review = written
            entry.pending = False
        self.on_result(entry)

    def _unchecked(self, entry: Entry, message: str) -> None:
        """The check itself failed (an unreadable file): no review, so it is checked again
        after a restart; the row shows the error."""
        with Entry.lock:
            entry.problems = [{"kind": "error", "detail": message[:200]}]
            entry.pending = False
        self.on_result(entry)

    def _write(self, entry: Entry, review: dict) -> dict:
        """The review as written: the check's, or the owner's verdict with the check's numbers.
        Nothing is written when the take on disk is another one by now."""
        with WRITE_LOCK:
            meta = entry.store.meta(entry.item_id)
            if meta is None or identity(meta) != entry.identity:
                return review
            earlier = meta.get("review") if isinstance(meta.get("review"), dict) else None
            if earlier and earlier.get("by") == "owner" and review_status(meta):
                review = {**review, "status": earlier["status"], "by": "owner", "decided_at": earlier.get("decided_at")}
            entry.store.update_meta(entry.item_id, {"review": review})
            return review

    def set_owner(self, entry: Entry, status: str) -> dict:
        """"Tag om" (``redo``) or "Godkend alligevel" (``approved``), by the owner."""
        with WRITE_LOCK:
            meta = entry.store.meta(entry.item_id) or {}
            earlier = meta.get("review") if isinstance(meta.get("review"), dict) else {}
            with Entry.lock:
                known = {"problems": entry.problems, "heard": entry.heard, "wer": entry.wer,
                         "edda_error": entry.edda_error, "audio": entry.audio, "envelope": entry.envelope}
            review = {**known, **earlier, "status": status, "by": "owner", "decided_at": _now()}
            if identity(meta) == entry.identity:
                entry.store.update_meta(entry.item_id, {"review": review})
        with Entry.lock:
            entry.review = review
        return review
