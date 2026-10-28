"""Værkstedet's recording screen: one pick at a time, at most one live session.

A pick is a condition (its planned sentences, or with ``exam`` its exam paragraphs) or
a pilot setup (the pilot sentences). It is recorded through the recorder's own
:class:`~wt_train.recorder.session.Session`, the same prompts, takes, checks and files
as ``wt-train record`` and ``wt-train pilot record``, handed to the running app with
``app.handoff_training`` (or, for tests and the end-to-end run, its link written to a
file). Each session has its own token: the app's requests with an older one get 401, except
that the app may still fetch the last commands of a session that ended (``next``): its end, and
for a Mac session the cancel of its armed input before it (run 12, ``recorder/session.py``),
which the app must carry out even when it was busy when the owner switched.

* pause: the session ends (``end``; the app tells the phone, which returns to normal at
  once); the rows, takes and checks stay, and nothing can be recorded;
* resume: a new session for the same pick, handed to the app again, picking up the
  current sentence and the skips where they were;
* stop: pause, and the pick is forgotten.

Every row is one sentence: ``waiting`` (no take, or skipped this round), ``recording``,
``received`` (kept; its checks run, :mod:`.review`), ``approved`` or ``redo`` (sent back
by a check or by the owner; the queue comes back to it by itself). The queue is the
session's own wrap-round order, with ``waiting`` and ``redo`` open. "Tag om" sends a
take back and makes its sentence the current one; "Godkend alligevel" keeps it. The
phone's count ("17 af 120") is received plus approved.

The state carries a ``version`` that changes whenever anything in it changes (it is a
counter bumped whenever the state's content differs from the last one computed);
:meth:`Recorder.wait` answers a long poll.

Locks: the recorder's own lock is taken before a session's, never after; the session
calls back (``on_change``, ``on_take``, ``is_open``) holding its lock, so those touch
only the rows (``Entry.lock``) and the version, which wait for nothing.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from functools import cached_property
from pathlib import Path

from .. import app as app_module
from ..check import LOUD_DBFS
from ..conditions import BY_ID, CONDITIONS, Condition
from ..pilot import known_setups, parse_setup
from ..recorder.checks import LIMITS
from ..recorder.session import Session
from ..recorder.takes import TakeStore, UnknownItem
from . import labels
from .places import StudioPaths
from .review import Entry, Reviewer, identity
from .sources import Sources

HOST = "127.0.0.1"
LONG_POLL_S = 20.0
# Run 7's pilot setups, offered even before they have takes.
PILOT_SETUPS = ("iphone-whisper", "iphone-normal", "mac-normal", "mac-whisper", "airpods-normal", "studio")
# The level band the page's meter shows as good: from 5 dB above the quiet limit to 6 dB
# below the loud one (a normal voice about -20 dBFS, a whisper about -40).
GOOD_ABOVE_QUIET_DB = 5.0
GOOD_BELOW_LOUD_DB = 6.0
STATUSES = ("waiting", "recording", "received", "approved", "redo")
# How long the app may take to fetch the end command when the server stops.
END_WAIT_S = 3.0


class StudioError(Exception):
    """A request the studio refuses: the HTTP status, the error code the page knows, and an
    English message for the log."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _iso(t: float | None) -> str | None:
    return datetime.fromtimestamp(t).astimezone().isoformat(timespec="seconds") if t else None


def limits(style: str) -> dict:
    """The recorder's limits for a style and the good band (see the constants above)."""
    lim = LIMITS[style]
    loud = LOUD_DBFS[style]
    return {"quiet_dbfs": lim.quiet_dbfs, "silent_dbfs": lim.silent_dbfs, "loud_dbfs": loud,
            "good_dbfs": [lim.quiet_dbfs + GOOD_ABOVE_QUIET_DB, loud - GOOD_BELOW_LOUD_DB]}


@dataclass(eq=False)
class Pick:
    kind: str  # "condition" or "pilot"
    id: str
    condition: Condition
    label: str
    items: list
    texts: dict[str, str]
    root: Path
    exam: bool = False
    setup: str | None = None
    entries: dict[str, Entry] = field(default_factory=dict)

    @cached_property
    def store(self) -> TakeStore:
        return TakeStore(self.root, self.condition.id, self.texts, exam=self.exam, setup=self.setup)

    @property
    def folder(self) -> str:
        """The take URLs' folder: the condition, ``exam-<condition>`` or ``pilot-<setup>``."""
        if self.setup is not None:
            return f"pilot-{self.setup}"
        return f"exam-{self.condition.id}" if self.exam else self.condition.id

    def as_dict(self) -> dict:
        return {"kind": self.kind, "id": self.id, "label": self.label, "device": self.condition.device,
                "style": self.condition.style, "exam": self.exam}

    def is_open(self, item_id: str) -> bool:
        entry = self.entries.get(item_id)
        return entry is None or entry.status == "redo"


class Recorder:
    def __init__(self, places: StudioPaths, sources: Sources, reviewer: Reviewer, *, handoff=None,
                 clock=time.time):
        self.places = places
        self.sources = sources
        self.reviewer = reviewer
        self.handoff = handoff or app_module.handoff_training
        self.clock = clock
        self.port = 0
        self._lock = threading.RLock()
        self.pick: Pick | None = None
        self.session: Session | None = None
        self.token: str | None = None
        # Sessions that ended with commands the app has not fetched yet, with their tokens.
        self._ended: list[tuple[str, Session]] = []
        self.paused = False
        self.link = {"status": "waiting", "detail": ""}
        # Every take seen, by its WAV's path, so a pick opened again reuses what was measured.
        self._entries: dict[str, Entry] = {}
        self._changed = threading.Condition()
        self._changes = 0
        self._version = int(time.time() * 1000)
        self._signature = ""
        reviewer.on_result = self._reviewed

    # --- changes ------------------------------------------------------------------------

    def notify(self) -> None:
        with self._changed:
            self._changes += 1
            self._changed.notify_all()

    def _reviewed(self, entry: Entry) -> None:
        with self._lock:
            pick, session = self.pick, self.session
        if pick is not None and session is not None and pick.entries.get(entry.item_id) is entry \
                and not entry.pending:
            session.review_changed(entry.item_id)
        self.notify()

    # --- the app's API (recorder/appapi.py) ---------------------------------------------

    def app_session(self, authorization: str, fetching: bool = False) -> Session | None:
        """The session the app's token names; ``fetching`` (its ``next``) also reaches an ended
        session until the app has fetched its last commands."""
        with self._lock:
            session, token = self.session, self.token
            self._ended = [(t, s) for t, s in self._ended if s.fetched < s.seq]
            ended = list(self._ended) if fetching else []
        given = authorization.encode()
        if session is not None and token is not None and hmac.compare_digest(given, f"Bearer {token}".encode()):
            return session
        for old_token, old in ended:
            if hmac.compare_digest(given, f"Bearer {old_token}".encode()):
                return old
        return None

    def app_link(self, status: str, detail: str) -> None:
        with self._lock:
            self.link = {"status": status, "detail": detail}
        self.notify()

    def app_url(self) -> str:
        return f"http://{HOST}:{self.port}/app/v1#{self.token}"

    # --- picks --------------------------------------------------------------------------

    def _make_pick(self, kind: str, pid: str, exam: bool) -> Pick:
        if kind == "exam":
            kind, exam = "condition", True
        if kind == "condition":
            c = BY_ID.get(str(pid))
            if c is None:
                raise StudioError(404, "unknown", f"no condition {pid!r}")
            if not exam and self.sources.mix().get(c.id, 0) == 0:
                raise StudioError(409, "no-share", f"{c.id} has no share in the mix, so no sentence is planned in it")
            if exam:
                items = self.sources.exam()
            else:
                plan = self.sources.plan()
                items = [s for s in self.sources.sentences() if plan.get(s.id) == c.id]
            texts = {i.id: i.text for i in (self.sources.exam() if exam else self.sources.sentences())}
            return Pick("condition", c.id, c, c.label, items, texts, self.places.recordings, exam=exam)
        if kind == "pilot":
            try:
                setup = parse_setup(str(pid))
            except ValueError as e:
                raise StudioError(400, "bad-setup", str(e)) from None
            items = self.sources.pilot_sentences()
            return Pick("pilot", setup.name, setup.condition, labels.setup_label(setup.name, setup.style), items,
                        {s.id: s.text for s in items}, self.places.pilot, setup=setup.name)
        raise StudioError(400, "unknown", f"a pick is a condition or a pilot setup, not {kind!r}")

    def _load(self, pick: Pick) -> None:
        """The pick's current takes, measured ones reused; unreviewed ones go to the checks."""
        store, c = pick.store, pick.condition
        for item in pick.items:
            if store.status(item.id) != "recorded":
                continue
            try:
                meta = store.meta(item.id) or {}
            except (OSError, ValueError):  # a broken metadata file: the take is checked again
                meta = {}
            meta = meta if isinstance(meta, dict) else {}
            key = str(store.wav_path(item.id))
            entry = self._entries.get(key)
            if entry is None or entry.identity != identity(meta):
                entry = Entry.from_meta(store, item.id, item.text, c.style, c.device, meta)
                self._entries[key] = entry
                if entry.review is None:
                    self.reviewer.submit(entry)
                else:
                    self.reviewer.restore(entry)
            pick.entries[item.id] = entry

    def _new_session(self, pick: Pick, after: Session | None = None) -> None:
        def took(item, result, meta) -> None:
            store = pick.store
            entry = Entry(store, item.id, item.text, pick.condition.style, pick.condition.device, dict(meta))
            self._entries[str(store.wav_path(item.id))] = entry
            pick.entries[item.id] = entry
            self.reviewer.submit(entry)

        session = Session(root=pick.root, condition=pick.condition, items=pick.items, texts=pick.texts,
                          exam=pick.exam, setup=pick.setup, is_open=pick.is_open, on_change=self.notify,
                          on_take=took)
        if after is not None:
            snap = after.snapshot()
            session.resume_from(snap["current"], snap["skipped"])
        if self.session is not None and self.token is not None and self.session.ended:
            self._ended = [(t, s) for t, s in self._ended if s.fetched < s.seq][-3:] + [(self.token, self.session)]
        self.session = session
        self.token = secrets.token_urlsafe(32)
        self.paused = False
        self.link = {"status": "connecting", "detail": ""}

    def _connect(self) -> None:
        """Hand the current session to the running app (or write its link to the file)."""
        with self._lock:
            session, url = self.session, self.app_url()
        if session is None:
            return
        target = self.places.app_url_file
        if target is not None:
            Path(target).write_text(url + "\n", encoding="utf-8")
            Path(target).chmod(0o600)
            self.app_link("waiting", "manual")
            return

        def hand() -> None:
            status, detail = self.handoff(url, self.places.app_bin)
            with self._lock:
                # The app may have answered already (connected, no_phone, gone): that stays.
                if self.session is not session or self.link["status"] != "connecting":
                    return
                self.link = {"status": {"ok": "waiting", "not_running": "not_running"}.get(status, "error"),
                             "detail": detail}
            self.notify()

        threading.Thread(target=hand, daemon=True, name="studio-handoff").start()

    def start(self, body: dict) -> dict:
        kind, pid = str(body.get("kind") or ""), body.get("id")
        with self._lock:
            # The new pick is ready before the running session ends: if it cannot open, that
            # session goes on.
            pick = self._make_pick(kind, str(pid or ""), bool(body.get("exam")))
            self._load(pick)
            if self.session is not None and not self.session.ended:
                self.session.end()
            self.pick = pick
            self._new_session(pick)
        self._connect()
        self.notify()
        return self.state()

    def pause(self) -> dict:
        with self._lock:
            if self.session is not None and not self.session.ended:
                self.session.end()
            self.paused = self.pick is not None
        self.notify()
        return self.state()

    def resume(self) -> dict:
        with self._lock:
            if self.pick is None:
                raise StudioError(409, "no-pick", "nothing is picked to record")
            if self.session is not None and not self.session.ended:
                return self.state()
            self._new_session(self.pick, after=self.session)
        self._connect()
        self.notify()
        return self.state()

    def stop(self) -> dict:
        with self._lock:
            if self.session is not None and not self.session.ended:
                self.session.end()
            self.pick = None
            self.paused = False
        self.notify()
        return self.state()

    def shutdown(self, wait_s: float = END_WAIT_S) -> None:
        """The server stops: the session ends and the app gets a moment to fetch the end."""
        with self._lock:
            session = self.session
            if session is None:
                return
            session.end()
        deadline = time.time() + wait_s
        while time.time() < deadline and session.fetched < session.seq and self.link["status"] == "connected":
            time.sleep(0.05)

    # --- the owner's actions ------------------------------------------------------------

    def _live(self) -> tuple[Pick, Session]:
        if self.pick is None or self.session is None:
            raise StudioError(409, "no-pick", "nothing is picked to record")
        return self.pick, self.session

    def _entry(self, pick: Pick, item_id) -> Entry:
        entry = pick.entries.get(str(item_id or ""))
        if entry is None:
            raise StudioError(404, "unknown", f"no take of {item_id!r} in this pick")
        return entry

    def skip(self) -> dict:
        with self._lock:
            _, session = self._live()
            if session.snapshot()["recording"]:
                raise StudioError(409, "busy", "a take is recording")
            session.skip()
        return self.state()

    def go(self, item_id) -> dict:
        with self._lock:
            _, session = self._live()
            try:
                moved = session.go_to(str(item_id or ""))
            except UnknownItem:
                raise StudioError(404, "unknown", f"no sentence {item_id!r} in this pick") from None
            if not moved:
                raise StudioError(409, "busy", "a take is recording")
        return self.state()

    def redo(self, item_id) -> dict:
        with self._lock:
            pick, session = self._live()
            entry = self._entry(pick, item_id)
            if session.snapshot()["recording"]:
                raise StudioError(409, "busy", "a take is recording")
            self.reviewer.set_owner(entry, "redo")
            session.go_to(entry.item_id)
        self.notify()
        return self.state()

    def approve(self, item_id) -> dict:
        with self._lock:
            pick, session = self._live()
            entry = self._entry(pick, item_id)
            self.reviewer.set_owner(entry, "approved")
            session.review_changed(entry.item_id)
        self.notify()
        return self.state()

    def mac(self, what: str) -> dict:
        with self._lock:
            _, session = self._live()
            if session.ended:
                raise StudioError(409, "paused", "the session is paused")
            if what == "start":
                if not session.mac_start():
                    raise StudioError(409, "mac-not-ready", "no Mac take can start now (not a Mac pick, no app, "
                                                            "or a take is recording)")
            elif what == "stop":
                session.mac_stop()
            else:
                session.mac_cancel()
        return self.state()

    # --- the state ----------------------------------------------------------------------

    def summary(self) -> dict:
        """For the overview: whether a pick is recording, paused, and its name."""
        with self._lock:
            pick, session = self.pick, self.session
            live = pick is not None and session is not None and not session.ended
            return {"active": live, "paused": pick is not None and not live,
                    "label": pick.label if pick is not None else None}

    def _payload(self) -> dict:
        with self._lock:
            pick, session, link = self.pick, self.session, dict(self.link)
        empty = {"active": False, "paused": False, "pick": None, "link": link,
                 "app": {"connected": False, "version": None, "input": None}, "phone": None, "microphone": None,
                 "current": None, "recording": None, "counts": {"total": 0, **{s: 0 for s in STATUSES}},
                 "minutes": 0.0, "limits": None, "rows": [], "last": None, "error": None}
        if pick is None or session is None:
            return empty
        snap = session.snapshot()
        live = not snap["ended"]
        app = {"connected": snap["app"]["connected"], "version": snap["app"].get("version") or None,
               "input": snap["app"].get("input")}
        if link["status"] == "connected" and not app["connected"]:
            link = {"status": "gone", "detail": ""}
        recording = snap["recording"] if live else None
        rows, counts, seconds = [], {s: 0 for s in STATUSES}, 0.0
        latest: tuple[str, str | None] | None = None
        for item in pick.items:
            entry = pick.entries.get(item.id)
            if recording and recording.get("prompt") == item.id:
                status = "recording"
            else:
                status = entry.status if entry is not None else "waiting"
            counts[status] += 1
            take = None
            if entry is not None:
                take = entry.row(f"/api/takes/{pick.folder}/{item.id}.wav")
                seconds += entry.seconds
                when = str(entry.meta.get("recorded_at") or "")
                if latest is None or when > latest[0]:
                    latest = (when, entry.meta.get("microphone"))
            rows.append({"id": item.id, "text": item.text, "kind": item.kind, "status": status,
                         "skipped": item.id in snap["skipped"], "take": take})
        if pick.condition.device == "phone":
            microphone = {"name": latest[1] if latest else None, "source": "phone"}
        else:
            microphone = {"name": app["input"], "source": "mac"}
        phone = snap["phone"]
        return {
            "active": live,
            "paused": not live,
            "pick": pick.as_dict(),
            "link": link,
            "app": app,
            "phone": {k: phone.get(k) for k in ("name", "platform", "online")} if phone else None,
            "microphone": microphone,
            "current": snap["current"],
            "recording": ({"prompt": recording.get("prompt"), "source": recording.get("source"),
                           "since": _iso(recording.get("since")), "stopping": bool(recording.get("stopping"))}
                          if recording else None),
            "counts": {"total": len(pick.items), **counts},
            "minutes": round(seconds / 60, 1),
            "limits": limits(pick.condition.style),
            "rows": rows,
            "last": snap["last"],
            "error": snap["error"],
        }

    def state(self) -> dict:
        payload = self._payload()
        signature = hashlib.sha1(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()
        with self._changed:
            if signature != self._signature:
                self._signature = signature
                self._version += 1
            version = self._version
        return {"version": version, **payload}

    def wait(self, since: int | None, timeout: float = LONG_POLL_S) -> dict:
        """The state, once its version differs from ``since`` (at once when it does already),
        or after ``timeout`` seconds."""
        deadline = time.monotonic() + timeout
        while True:
            with self._changed:
                seen = self._changes
            state = self.state()
            left = deadline - time.monotonic()
            if since is None or state["version"] != since or left <= 0:
                return state
            with self._changed:
                self._changed.wait_for(lambda: self._changes != seen, timeout=min(1.0, left))

    # --- what can be picked, and how far each is ----------------------------------------

    def pilot_setups(self) -> list[dict]:
        sentences = self.sources.pilot_sentences()
        texts = {s.id: s.text for s in sentences}
        names = list(PILOT_SETUPS) + [n for n in known_setups(self.places.pilot) if n not in PILOT_SETUPS]
        out = []
        for name in names:
            s = parse_setup(name)
            takes = self.sources.takes(TakeStore(self.places.pilot, s.condition.id, texts, setup=name))
            out.append({"name": name, "label": labels.setup_label(name, s.style), "device": s.device,
                        "style": s.style, "done": sum(1 for t in takes.values() if t["review"] != "redo"),
                        "total": len(sentences), "suggested": name in PILOT_SETUPS})
        return out

    def options(self) -> dict:
        mix, summaries = self.sources.mix(), self.sources.summaries()
        conditions = [{"id": c.id, "label": c.label, "device": c.device, "style": c.style, "share": mix.get(c.id, 0),
                       "planned": summaries[c.id]["planned"], "done": summaries[c.id]["done"],
                       "redo": summaries[c.id]["redo"], "minutes": summaries[c.id]["minutes"]} for c in CONDITIONS]
        return {"conditions": conditions, "exam": {"paragraphs": len(self.sources.exam())},
                "pilot": {"sentences": len(self.sources.pilot_sentences()), "setups": self.pilot_setups()}}

    def progress(self) -> dict:
        mix, summaries = self.sources.mix(), self.sources.summaries()
        rows = [{"id": c.id, "label": c.label, "share": mix.get(c.id, 0), **summaries[c.id]} for c in CONDITIONS]
        return {"mix": mix, "sentences": len(self.sources.sentences()),
                "minutes": round(sum(r["minutes"] for r in rows), 1), "conditions": rows}
