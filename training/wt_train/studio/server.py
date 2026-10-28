"""Værkstedet's server: ``wt-train studio``, the workbench as a local app in the browser.

It listens on 127.0.0.1 only (there is no option to change that) and makes no outbound
connections. The contract with the page (``training/studio/``, built into ``dist/``) is
``training/studio/API.md``; this module is its routes and guards:

* every request must name this server as its ``Host`` (no DNS rebinding);
* every page ``POST`` needs ``X-WT-Studio: 1`` and, when an ``Origin`` is sent, this
  server's, so another web page in the same browser cannot drive it; bodies are JSON,
  at most 64 KiB;
* ``/app/v1/*`` is the WalkieTalkey app's API (``recorder/appapi.py``, shared with
  ``wt-train record``) with the current recording session's token; it refuses any
  request with an ``Origin``, and the page never sees the token;
* the page gets a Content-Security-Policy that lets it talk to this server only; the
  report pages (``/reports/``, one self-contained file each: inline styles, ``data:``
  audio) get their own, and may be framed by the page only;
* run 12: the words of the owner's own dictations (:mod:`.words`) travel in POST bodies
  only, never in a path or a query string, and nothing here logs a request line.

Starting (:func:`main`): the page is built when its sources changed (:mod:`.build`); one
server runs per work folder (``<work>/studio/server.json``: a second start opens the
running one and exits); port 8780, or the next free one; ``Værkstedet: <url>`` is
printed once it answers (the launcher reads that line). It stops on SIGTERM, SIGINT or
SIGHUP, or when ``--parent-pid`` is gone: the recording session ends (the phone returns to
normal), the jobs are stopped, ``server.json`` is removed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from ..conditions import IDS
from ..recorder.appapi import MAX_JSON, LocalHandler
from ..recorder.takes import SAFE_ID, SAFE_SETUP
from .data import DataView
from .jobs import Jobs
from .learn import Learn
from .measure import Measure
from .mix import MixView
from .notebook import Notebook
from .places import StudioPaths
from .recording import HOST, Recorder, StudioError
from .review import Reviewer
from .runs import AppInfo, Runs
from .sources import Sources
from .training import Training
from .words import OwnWords

DEFAULT_PORT = 8780
PORT_TRIES = 20
PAGE_HEADER = "X-WT-Studio"
READY = "Værkstedet: "
PARENT_POLL_S = 1.0
# How long the way out waits for the checks' thread (it is a daemon thread).
REVIEW_STOP_S = 0.5
# The launcher's wait after its SIGTERM before it sends SIGKILL (training/studio/launcher/).
LAUNCHER_KILL_AFTER_S = 20

CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; "
       "img-src 'self' data:; font-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; "
       "frame-ancestors 'none'")
REPORT_CSP = ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src data:; "
              "img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
    ".otf": "font/otf", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
    ".webmanifest": "application/manifest+json", ".wav": "audio/wav",
}
_TAKE = re.compile(r"/api/takes/([^/]+)/([^/]+)\.wav")
_JOB = re.compile(r"/api/jobs/(j\d+)")
_JOB_STOP = re.compile(r"/api/jobs/(j\d+)/stop")
_JOURNAL = re.compile(r"/api/journal/([^/]+)")
_REPORT = re.compile(r"/reports/([A-Za-z0-9][A-Za-z0-9._-]*\.html)")


def content_type(path: Path) -> str:
    return TYPES.get(path.suffix.lower(), "application/octet-stream")


def inside(root: Path, rel: str) -> Path | None:
    """A regular file under ``root`` named by a URL path, or None (no ``..``, no dot files)."""
    parts = [p for p in unquote(rel).split("/") if p]
    if not parts or any(p in (".", "..") or p.startswith(".") or "\\" in p for p in parts):
        return None
    base = Path(root).resolve()
    path = (Path(root) / Path(*parts)).resolve()
    if not path.is_relative_to(base) or not path.is_file():
        return None
    return path


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, places: StudioPaths, port: int = DEFAULT_PORT, *, transcriber=None, handoff=None,
                 find_app=None, caffeinate: list[str] | None = None, launch=None):
        super().__init__((HOST, port), _Handler)
        self.places = places
        self.sources = Sources(places)
        self.reviewer = Reviewer(spelling=places.spelling, transcriber=transcriber, app_bin=places.app_bin)
        self.recorder = Recorder(places, self.sources, self.reviewer, handoff=handoff)
        self.recorder.port = self.server_address[1]
        self.jobs = Jobs(env={"WT_WORK_DIR": str(places.work)})
        self.app = AppInfo(places.app_bin, find=find_app)
        self.training = Training(places, self.jobs, caffeinate=caffeinate)
        self.data = DataView(places)
        self.runs = Runs(places, self.jobs, self.app)
        self.notebook = Notebook(places)
        # Run 11: the learning notebooks; ``launch`` opens VS Code (tests pass a stand-in).
        self.learn = Learn(places, launch=launch)
        # Run 12: the owner's own words, the mix, and measuring on validation (test on purpose).
        self.words = OwnWords(places)
        self.mix = MixView(places, self.sources, self.recorder)
        self.measure = Measure(places, self.jobs)
        self.reviewer.start()

    @property
    def origins(self) -> set[str]:
        port = self.server_address[1]
        return {f"{HOST}:{port}", f"localhost:{port}"}

    @property
    def url(self) -> str:
        return f"http://{HOST}:{self.server_address[1]}/"

    # The app's API (recorder/appapi.py).
    def app_session(self, authorization: str):
        return self.recorder.app_session(authorization)

    def app_link(self, status: str, detail: str) -> None:
        self.recorder.app_link(status, detail)

    def overview(self) -> dict:
        facts = self.app.facts()
        rec = self.recorder.state()
        version = facts["version"] or (rec["app"]["version"] if rec["app"]["connected"] else None)
        return {"app": {"found": facts["found"], "path": facts["path"], "version": version, "batch": facts["batch"],
                        "connected": rec["link"]["status"] == "connected" and rec["app"]["connected"]},
                "work": str(self.places.work), "recording": self.recorder.summary(),
                "training": self.training.summary(), "jobs": [j.as_dict() for j in self.jobs.running()]}

    def pilot(self) -> dict:
        job = self.jobs.latest("pilot")
        return {"sentences": len(self.sources.pilot_sentences()),
                "setups": [{k: s[k] for k in ("name", "label", "device", "style", "done", "total")}
                           for s in self.recorder.pilot_setups()],
                "comparison": self.runs.comparison(), "job": job.as_dict() if job is not None else None}

    def take_file(self, folder: str, item_id: str) -> Path | None:
        if not SAFE_ID.fullmatch(item_id):
            return None
        p = self.places
        if folder.startswith("pilot-") and SAFE_SETUP.fullmatch(folder[6:]):
            return Path(p.pilot) / folder[6:] / f"{item_id}.wav"
        if folder.startswith("exam-") and folder[5:] in IDS:
            return Path(p.recordings) / "exam" / folder[5:] / f"{item_id}.wav"
        if folder in IDS:
            return Path(p.recordings) / folder / f"{item_id}.wav"
        return None

    def close(self) -> None:
        """Everything the server started ends: the jobs (SIGINT to each group at once, then
        SIGTERM and SIGKILL), the session (the app gets a moment to fetch its end meanwhile),
        the checks. At most about 10 s, inside the launcher's 20 s before its SIGKILL."""
        started = time.monotonic()
        jobs = self.jobs.stop_all(wait=False)
        self.recorder.shutdown()
        self.jobs.wait_all(jobs, started)
        self.reviewer.stop(REVIEW_STOP_S)


class _Handler(LocalHandler):
    server: StudioServer
    server_version = "wt-train-studio"
    csp = CSP

    # Guards -----------------------------------------------------------------

    def _page_post_ok(self) -> bool:
        origin = self.headers.get("Origin")
        same_origin = origin is None or origin in {f"http://{o}" for o in self.server.origins}
        return same_origin and self.headers.get(PAGE_HEADER) == "1"

    def _answer(self, work) -> None:
        """Run ``work()`` and answer its JSON, or the error the studio refused it with; anything
        unexpected is a 500 ``internal`` (the traceback goes to the log)."""
        try:
            result = work()
        except StudioError as e:
            return self._error(e.status, e.code, e.message)
        except Exception as e:  # noqa: BLE001 - the page gets an answer, the server goes on
            return self._internal(e)
        return self._json(200, result)

    def _internal(self, e: Exception) -> None:
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        if not self._answered:
            self._error(500, "internal", f"{type(e).__name__}: {e}")

    def _send(self, status: int, body: bytes, content_type: str, **kw) -> None:
        self._answered = True
        super()._send(status, body, content_type, **kw)

    def _guarded(self, route) -> None:
        self._answered = False
        try:
            route()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser went away
        except Exception as e:  # noqa: BLE001 - see _answer
            self._internal(e)

    def do_GET(self) -> None:
        self._guarded(self._get)

    def do_POST(self) -> None:
        self._guarded(self._post)

    # GET --------------------------------------------------------------------

    def _get(self) -> None:
        url = urlsplit(self.path)
        path = url.path
        if path.startswith("/app/"):
            return self.app_get()
        if not self._host_ok():
            return self._error(403, "forbidden", "unknown Host")
        query = parse_qs(url.query)
        srv = self.server
        if path.startswith("/api/"):
            return self._api_get(path, query)
        m = _REPORT.fullmatch(path)
        if m:
            page = inside(srv.places.reports, m.group(1))
            if page is None:
                return self._missing_report()
            return self._send(200, page.read_bytes(), "text/html; charset=utf-8", csp=REPORT_CSP)
        if path.startswith("/reports/"):
            return self._missing_report()
        if path.startswith("/files/journal/"):
            found = srv.notebook.file(unquote(path[len("/files/journal/"):]))
            if found is None:
                return self._error(404, "not-found", "no such file")
            return self._send(200, found.read_bytes(), content_type(found))
        if path.startswith("/files/"):
            return self._error(404, "not-found", "not found")
        return self._static(path)

    def _api_get(self, path: str, query: dict) -> None:
        srv = self.server
        routes = {
            "/api/ping": lambda: {"studio": True, "pid": os.getpid()},
            "/api/overview": srv.overview,
            "/api/recording/options": srv.recorder.options,
            "/api/progress": srv.recorder.progress,
            "/api/pilot": srv.pilot,
            "/api/data": lambda: srv.data.view((query.get("config") or [None])[0]),
            "/api/training/configs": srv.training.configs,
            "/api/training/state": srv.training.state,
            "/api/eval/runs": srv.runs.eval_runs,
            "/api/versions": srv.runs.versions,
            "/api/journal": srv.notebook.listing,
            "/api/learn": srv.learn.listing,
            "/api/ownwords": srv.words.view,
            "/api/mix": srv.mix.view,
            "/api/eval/measure": srv.measure.targets,
            "/api/eval/testset": srv.measure.testset,
        }
        if path in routes:
            return self._answer(routes[path])
        if path == "/api/recording/state":
            raw = (query.get("since") or [None])[0]
            try:
                since = int(raw) if raw not in (None, "") else None
            except ValueError:
                return self._error(400, "since", "since must be a number")
            return self._answer(lambda: srv.recorder.wait(since) if since is not None else srv.recorder.state())
        m = _TAKE.fullmatch(path)
        if m:
            wav = srv.take_file(unquote(m.group(1)), unquote(m.group(2)))
            if wav is None or not wav.is_file():
                return self._error(404, "unknown", "no such take")
            return self._send(200, wav.read_bytes(), "audio/wav")
        m = _JOB.fullmatch(path)
        if m:
            job = srv.jobs.get(m.group(1))
            return self._json(200, job.as_dict()) if job else self._error(404, "unknown", "no such job")
        m = _JOURNAL.fullmatch(path)
        if m:
            return self._answer(lambda: srv.notebook.read(unquote(m.group(1))))
        return self._error(404, "not-found", "not found")

    def _missing_report(self) -> None:
        """A 404 the page's iframe can show: under the report CSP, since the page's own forbids
        framing and the browser would show its block message instead."""
        body = b"<!doctype html><meta charset=utf-8><p>Rapporten findes ikke.</p>"
        self._send(404, body, "text/html; charset=utf-8", csp=REPORT_CSP)

    def _static(self, path: str) -> None:
        dist = self.server.places.dist
        if path.startswith("/assets/"):
            found = inside(dist, path)
            if found is None:
                return self._error(404, "not-found", "no such asset")
            return self._send(200, found.read_bytes(), content_type(found), cache="public, max-age=31536000, immutable")
        found = inside(dist, path) if path not in ("", "/") else None
        if found is not None and found.name != "index.html":
            return self._send(200, found.read_bytes(), content_type(found), cache="no-cache")
        index = Path(dist) / "index.html"
        if not index.is_file():
            body = b"The page is not built yet: bun run --cwd training/studio build\n"
            return self._send(503, body, "text/plain; charset=utf-8")
        return self._send(200, index.read_bytes(), "text/html; charset=utf-8", cache="no-cache")

    # POST -------------------------------------------------------------------

    def _post(self) -> None:
        path = urlsplit(self.path).path
        if path.startswith("/app/"):
            return self.app_post()
        raw = self._body(MAX_JSON)
        if raw is None:
            return
        if not self._host_ok() or not self._page_post_ok():
            return self._error(403, "forbidden", "only Værkstedet's page")
        body = self._json_body(raw)
        if body is None:
            return
        srv = self.server
        rec = srv.recorder
        routes = {
            "/api/recording/start": lambda: rec.start(body),
            "/api/recording/pause": rec.pause,
            "/api/recording/resume": rec.resume,
            "/api/recording/stop": rec.stop,
            "/api/recording/skip": rec.skip,
            "/api/recording/go": lambda: rec.go(body.get("id")),
            "/api/recording/redo": lambda: rec.redo(body.get("id")),
            "/api/recording/approve": lambda: rec.approve(body.get("id")),
            "/api/recording/mac/start": lambda: rec.mac("start"),
            "/api/recording/mac/stop": lambda: rec.mac("stop"),
            "/api/recording/mac/cancel": lambda: rec.mac("cancel"),
            "/api/pilot/compare": srv.runs.compare_pilot,
            "/api/training/start": lambda: srv.training.start(body.get("config")),
            "/api/training/stop": srv.training.stop,
            "/api/eval/report": lambda: srv.runs.report(body.get("run")),
            "/api/eval/compare": lambda: srv.runs.compare(body.get("a"), body.get("b")),
            "/api/versions/use": lambda: srv.runs.use(body.get("version")),
            "/api/versions/export": lambda: srv.runs.export(body.get("run")),
            "/api/journal": lambda: srv.notebook.create(body.get("run")),
            "/api/learn/open": lambda: srv.learn.open(body.get("name")),
            "/api/learn/reset": lambda: srv.learn.reset(body.get("name")),
            "/api/ownwords/tick": lambda: srv.words.tick(body),
            "/api/ownwords/sentence": lambda: srv.words.add_sentence(body),
            "/api/mix/preview": lambda: srv.mix.preview(body),
            "/api/mix/deal": lambda: srv.mix.deal(body),
            "/api/eval/measure": lambda: srv.measure.start(body),
        }
        if path in routes:
            return self._answer(routes[path])
        m = _JOB_STOP.fullmatch(path)
        if m:
            job = srv.jobs.stop(m.group(1))
            return self._json(200, job.as_dict()) if job else self._error(404, "unknown", "no such job")
        m = _JOURNAL.fullmatch(path)
        if m:
            return self._answer(lambda: srv.notebook.save(unquote(m.group(1)), body))
        return self._error(404, "not-found", "not found")


# --- one server per work folder -------------------------------------------------------


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def running(own: Path) -> str | None:
    """The URL of the Værkstedet that runs for this work folder, if one does and answers."""
    info = None
    try:
        info = json.loads((Path(own) / "server.json").read_text(encoding="utf-8"))
        pid, url = int(info["pid"]), str(info["url"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if pid == os.getpid() or not _alive(pid) or not url.startswith(f"http://{HOST}:"):
        return None
    try:
        with urllib.request.urlopen(url + "api/ping", timeout=2) as r:
            answer = json.loads(r.read().decode("utf-8"))
    except (OSError, ValueError):
        return None
    return url if answer.get("studio") and answer.get("pid") == pid else None


def write_server_json(own: Path, url: str) -> Path:
    own = Path(own)
    own.mkdir(parents=True, exist_ok=True)
    target = own / "server.json"
    part = own / ".server.json.part"
    part.write_text(json.dumps({"pid": os.getpid(), "url": url, "started": time.time()}) + "\n", encoding="utf-8")
    os.replace(part, target)
    return target


def remove_server_json(own: Path) -> None:
    target = Path(own) / "server.json"
    try:
        if json.loads(target.read_text(encoding="utf-8")).get("pid") == os.getpid():
            target.unlink()
    except (OSError, ValueError):
        pass


def make_server(places: StudioPaths, port: int | None = None, **fakes) -> StudioServer:
    """A server on ``port`` (0: any free one); without a port, 8780 or the next free one."""
    if port is not None:
        return StudioServer(places, port, **fakes)
    error: OSError | None = None
    for candidate in range(DEFAULT_PORT, DEFAULT_PORT + PORT_TRIES):
        try:
            return StudioServer(places, candidate, **fakes)
        except OSError as e:
            error = e
    raise error or OSError("no free port")


# --- the command line --------------------------------------------------------------


def parse(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="wt-train studio",
        description=("Værkstedet: the training workbench as a small app in the browser, on this Mac only "
                     f"(http://{HOST}:<port>/). Record, check the takes, set the mix, look at the data and "
                     "the English words of your own dictations, train, evaluate, switch versions, keep the lab "
                     "journal and open the learning notebooks."))
    p.add_argument("--port", type=int,
                   help=f"port on {HOST} (default {DEFAULT_PORT}, or the next free one; a given port must be free)")
    p.add_argument("--no-browser", action="store_true", help="do not open the page in the browser")
    p.add_argument("--no-build", action="store_true", help="serve the page as built, without building it first")
    p.add_argument("--parent-pid", type=int, help="stop when this process is gone (the launcher)")
    p.add_argument("--install-app", action="store_true",
                   help="build \"WalkieTalkey Værksted.app\" in ~/Applications, which starts this, and exit")
    d = StudioPaths()
    p.add_argument("--recordings", type=Path, default=d.recordings, help="the takes (training/data/recordings)")
    p.add_argument("--pilot-dir", type=Path, default=d.pilot, help="the pilot's takes (training/data/pilot)")
    p.add_argument("--sentences", type=Path, default=d.sentences, help="the sentence list (id,text,kind)")
    p.add_argument("--plan", type=Path, default=d.plan, help="the condition of each sentence (mix.yaml beside it)")
    p.add_argument("--exam-file", type=Path, default=d.exam, help="the exam paragraphs")
    p.add_argument("--pilot-sentences", type=Path, default=d.pilot_sentences, help="the pilot sentences")
    p.add_argument("--spelling", type=Path, default=d.spelling, help="spelling.yaml")
    p.add_argument("--configs", type=Path, default=d.configs, help="the experiment configs")
    p.add_argument("--journal", type=Path, default=d.journal, help="the lab journal's folder")
    p.add_argument("--notebooks", type=Path, default=d.notebooks,
                   help="the learning notebooks (training/notebooks; their working copies go to <work>/notebooks)")
    p.add_argument("--dist", type=Path, default=d.dist, help="the built page (training/studio/dist)")
    p.add_argument("--app-bin", type=Path, help="the WalkieTalkey binary (default: the installed app first)")
    p.add_argument("--app-url-file", type=Path,
                   help="write the app's link (with its token) to this file instead of handing it over (tests)")
    p.add_argument("--history-db", type=Path, default=d.history_db,
                   help="the app's dictation history, read-only (default: history.db beside its models folder, "
                        "or WT_APP_HISTORY_DB)")
    p.add_argument("--test-lock", type=Path, default=d.test_lock,
                   help="the frozen test set's lock file (training/data/test-lock.json)")
    return p.parse_args(argv)


def places_of(a: argparse.Namespace) -> StudioPaths:
    return StudioPaths(recordings=a.recordings, pilot=a.pilot_dir, sentences=a.sentences, plan=a.plan,
                       exam=a.exam_file, pilot_sentences=a.pilot_sentences, spelling=a.spelling, configs=a.configs,
                       journal=a.journal, dist=a.dist, app_bin=a.app_bin, app_url_file=a.app_url_file,
                       notebooks=a.notebooks, history_db=a.history_db, test_lock=a.test_lock)


def watch_parent(pid: int, stop: threading.Event) -> None:
    while not stop.wait(PARENT_POLL_S):
        if not _alive(pid):
            stop.set()
            print(f"the launcher (pid {pid}) is gone; stopping", flush=True)


class _Tolerant:
    """A stream whose writes after its reader went away are dropped. The launcher reads the
    server's output from a pipe; when it is gone, a print would raise ``BrokenPipeError`` in
    whatever thread printed (the parent watch, a take's line, the way out) and lose that work."""

    def __init__(self, stream):
        self._stream = stream
        self._gone = False

    def write(self, text: str) -> int:
        if not self._gone:
            try:
                return self._stream.write(text)
            except (OSError, ValueError):
                self._gone = True
        return len(text)

    def flush(self) -> None:
        if not self._gone:
            try:
                self._stream.flush()
            except (OSError, ValueError):
                self._gone = True

    def __getattr__(self, name):
        return getattr(self._stream, name)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    a = parse(argv)
    if not isinstance(sys.stdout, _Tolerant):
        sys.stdout, sys.stderr = _Tolerant(sys.stdout), _Tolerant(sys.stderr)
    if a.install_app:
        from .launcher import install

        return int(install([x for x in argv if x != "--install-app"]) or 0)
    places = places_of(a)
    url = running(places.own)
    if url is not None:
        print("Værkstedet runs already; opening it", file=sys.stderr, flush=True)
        print(f"{READY}{url}", flush=True)
        if not a.no_browser:
            webbrowser.open(url)
        if a.parent_pid:
            # The launcher reads the ready line from a pipe and sees the exit separately: give
            # the line time to arrive first, so it opens the page instead of reporting a crash.
            time.sleep(1.0)
        return 0
    if not a.no_build:
        from .build import ensure_built

        outcome = ensure_built(places.dist)
        if outcome.message:
            print(outcome.message, file=sys.stderr if outcome.status != "built" else sys.stdout, flush=True)
        if not outcome.ok:
            return 1
    try:
        server = make_server(places, a.port)
    except OSError as e:
        where = f"port {a.port}" if a.port is not None else f"ports {DEFAULT_PORT} to {DEFAULT_PORT + PORT_TRIES - 1}"
        print(f"error: cannot listen on {HOST}, {where}: {e.strerror or e}", file=sys.stderr)
        return 1
    stop = threading.Event()

    def on_signal(signum, frame) -> None:
        stop.set()

    # SIGHUP: the terminal it runs in closed.
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, on_signal)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True,
                     name="studio-http").start()
    write_server_json(places.own, server.url)
    if a.parent_pid:
        threading.Thread(target=watch_parent, args=(a.parent_pid, stop), daemon=True).start()
    print(f"{READY}{server.url}", flush=True)
    if not a.no_browser:
        webbrowser.open(server.url)
    try:
        while not stop.wait(0.5):
            pass
    finally:
        print("Værkstedet stops: ending the recording session and the jobs", flush=True)
        server.close()
        server.shutdown()
        server.server_close()
        remove_server_json(places.own)
    return 0
