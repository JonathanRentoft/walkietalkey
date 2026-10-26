"""One recording session: one condition, its sentences (or the exam), the app's link.

The app on this Mac connects out to the recorder (:mod:`.server`) and asks for
commands; the session holds them in order, numbered, so a long poll that is lost
loses nothing. The commands:

``prompt``     what to read now (``next``, absent when the condition is complete),
               the last take and its check (``last``), and the progress. For a
               phone condition the app sends it to the phone as a training_prompt
               (PROTOCOL.md 8.4); the page shows the same.
``mac_start``  record ``prompt`` on the Mac's own input (the Mac condition, from the
``mac_stop``   page's space bar); ``mac_stop`` ends the take and the app hands it
``mac_cancel`` over, ``mac_cancel`` drops it.
``end``        the session is over: the app tells the phone, which returns to normal.

A take is accepted for the current sentence, or for the last one kept (a redo; the
earlier take is kept aside). It is checked (:mod:`.checks`); a refused take
(silent, gaps) is not saved and the sentence stays; a kept take is saved with its
metadata, and the session moves to the next sentence without a take, wrapping
round, so stopping and starting again resumes where the owner left off. A take
that failed a check is kept and offered for a redo.

Run 7, the pilot: a session for a recording ``setup`` (``wt-train pilot record``) reads
the pilot sentences in that setup's device and style, keeps its takes in the setup's
folder, and adds ``setup`` and ``pilot: true`` to each take's metadata and to the
session log. The app sees an ordinary session: the hello answer is still only the
device and the style.
"""

from __future__ import annotations

import base64
import secrets
import threading
import time
from datetime import datetime
from pathlib import Path

import numpy as np

from ..conditions import Condition, device_name
from .checks import check_take
from .takes import TakeStore, UnknownItem, log_session

# How long the app may be silent (between two polls) before the page says it is gone.
APP_GONE_S = 45.0
KEEP_COMMANDS = 200


class AppRefused(ValueError):
    """The app's hello cannot start this session (for example no phone is paired)."""


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


class Session:
    def __init__(self, *, root: Path, condition: Condition, items: list, texts: dict[str, str],
                 exam: bool = False, phone: str | None = None, setup: str | None = None, clock=time.time):
        self.id = secrets.token_hex(8)
        self.training = secrets.token_bytes(16)
        self.condition = condition
        self.items = list(items)
        self.exam = exam
        self.setup = setup
        self.root = Path(root)
        self.store = TakeStore(root, condition.id, texts, exam=exam, setup=setup)
        self.phone_hint = phone
        self.clock = clock
        self.cond = threading.Condition()
        self.commands: list[dict] = []
        self.seq = 0
        # The highest command number the app has fetched.
        self.fetched = 0
        self.app: dict | None = None
        self.app_seen = 0.0
        self.phone: dict | None = None
        self.last: dict | None = None
        # The sentence of the last take that was kept: the one a redo reads again.
        self.last_saved: str | None = None
        self.recording: dict | None = None
        self.error: str | None = None
        self.ended = False
        self.saved = 0
        statuses = [self.store.status(i.id) for i in self.items]
        self.index: int | None = next((n for n, st in enumerate(statuses) if st != "recorded"), None)
        log_session(self.root, {"event": "start", "session": self.id, "condition": condition.id, "exam": exam,
                                **self._pilot(), "items": len(self.items), "time": _now()})

    # --- helpers ----------------------------------------------------------------

    def _pilot(self) -> dict:
        """What a pilot session adds to its log lines and its takes' metadata."""
        return {"setup": self.setup, "pilot": True} if self.setup is not None else {}

    def _push(self, command: dict) -> None:
        self.seq += 1
        self.commands.append({"seq": self.seq, **command})
        del self.commands[:-KEEP_COMMANDS]
        self.cond.notify_all()

    def _item(self, item_id: str):
        for n, item in enumerate(self.items):
            if item.id == item_id:
                return n, item
        raise UnknownItem(item_id)

    def _done(self) -> int:
        return sum(self.store.status(i.id) == "recorded" for i in self.items)

    def _prompt(self) -> dict:
        current = self.items[self.index] if self.index is not None else None
        last = None
        if self.last:
            last = {k: self.last[k] for k in ("prompt", "text", "check")}
        return {"type": "prompt", "next": {"prompt": current.id, "text": current.text} if current else None,
                "last": last, "done": self._done(), "total": len(self.items)}

    def _push_prompt(self) -> None:
        self._push(self._prompt())

    def _next_open(self, after: int) -> int | None:
        n = len(self.items)
        for k in range(1, n + 1):
            i = (after + k) % n
            if self.store.status(self.items[i].id) != "recorded":
                return i
        return None

    # --- the app ----------------------------------------------------------------

    def hello(self, info: dict) -> dict:
        """The app connected. Picks the phone for a phone condition; the first prompt follows."""
        with self.cond:
            phones = [p for p in info.get("phones") or [] if isinstance(p, dict) and p.get("id")]
            phone = None
            if self.condition.device == "phone":
                if not phones:
                    raise AppRefused("no phone is paired with WalkieTalkey on this Mac")
                hint = (self.phone_hint or "").casefold()
                named = [p for p in phones if hint and hint in str(p.get("name", "")).casefold()]
                online = [p for p in phones if p.get("online")]
                phone = (named or online or phones)[0]
            self.app = {"version": str(info.get("version") or ""), "os": str(info.get("os") or ""),
                        "input": info.get("input"), "phones": phones}
            self.phone = phone
            self.app_seen = self.clock()
            self.error = None
            self._push_prompt()
            return {"training": b64u(self.training), "device": self.condition.device,
                    "style": self.condition.style, "phone": phone["id"] if phone else None}

    def next_commands(self, after: int, timeout: float) -> list[dict]:
        """Commands numbered above ``after``, waiting up to ``timeout`` seconds for one."""
        with self.cond:
            self.app_seen = self.clock()
            self.cond.wait_for(lambda: self.seq > after or self.ended, timeout=timeout)
            self.app_seen = self.clock()
            out = [c for c in self.commands if c["seq"] > after]
            if out:
                self.fetched = max(self.fetched, out[-1]["seq"])
            return out

    def event(self, ev: dict) -> None:
        """Status from the app: a take started or was cancelled, the phone's status, the Mac input."""
        with self.cond:
            self.app_seen = self.clock()
            kind = ev.get("type")
            if kind == "recording":
                self.recording = {"prompt": ev.get("prompt"), "source": ev.get("source"),
                                  "since": self.clock(), "confirmed": True}
                if ev.get("input") and self.app is not None:
                    self.app["input"] = ev["input"]
                self.error = None
            elif kind == "cancelled":
                self.recording = None
            elif kind == "mac_failed":
                self.recording = None
                self.error = f"Mac'en kunne ikke optage: {ev.get('message') or 'ukendt fejl'}"
            elif kind == "phone" and self.phone and ev.get("id") == self.phone["id"]:
                self.phone = {**self.phone, "online": bool(ev.get("online"))}
            elif kind == "bye":
                self.app = None
                self.recording = None
            elif kind == "error":
                self.error = str(ev.get("message") or "")

    def take(self, meta: dict, samples: np.ndarray) -> dict:
        """A take from the app: check it, save it if it is kept, and tell the phone what is next."""
        with self.cond:
            self.app_seen = self.clock()
            self.recording = None
            prompt = str(meta.get("prompt") or "")
            source = meta.get("source")
            current = self.items[self.index].id if self.index is not None else None
            if source != self.condition.device or prompt not in {current, self.last_saved} - {None}:
                return {"saved": False, "check": "error", "problems": ["error"], "replaced": False,
                        "message": "not a take of the current sentence in this condition"}
            n, item = self._item(prompt)
            result = check_take(samples, style=self.condition.style, device=self.condition.device,
                                text=item.text, missing=int(meta.get("missing") or 0))
            replaced = False
            take_no = self.store.earlier_takes(item.id) + (1 if self.store.status(item.id) != "missing" else 0) + 1
            if result.saved:
                replaced = self.store.save(item.id, samples, self._meta(item, meta, result, take_no))
                self.saved += 1
                self.last_saved = item.id
            self.last = {"prompt": item.id, "text": item.text, "check": result.check, "saved": result.saved,
                         "problems": list(result.problems), "seconds": round(result.seconds, 2),
                         "replaced": replaced}
            if result.saved and n == self.index:
                self.index = self._next_open(n)
            self._push_prompt()
            return {"saved": result.saved, "check": result.check, "problems": list(result.problems),
                    "replaced": replaced, "take": take_no if result.saved else None}

    def _meta(self, item, meta: dict, result, take_no: int) -> dict:
        c = self.condition
        phone = self.phone if c.device == "phone" else None
        # The phone names its microphone in audio_start_training; the Mac's is the app's input.
        microphone = meta.get("microphone") or meta.get("input")
        if c.device == "mac":
            microphone = microphone or (self.app or {}).get("input")
        out = {
            "schema": 1,
            "id": item.id,
            "text": item.text,
            "kind": item.kind,
            "exam": self.exam,
            "condition": c.id,
            "device": device_name(c.device, phone.get("platform") if phone else None),
            "device_class": c.device,
            "style": c.style,
            "microphone": microphone or None,
            "phone": {"name": phone.get("name"), "platform": phone.get("platform")} if phone else None,
            "app_version": (self.app or {}).get("version") or None,
            "capture": "app",
            "session": self.id,
            "take": take_no,
            "recorded_at": _now(),
            "sample_rate": 16000,
            "seconds": round(result.seconds, 3),
            "checks": result.as_dict(),
            **self._pilot(),
        }
        if c.device == "phone":
            out["relay"] = {"session": meta.get("session"), "chunks": meta.get("chunks"),
                            "missing": int(meta.get("missing") or 0)}
        return out

    # --- the page ---------------------------------------------------------------

    def go(self, index: int) -> None:
        with self.cond:
            if self.recording or not self.items:
                return
            self.index = max(0, min(len(self.items) - 1, index))
            self._push_prompt()

    def next(self) -> None:
        self.go((self.index if self.index is not None else -1) + 1)

    def prev(self) -> None:
        self.go((self.index if self.index is not None else len(self.items)) - 1)

    def redo_last(self) -> None:
        """Back to the sentence last kept, to read it again."""
        with self.cond:
            if not self.last_saved or self.recording:
                return
            n, _ = self._item(self.last_saved)
        self.go(n)

    def mac_start(self) -> bool:
        with self.cond:
            if self.condition.device != "mac" or self.app is None or self.recording or self.index is None:
                return False
            prompt = self.items[self.index].id
            self.recording = {"prompt": prompt, "source": "mac", "since": self.clock(), "confirmed": False}
            self.error = None
            self._push({"type": "mac_start", "prompt": prompt})
            return True

    def mac_stop(self) -> bool:
        with self.cond:
            if self.condition.device != "mac" or not self.recording:
                return False
            self.recording = {**self.recording, "stopping": True}
            self._push({"type": "mac_stop"})
            return True

    def mac_cancel(self) -> None:
        with self.cond:
            if self.condition.device == "mac" and self.recording:
                self.recording = None
                self._push({"type": "mac_cancel"})

    def end(self) -> None:
        with self.cond:
            if self.ended:
                return
            self._push({"type": "end"})
            self.ended = True
            log_session(self.root, {"event": "end", "session": self.id, "condition": self.condition.id,
                                    "exam": self.exam, **self._pilot(), "saved": self.saved, "time": _now()})

    def state(self) -> dict:
        with self.cond:
            connected = self.app is not None and self.clock() - self.app_seen < APP_GONE_S
            statuses = [self.store.status(i.id) for i in self.items]
            return {
                "session": self.id,
                "condition": {"id": self.condition.id, "label": self.condition.label,
                              "device": self.condition.device, "style": self.condition.style},
                "exam": self.exam,
                "pilot": {"setup": self.setup} if self.setup is not None else None,
                "app": {"connected": connected, **({k: self.app[k] for k in ("version", "input")}
                                                   if self.app else {})},
                "phone": self.phone,
                "items": [{"id": i.id, "text": i.text, "kind": i.kind, "status": st}
                          for i, st in zip(self.items, statuses)],
                "index": self.index,
                "done": statuses.count("recorded"),
                "total": len(self.items),
                "complete": self.index is None,
                "last": self.last,
                "recording": self.recording,
                "error": self.error,
                "ended": self.ended,
            }


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")
