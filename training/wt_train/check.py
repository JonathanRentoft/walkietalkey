"""``wt-train check``: look over the latest recording session before going on.

After a session (the pilot or the real recordings) the owner runs ``wt-train
check`` and pastes what it prints to his assistant, who tells him whether to go
on or what to read again. So the summary is short (at most :data:`MAX_LINES`
lines), plain English, rounded, and ends with a one-line verdict.
``--json`` prints the full details instead: every take with its numbers.

Which session
    The newest start event across ``paths.RECORDINGS`` and ``paths.PILOT``
    (each folder's ``sessions.jsonl``), passing over newer sessions without a
    take; ``--session <id>`` (or a unique prefix) picks another. A session's
    takes are the current takes (``<condition or setup>/<id>.wav|txt|json``,
    ``exam/<condition>/...``; never ``.replaced/``) whose metadata names it. A
    session that is missing from the log (an older log, a crash) is still found
    from its takes' metadata, timed by its first take.

What is measured, per take (:mod:`.audiostats`, :mod:`.recorder.checks`)
    The speech level, the noise in the pauses, the estimated SNR, clipping and
    the length; the session line gives the medians and ranges.

Problems, each listed with its sentence ids; the limits follow the take's style
(a whisper is quiet by nature) and device, as the recorder's own checks do:

* **silent**: no speech found (the recorder's silent limits). A silent take
  is only silent: nothing else is said about it.
* **cut off**: speech within 50 ms of the start or the end, so a word may be
  cut. Judged only on takes at least :data:`CUT_MIN_SNR_DB` above the noise:
  closer than that, the noise itself counts as speech up to the edges.
* **clipped**: the recorder's rule (3 samples at full scale on the Mac, 0.2 %
  of the samples against the limiter's ceiling on the phone).
* **too quiet**: below the recorder's quiet limit (-35 dBFS normal, -50 dBFS
  whisper).
* **too loud**: above :data:`LOUD_DBFS`: a normal voice nearly at full scale,
  or a "whisper" at a normal voice's level. Not said of a clipped take.
* **noisy**: an estimated SNR below :data:`NOISY_SNR_DB`.
* **short**: the recorder's rule: less speech than 0.12 s per word.
* **not matching**: base Edda (``paths.SHIPPED_EDDA_ID``) through the app's
  headless batch path, one ``--transcribe-list`` call for the whole session,
  scored against the take's text re-spelled like the training data (as
  ``wt-train eval`` does): nothing heard, or a WER above :data:`MISMATCH_WER`
  with at least :data:`MISMATCH_MIN_ERRORS` word errors (one slip in a short
  sentence is Edda's error, not a wrong take). ``--no-transcribe`` skips it
  (quick, offline); without an app the audio is still checked and the verdict
  says the match was not.

The transcribing binary is ``--app-bin`` or ``WT_APP_BIN``, else the owner's
installed app (the one he records with) before the repository's builds, the
first with the batch interface (:func:`pick_app`). The batch runs as its own
headless process; it never touches the running app.

Verdict: "OK to continue"; "redo N takes: ..."; or, when one problem hits most
takes, "fix the setup, then redo this session's takes" with what to change.
Exit status: 0 when nothing needs a redo, 1 when something does, 2 on errors
(no session, an unknown ``--session``).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from statistics import median

import numpy as np
import soundfile as sf

from . import app as app_module
from . import audiostats, paths
from .conditions import BY_ID
from .recorder import checks
from .recorder.takes import SESSIONS_LOG

MAX_LINES = 25
# The widest line: lists of ids stop here with "and N more".
WIDTH = 150

# Louder than this for the style: a normal voice pressed against full scale, or a whisper at a
# normal voice's level (a normal voice reaches about -20 dBFS, a whisper about -40).
LOUD_DBFS = {"normal": -6.0, "whisper": -25.0}
# The estimated SNR (speech level over the median pause) below which a take is noisy.
NOISY_SNR_DB = {"normal": 15.0, "whisper": 10.0}
# speech_bounds counts every frame within 15 dB of the speech level as voiced: in a take less
# than this far above its noise, the noise reaches the edges and "cut off" cannot be told.
CUT_MIN_SNR_DB = 15.0
MISMATCH_WER = 0.5
MISMATCH_MIN_ERRORS = 2
# What Edda heard is shown for at most this many takes that do not match, room permitting.
HEARD_LINES = 5
# A problem in this share of the takes (and at least SYSTEMIC_MIN of them) is the setup's.
SYSTEMIC_SHARE = 0.5
SYSTEMIC_MIN = 4

KINDS = ("silent", "cut", "clipped", "quiet", "loud", "noisy", "short", "mismatch")
VOICE = {"normal": "normal voice", "whisper": "whisper"}


class CheckError(Exception):
    """Nothing to check: no session, or not the one asked for."""


# --- takes and sessions ---------------------------------------------------------------------


@dataclass
class Take:
    id: str
    source: str
    folder: str
    wav: Path
    text: str
    meta: dict

    @property
    def session(self) -> str:
        return str(self.meta.get("session") or "")

    @property
    def name(self) -> str:
        """The pilot setup or the condition."""
        return str(self.meta.get("setup") or self.meta.get("condition") or self.folder.split("/")[-1])

    @property
    def style(self) -> str:
        style = self.meta.get("style")
        if style not in checks.LIMITS:
            known = BY_ID.get(str(self.meta.get("condition") or self.name))
            style = known.style if known else ("whisper" if "whisper" in self.name else "normal")
        return style

    @property
    def device_class(self) -> str:
        cls = self.meta.get("device_class")
        if cls in ("phone", "mac"):
            return cls
        known = BY_ID.get(str(self.meta.get("condition") or self.name))
        if known:
            return known.device
        return "phone" if self.meta.get("device") in ("iphone", "android", "phone") else "mac"

    @property
    def device(self) -> str:
        return str(self.meta.get("device") or self.device_class)


@dataclass
class SessionInfo:
    id: str
    source: str
    root: Path
    name: str = ""
    pilot: bool = False
    exam: bool = False
    started: datetime | None = None
    ended: datetime | None = None
    items: int | None = None
    order: int = 0
    takes: list[Take] = field(default_factory=list)

    def sort_key(self) -> tuple[float, int]:
        return (self.started.timestamp() if self.started else -math.inf, self.order)


def _time(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        t = datetime.fromisoformat(value)
    except ValueError:
        return None
    # A time without an offset is this Mac's local time.
    return t if t.tzinfo else t.astimezone()


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def scan_takes(root: Path, source: str) -> list[Take]:
    """The current takes under ``root``: a ``.json`` naming a session, with its ``.wav`` beside it
    (metadata is written first, so a crash can leave one without audio). ``.replaced/`` and
    other hidden folders are skipped."""
    root = Path(root)
    if not root.is_dir():
        return []
    takes = []
    for js in sorted(root.rglob("*.json")):
        rel = js.relative_to(root)
        if any(part.startswith(".") for part in rel.parts[:-1]):
            continue
        wav = js.with_suffix(".wav")
        meta = _read_json(js)
        if not wav.is_file() or not isinstance(meta, dict) or not meta.get("session"):
            continue
        txt = js.with_suffix(".txt")
        try:
            text = txt.read_text(encoding="utf-8").rstrip("\n")
        except (OSError, UnicodeDecodeError):
            text = str(meta.get("text") or "")
        takes.append(Take(id=js.stem, source=source, folder=rel.parent.as_posix(), wav=wav, text=text, meta=meta))
    return takes


def load_sessions(roots: list[tuple[str, Path]]) -> dict[str, SessionInfo]:
    """Every session in the logs and in the takes' metadata, with its takes."""
    sessions: dict[str, SessionInfo] = {}
    order = 0
    for source, root in roots:
        root = Path(root)
        log = root / SESSIONS_LOG
        lines = log.read_text(encoding="utf-8", errors="replace").splitlines() if log.is_file() else []
        for line in lines:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = ev.get("session") if isinstance(ev, dict) else None
            if not isinstance(sid, str) or not sid:
                continue
            order += 1
            s = sessions.setdefault(sid, SessionInfo(sid, source, root, pilot=source == "pilot", order=order))
            if ev.get("event") == "start":
                s.started = _time(ev.get("time")) or s.started
                s.name = str(ev.get("setup") or ev.get("condition") or s.name)
                s.exam = bool(ev.get("exam"))
                s.pilot = s.pilot or bool(ev.get("pilot"))
                s.items = ev["items"] if isinstance(ev.get("items"), int) else s.items
                s.order = order
            elif ev.get("event") == "end":
                s.ended = _time(ev.get("time")) or s.ended
        for take in scan_takes(root, source):
            order += 1
            s = sessions.setdefault(take.session, SessionInfo(take.session, source, root,
                                                              pilot=source == "pilot", order=order))
            s.takes.append(take)
            s.name = s.name or take.name
            s.pilot = s.pilot or bool(take.meta.get("pilot"))
            s.exam = s.exam or bool(take.meta.get("exam"))
    for s in sessions.values():
        times = sorted(t for t in (_time(x.meta.get("recorded_at")) for x in s.takes) if t)
        if times:
            s.started = s.started or times[0]
            s.ended = s.ended or times[-1]
        s.takes.sort(key=lambda t: (t.folder, t.id))
    return sessions


def pick_session(sessions: dict[str, SessionInfo], wanted: str | None) -> tuple[SessionInfo, list[SessionInfo]]:
    """The session to check, and the newer ones passed over for having no takes."""
    newest = sorted(sessions.values(), key=SessionInfo.sort_key, reverse=True)
    if wanted:
        found = [s for s in newest if s.id == wanted] or [s for s in newest if s.id.startswith(wanted)]
        if len(found) != 1:
            some = ", ".join(f"{s.id} ({s.name})" for s in newest[:6]) or "none"
            why = "is ambiguous" if found else "is not there"
            raise CheckError(f"no session {wanted} (the id {why}); the latest sessions: {some}")
        if not found[0].takes:
            raise CheckError(f"session {found[0].id} ({found[0].name}) has no takes")
        return found[0], []
    for n, s in enumerate(newest):
        if s.takes:
            return s, newest[:n]
    raise CheckError(f"no takes in any session yet; the latest is {newest[0].id} ({newest[0].name})")


# --- the app --------------------------------------------------------------------------------


def pick_app(explicit: Path | str | None = None) -> app_module.App:
    """The binary that transcribes: ``--app-bin`` or ``WT_APP_BIN``; else the installed app (the
    one the owner records with) before the repository's builds, like ``app.handoff_training``,
    the first with the batch interface, else the first there is."""
    chosen = explicit or os.environ.get("WT_APP_BIN")
    if chosen:
        found = app_module.App(Path(chosen))
        if not found.bin.is_file():
            raise FileNotFoundError(f"no WalkieTalkey binary at {found.bin}")
        return found
    installed = app_module.INSTALLED_APP
    order = [installed, *(p for p in app_module.candidates() if p != installed)]
    existing = [app_module.App(p) for p in order if p.is_file()]
    if not existing:
        raise FileNotFoundError("no WalkieTalkey app found; install it, or pass --app-bin")
    return next((a for a in existing if a.supports_batch), existing[0])


# --- one take -------------------------------------------------------------------------------


@dataclass
class Row:
    take: Take
    stats: audiostats.AudioStats
    check: checks.CheckResult
    problems: dict[str, str] = field(default_factory=dict)
    transcript: str | None = None
    transcribe_error: str | None = None
    wer: float | None = None
    word_errors: int | None = None
    ref_words: int | None = None

    def as_dict(self) -> dict:
        t = self.take
        return {
            "id": t.id, "source": t.source, "folder": t.folder, "wav": str(t.wav), "text": t.text,
            "style": t.style, "device": t.device, "device_class": t.device_class,
            "microphone": t.meta.get("microphone"), "take": t.meta.get("take"),
            "recorded_at": t.meta.get("recorded_at"), "stats": _plain(self.stats.as_dict()),
            "check": _plain(self.check.as_dict()), "problems": list(self.problems), "details": self.problems,
            "transcript": self.transcript, "transcribe_error": self.transcribe_error,
            "wer": None if self.wer is None else round(self.wer, 4), "word_errors": self.word_errors,
            "ref_words": self.ref_words,
        }


def _plain(d: dict) -> dict:
    """numpy scalars (some measurements are) as plain Python values, for JSON."""
    return {k: v.item() if isinstance(v, np.generic) else v for k, v in d.items()}


def _samples(wav: Path) -> tuple[np.ndarray, int]:
    x, rate = sf.read(str(wav), dtype="int16", always_2d=True)
    return (x[:, 0] if x.shape[1] == 1 else x.mean(axis=1).astype(np.int16)), rate


def _dbfs(v: float) -> str:
    return f"{round(v)} dBFS"


def examine(take: Take) -> Row:
    """The audio problems of one take (the match comes later, for the whole session at once)."""
    stats = audiostats.measure(take.wav)
    samples, rate = _samples(take.wav)
    style, limits = take.style, checks.LIMITS[take.style]
    result = checks.check_take(samples, style=style, device=take.device_class, text=take.text, rate=rate)
    row = Row(take, stats, result)
    found = set(result.problems)
    # The recorder also calls a take silent when it is too close to the room noise; that one has
    # speech in it, so it is a noisy take here.
    heard = result.speech_seconds > 0 and result.level_dbfs >= limits.silent_dbfs
    if "silent" in found and not heard:
        row.problems["silent"] = ""
        return row
    noisy = "silent" in found or stats.snr_db < NOISY_SNR_DB[style]
    if not stats.silent and not noisy and stats.snr_db >= CUT_MIN_SNR_DB and (stats.cut_start or stats.cut_end):
        row.problems["cut"] = " and ".join(e for e, cut in (("start", stats.cut_start), ("end", stats.cut_end)) if cut)
    if "clipped" in found:
        row.problems["clipped"] = ""
    if "quiet" in found:
        row.problems["quiet"] = _dbfs(stats.level_dbfs)
    if stats.level_dbfs > LOUD_DBFS[style] and "clipped" not in found:
        row.problems["loud"] = _dbfs(stats.level_dbfs)
    if noisy:
        row.problems["noisy"] = f"SNR {round(stats.snr_db)} dB"
    if "short" in found:
        row.problems["short"] = f"{result.speech_seconds:.1f} s"
    return row


def match(rows: list[Row], app_bin: Path | None, spelling_path: Path | None) -> dict:
    """Transcribe the heard takes with base Edda through the app (one batch) and flag the
    ones that do not match their text."""
    from .evaluate import AppTranscriber
    from .metrics import score_clip
    from .spelling import load_spelling

    heard = [r for r in rows if "silent" not in r.problems]
    if not heard:
        return {"ran": False, "reason": "every take is silent"}
    try:
        found = pick_app(app_bin)
        found.check_model(paths.SHIPPED_EDDA_ID)
        results = AppTranscriber(found, paths.SHIPPED_EDDA_ID).transcribe([r.take.wav for r in heard])
    except (FileNotFoundError, ValueError, RuntimeError, OSError, subprocess.SubprocessError) as e:
        return {"ran": False, "reason": " ".join(str(e).split())[:200]}
    spelling = load_spelling(spelling_path) if spelling_path and Path(spelling_path).is_file() else None
    errors = words = 0
    failed = []
    for row, (text, error) in zip(heard, results):
        if error:
            row.transcribe_error = error
            failed.append(row.take.id)
            continue
        reference = spelling.apply(row.take.text) if spelling else row.take.text
        scored = score_clip(row.take.id, reference, text)
        row.transcript = text
        row.word_errors = scored["sub"] + scored["del"] + scored["ins"]
        row.ref_words = scored["ref_words"]
        row.wer = row.word_errors / row.ref_words if row.ref_words else float(row.word_errors > 0)
        errors += row.word_errors
        words += row.ref_words
        if not text.strip():
            row.problems["mismatch"] = "nothing heard"
        elif row.wer > MISMATCH_WER and row.word_errors >= MISMATCH_MIN_ERRORS:
            row.problems["mismatch"] = f"WER {round(row.wer * 100)} %"
    return {"ran": True, "app": str(found.bin), "model": paths.SHIPPED_EDDA_ID,
            "transcribed": len(heard) - len(failed), "wer": round(errors / words, 4) if words else None,
            "failed": failed}


# --- the report -----------------------------------------------------------------------------


def _summary(rows: list[Row]) -> dict:
    heard = [r for r in rows if "silent" not in r.problems] or rows
    levels = [r.stats.level_dbfs for r in heard]
    snrs = [r.stats.snr_db for r in heard]
    seconds = [r.stats.seconds for r in rows]
    return {
        "takes": len(rows),
        "level_dbfs": round(median(levels), 1), "level_min_dbfs": min(levels), "level_max_dbfs": max(levels),
        "peak_dbfs": max(r.stats.peak_dbfs for r in rows),
        "noise_dbfs": round(median(r.stats.noise_dbfs for r in heard), 1),
        "snr_db": round(median(snrs), 1), "snr_min_db": min(snrs),
        "clipped_takes": sum("clipped" in r.problems for r in rows),
        "seconds": round(sum(seconds), 1), "seconds_median": round(median(seconds), 2),
        "seconds_min": min(seconds), "seconds_max": max(seconds),
        "speech_seconds": round(float(sum(r.stats.speech_seconds for r in rows)), 1),
    }


def _counts(values) -> dict[str, int]:
    return dict(Counter(str(v) if v else "not recorded" for v in values).most_common())


def _style(rows: list[Row]) -> str | None:
    """The session's style, or None when its takes mix styles."""
    styles = {r.take.style for r in rows}
    return styles.pop() if len(styles) == 1 else None


def label(kind: str, style: str | None) -> str:
    voice = f"a {VOICE[style]}" if style else "the style"
    return {
        "silent": "silent (no speech found)",
        "cut": "cut off (speech at the very start or end)",
        "clipped": "clipped",
        "quiet": f"too quiet for {voice}"
                 + (f" (below {round(checks.LIMITS[style].quiet_dbfs)} dBFS)" if style else ""),
        "loud": f"too loud for {voice}" + (f" (above {round(LOUD_DBFS[style])} dBFS)" if style else ""),
        "noisy": "noisy" + (f" (SNR below {round(NOISY_SNR_DB[style])} dB)" if style else ""),
        "short": "short (less speech than the text needs; let go too soon?)",
        "mismatch": f"not matching the text (WER above {round(MISMATCH_WER * 100)} % or nothing heard)",
    }[kind]


def _verdict_phrase(kind: str, style: str | None) -> str:
    voice = f"a {VOICE[style]}" if style else "the style"
    return {"silent": "are silent", "cut": "are cut off", "clipped": "are clipped",
            "quiet": f"are too quiet for {voice}", "loud": f"are too loud for {voice}", "noisy": "are noisy",
            "short": "are too short", "mismatch": "do not match their text"}[kind]


def _hint(kind: str, style: str | None) -> str:
    return {
        "silent": "check that the right microphone is selected and not muted",
        "cut": "press before the first word and let go after the last",
        "clipped": "move back from the microphone or lower its gain",
        "quiet": "hold the microphone closer or speak up",
        "loud": "whisper, or hold the microphone further away" if style == "whisper"
                else "move back from the microphone",
        "noisy": "find a quieter room",
        "short": "hold the button until the sentence is done",
        "mismatch": "check that the sentence read is the one shown, and the microphone",
    }[kind]


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def _listing(items: list[str], room: int) -> str:
    """``items`` joined while they fit in ``room`` characters, then "and N more" (at least one)."""
    shown: list[str] = []
    length = 0
    for n, item in enumerate(items):
        add = len(item) + (2 if shown else 0)
        left = len(items) - n - 1
        reserve = len(f" and {left} more") if left else 0
        if shown and length + add + reserve > room:
            break
        shown.append(item)
        length += add
    rest = len(items) - len(shown)
    return ", ".join(shown) + (f" and {rest} more" if rest else "")


def verdict(rows: list[Row], problems: dict[str, list[str]], redo: list[str], transcription: dict,
            room: int = WIDTH) -> str:
    n = len(rows)
    caveat = ""
    if not transcription["ran"]:
        caveat = " (audio only; the match check did not run)"
    elif transcription.get("failed"):
        caveat = f" ({_plural(len(transcription['failed']), 'take')} not transcribed, their match unchecked)"
    if not redo:
        return "OK to continue" + caveat
    style = _style(rows)
    threshold = max(SYSTEMIC_MIN, math.ceil(SYSTEMIC_SHARE * n))
    systemic = [k for k in KINDS if len(problems[k]) >= threshold]
    if systemic:
        kind = max(systemic, key=lambda k: len(problems[k]))
        return (f"fix the setup, then redo this session's {_plural(n, 'take')}: {len(problems[kind])} of "
                f"{_plural(n, 'take')} {_verdict_phrase(kind, style)} ({_hint(kind, style)}){caveat}")
    head = f"redo {_plural(len(redo), 'take')}: "
    return head + _listing(redo, room - len(head) - len("verdict: ") - len(caveat)) + caveat


def _when(started: datetime | None, ended: datetime | None) -> str:
    """When, in the offset the recorder wrote (the owner's local time then)."""
    if not started:
        return "time unknown"
    text = started.strftime("%Y-%m-%d %H:%M")
    if ended and ended >= started:
        text += " to " + ended.strftime("%H:%M" if ended.date() == started.date() else "%Y-%m-%d %H:%M")
        minutes = round((ended - started).total_seconds() / 60)
        text += f" ({minutes} min)" if minutes else " (under a minute)"
    return text


def _named(counts: dict[str, int], most: int = 2) -> str:
    names = [k[:40] if len(counts) == 1 else f"{k[:40]} ({v})" for k, v in list(counts.items())[:most]]
    rest = len(counts) - most
    return ", ".join(names) + (f" and {_plural(rest, 'other')}" if rest > 0 else "")


def _quote(text: str, most: int = 55) -> str:
    text = " ".join(text.split())
    return '"' + (text if len(text) <= most else text[: most - 3].rstrip() + "...") + '"'


def report(session: SessionInfo, passed_over: list[SessionInfo], rows: list[Row], transcription: dict) -> dict:
    problems = {k: [r.take.id for r in rows if k in r.problems] for k in KINDS}
    redo = [r.take.id for r in rows if r.problems]
    text = verdict(rows, problems, redo, transcription)
    return {
        "session": {
            "id": session.id, "source": session.source, "folder": str(session.root), "name": session.name,
            "pilot": session.pilot, "exam": session.exam,
            "started": session.started.isoformat() if session.started else None,
            "ended": session.ended.isoformat() if session.ended else None, "items": session.items,
            "devices": _counts(f"{r.take.device} ({r.take.device_class})" for r in rows),
            "microphones": _counts(r.take.meta.get("microphone") for r in rows),
            "styles": _counts(r.take.style for r in rows),
            "app_versions": _counts(r.take.meta.get("app_version") for r in rows),
        },
        "passed_over": [s.id for s in passed_over],
        "summary": _summary(rows),
        "transcription": transcription,
        "problems": problems,
        "redo": redo,
        "verdict": text,
        "exit_code": 1 if redo else 0,
        "takes": [r.as_dict() for r in rows],
    }


def render(rep: dict, rows: list[Row]) -> list[str]:
    """The summary: at most MAX_LINES plain lines, the verdict last."""
    s, m, tr = rep["session"], rep["summary"], rep["transcription"]
    what = f"pilot setup {s['name']}" if s["pilot"] else f"condition {s['name']}"
    takes = _plural(m["takes"], "take") + (f" of the {s['items']} on its list" if s["items"] else "")
    when = _when(_time(s["started"]), _time(s["ended"]))
    head = [f"session {s['id']}: {what}{' (exam)' if s['exam'] else ''}, {when}, {takes}"]
    if rep["passed_over"]:
        many = len(rep["passed_over"]) > 1
        head.append(f"newer session{'s' if many else ''} without takes: {', '.join(rep['passed_over'][:3])}"
                    f" (passed over)")
    styles = ", ".join(s["styles"])
    versions = [v for v in s["app_versions"] if v != "not recorded"]
    head.append(f"device: {_named(s['devices'])}; microphone: {_named(s['microphones'])}; style: {styles}"
                + (f"; app {', '.join(versions[:2])}" if versions else ""))
    clipped = m["clipped_takes"]
    head.append(f"speech level: median {_dbfs(m['level_dbfs'])} (range {round(m['level_min_dbfs'])} to "
                f"{round(m['level_max_dbfs'])}), loudest sample {_dbfs(m['peak_dbfs'])}, clipping: "
                + (_plural(clipped, "take") if clipped else "none"))
    head.append(f"noise in the pauses: median {_dbfs(m['noise_dbfs'])}; estimated SNR: median "
                f"{round(m['snr_db'])} dB, lowest {round(m['snr_min_db'])} dB")
    head.append(f"length: median {m['seconds_median']:.1f} s per take ({m['seconds_min']:.1f} to "
                f"{m['seconds_max']:.1f} s), {m['seconds'] / 60:.1f} min in all, "
                f"{m['speech_seconds'] / 60:.1f} min of speech")
    if tr["ran"]:
        wer = "WER n/a" if tr["wer"] is None else f"WER {tr['wer'] * 100:.1f} %"
        line = (f"match (base Edda through the app): {wer} over {_plural(tr['transcribed'], 'take')}, "
                f"{len(rep['problems']['mismatch'])} not matching")
        if tr["failed"]:
            line += f", {len(tr['failed'])} not transcribed: " + _listing(tr["failed"], WIDTH - len(line) - 20)
        head.append(line)
    else:
        head.append(f"match: not checked ({tr['reason']})")

    style = _style(rows)
    by_id = {r.take.id: r for r in rows}
    body = []
    if not rep["redo"]:
        body.append("problems: none")
    else:
        body.append(f"problems in {len(rep['redo'])} of {_plural(m['takes'], 'take')}:")
        for kind in KINDS:
            ids = rep["problems"][kind]
            if not ids:
                continue
            prefix = f"  {label(kind, style)}, {_plural(len(ids), 'take')}: "
            items = [f"{i} ({by_id[i].problems[kind]})" if by_id[i].problems[kind] else i for i in ids]
            body.append(prefix + _listing(items, WIDTH - len(prefix)))
    details = []
    for i in rep["problems"]["mismatch"][:HEARD_LINES]:
        r = by_id[i]
        heard = _quote(r.transcript) if r.transcript and r.transcript.strip() else "nothing"
        details.append(f"    {i} read {_quote(r.take.text)} heard {heard}")
    room = MAX_LINES - len(head) - len(body) - 1
    lines = head + body + details[:max(0, room)]
    return lines[: MAX_LINES - 1] + [f"verdict: {rep['verdict']}"]


# --- the step -------------------------------------------------------------------------------


def parse(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="wt-train check", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--session", help="the session id (or a unique prefix) to check instead of the latest")
    p.add_argument("--no-transcribe", action="store_true", help="skip the match through the app (quick, offline)")
    p.add_argument("--json", action="store_true", help="print the full details as JSON instead")
    p.add_argument("--recordings", type=Path, default=paths.RECORDINGS, help="the recordings folder")
    p.add_argument("--pilot", type=Path, default=paths.PILOT, help="the pilot folder")
    p.add_argument("--app-bin", type=Path, help="the WalkieTalkey binary that transcribes")
    p.add_argument("--spelling", type=Path, default=paths.SPELLING_YAML,
                   help="spelling.yaml, to re-spell the texts like the training data")
    return p.parse_args(argv)


def run(a: argparse.Namespace) -> tuple[int, dict | None, list[str], str | None]:
    """(exit code, report, summary lines, error message)."""
    sessions = load_sessions([("recordings", a.recordings), ("pilot", a.pilot)])
    if not sessions:
        return 2, None, [], (f"no recording sessions in {a.recordings} or {a.pilot}; record with "
                             "wt-train record (or wt-train pilot), then check again")
    try:
        session, passed_over = pick_session(sessions, a.session)
    except CheckError as e:
        return 2, None, [], str(e)
    rows = [examine(t) for t in session.takes]
    transcription = {"ran": False, "reason": "--no-transcribe"} if a.no_transcribe else \
        match(rows, a.app_bin, a.spelling)
    rep = report(session, passed_over, rows, transcription)
    return rep["exit_code"], rep, render(rep, rows), None


def main(argv: list[str]) -> int:
    a = parse(argv)
    code, rep, lines, error = run(a)
    if error is not None:
        if a.json:
            print(json.dumps({"error": error, "exit_code": code}, ensure_ascii=False, indent=2))
        else:
            print(error, file=sys.stderr)
        return code
    print(json.dumps(rep, ensure_ascii=False, indent=2) if a.json else "\n".join(lines))
    return code
