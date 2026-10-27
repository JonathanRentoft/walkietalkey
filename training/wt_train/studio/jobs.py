"""Long work as jobs: child processes of Værkstedet's server, so a crash in one (a
training, an export, the pilot comparison, a report) never takes the server down.

A job is ``python -m wt_train <step> ...`` (the same interpreter, ``uv`` not needed),
started in ``training/`` in a session of its own, with its standard output and error
read line by line; the last :data:`KEEP_LINES` lines are kept for the page. Its status is
``running``, then ``done`` (exit 0), ``failed`` (any other exit) or ``stopped`` (stopped
from the page or by the server's exit). Stopping signals the job's whole process group (its
own session), so what it started, the app's ``--transcribe-list`` under a pilot report or
an export's tools, ends with it: SIGINT (the step ends cleanly: a training's MLflow run
ends KILLED), then SIGTERM after :data:`STOP_GRACE_S`, then SIGKILL after
:data:`KILL_GRACE_S` more. When the server stops, every job is stopped at once on a shorter
budget (:data:`SHUTDOWN_GRACE_S`, :data:`SHUTDOWN_KILL_GRACE_S`), so the server is gone
well before the launcher's own SIGKILL.

``on_exit(job)`` runs when a job's process has ended, in the job's own reader thread;
whatever it returns becomes the job's ``result``. ``companion`` is a second process tied
to the job (``caffeinate -w <pid>`` beside a training), ended with it.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

KEEP_LINES = 400
STOP_GRACE_S = 15.0
KILL_GRACE_S = 10.0
# When the server stops: SIGINT, 5 s, SIGTERM, 3 s, SIGKILL.
SHUTDOWN_GRACE_S = 5.0
SHUTDOWN_KILL_GRACE_S = 3.0
# After SIGKILL, how long to wait for the group to be gone.
KILLED_WAIT_S = 1.0
STATUSES = ("running", "done", "failed", "stopped")


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def signal_group(pgid: int, sig: int) -> bool:
    """``sig`` to every process of a group; False when none is left."""
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def step_argv(*args: str) -> list[str]:
    """``wt-train <args>`` as this interpreter runs it."""
    return [sys.executable, "-m", "wt_train", *args]


@dataclass
class Job:
    id: str
    kind: str
    title: str
    argv: list[str]
    proc: subprocess.Popen | None = None
    status: str = "running"
    started: str = field(default_factory=_now)
    ended: str | None = None
    exit: int | None = None
    result: object = None
    log: deque = field(default_factory=lambda: deque(maxlen=KEEP_LINES))
    stop_requested: bool = False
    companion: subprocess.Popen | None = None
    meta: dict = field(default_factory=dict)
    done: threading.Event = field(default_factory=threading.Event)

    def as_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "title": self.title, "status": self.status,
                "started": self.started, "ended": self.ended, "exit": self.exit, "log": list(self.log),
                "result": self.result}

    @property
    def running(self) -> bool:
        return self.status == "running"

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc is not None else None


class Jobs:
    """The server's jobs, numbered ``j1``, ``j2``, ... from its start."""

    def __init__(self, *, cwd: Path | None = None, env: dict | None = None, on_change=None):
        from .. import paths

        self.cwd = Path(cwd) if cwd is not None else paths.TRAINING
        self.env = dict(env or {})
        self.on_change = on_change or (lambda: None)
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._n = 0

    def start(self, kind: str, title: str, argv: list[str], *, on_exit=None, env: dict | None = None,
              meta: dict | None = None) -> Job:
        with self._lock:
            self._n += 1
            job = Job(id=f"j{self._n}", kind=kind, title=title, argv=list(argv), meta=dict(meta or {}))
            self._jobs[job.id] = job
        environment = {**os.environ, "PYTHONUNBUFFERED": "1", **self.env, **(env or {})}
        try:
            job.proc = subprocess.Popen(job.argv, cwd=self.cwd, env=environment, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError as e:
            job.log.append(f"could not start {job.argv[0]}: {e}")
            self._finish(job, None, on_exit)
            return job
        threading.Thread(target=self._read, args=(job, on_exit), daemon=True, name=f"job-{job.id}").start()
        self.on_change()
        return job

    def _read(self, job: Job, on_exit) -> None:
        assert job.proc is not None and job.proc.stdout is not None
        for raw in job.proc.stdout:
            job.log.append(raw.decode("utf-8", "replace").rstrip("\n"))
        self._finish(job, job.proc.wait(), on_exit)

    def _finish(self, job: Job, code: int | None, on_exit) -> None:
        if job.companion is not None and job.companion.poll() is None:
            signal_group(job.companion.pid, signal.SIGTERM)
        job.exit = code
        if on_exit is not None:
            try:
                job.result = on_exit(job)
            except Exception as e:  # noqa: BLE001 - a job's result never takes the server down
                job.log.append(f"reading the result failed: {type(e).__name__}: {e}")
        job.status = "stopped" if job.stop_requested else ("done" if code == 0 else "failed")
        job.ended = _now()
        job.done.set()
        self.on_change()

    def attach(self, job: Job, argv: list[str]) -> subprocess.Popen | None:
        """Start ``argv`` beside ``job`` (``caffeinate -i -w <pid>``); it ends with the job."""
        try:
            job.companion = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                             stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError as e:
            job.log.append(f"could not start {argv[0]}: {e}")
            job.companion = None
        return job.companion

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def running(self, kind: str | None = None) -> list[Job]:
        with self._lock:
            return [j for j in self._jobs.values() if j.running and (kind is None or j.kind == kind)]

    def latest(self, kind: str) -> Job | None:
        with self._lock:
            found = [j for j in self._jobs.values() if j.kind == kind]
        return found[-1] if found else None

    def stop(self, job_id: str, *, grace: float = STOP_GRACE_S, kill_grace: float = KILL_GRACE_S) -> Job | None:
        """SIGINT now, SIGTERM after ``grace`` seconds, SIGKILL after ``kill_grace`` more, each to
        the job's process group (in a thread of its own; the call returns at once)."""
        job = self.get(job_id)
        if job is None or not job.running or job.proc is None:
            return job
        job.stop_requested = True
        threading.Thread(target=self._escalate, args=(job, grace, kill_grace), daemon=True).start()
        self.on_change()
        return job

    def _escalate(self, job: Job, grace: float, kill_grace: float) -> None:
        if job.proc is None:
            return
        pgid = job.proc.pid  # start_new_session: the job leads its own group
        for sig, wait in ((signal.SIGINT, grace), (signal.SIGTERM, kill_grace), (signal.SIGKILL, KILLED_WAIT_S)):
            if not signal_group(pgid, sig):
                return
            deadline = time.monotonic() + wait
            # Done (its output closed and it exited) and nothing else left in its group.
            while (left := deadline - time.monotonic()) > 0:
                if not job.done.is_set():
                    job.done.wait(min(0.1, left))
                elif not signal_group(pgid, 0):
                    return
                else:
                    time.sleep(min(0.1, left))

    def stop_all(self, wait: bool = True) -> list[Job]:
        """Stop every running job on the shutdown budget; with ``wait``, until they are gone
        (:meth:`wait_all`). Returns the jobs it stopped."""
        jobs = self.running()
        for job in jobs:
            self.stop(job.id, grace=SHUTDOWN_GRACE_S, kill_grace=SHUTDOWN_KILL_GRACE_S)
        if wait:
            self.wait_all(jobs)
        return jobs

    @staticmethod
    def wait_all(jobs: list[Job], started: float | None = None) -> None:
        """Wait for ``jobs`` to end, at most the shutdown budget from ``started`` (default now)."""
        deadline = (started or time.monotonic()) + SHUTDOWN_GRACE_S + SHUTDOWN_KILL_GRACE_S + KILLED_WAIT_S + 0.5
        for job in jobs:
            job.done.wait(max(0.0, deadline - time.monotonic()))
