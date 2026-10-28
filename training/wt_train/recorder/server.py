"""The recorder's local web server: ``wt-train record``.

It listens on 127.0.0.1 only (there is no option to change that). Two clients:

The page (static/index.html, app.js, style.css), in the owner's browser::

    GET  /                          the page
    GET  /api/state                 the session, the progress per condition, the app link
    POST /api/next | /api/prev      move to another sentence (the phone follows)
    POST /api/go?index=N
    POST /api/redo                  back to the sentence just recorded
    POST /api/skip                  pass over the current sentence this round ("Spring over")
    POST /api/mac/start | stop | cancel   a take on the Mac's own input (the mac condition): the
                                    press, the release (mac_stop follows the post-roll) and
                                    Escape; the input is armed ahead of the press (session.py)
    POST /api/connect               hand the session to the app again
    GET  /api/takes/<id>.wav        the current take of a sentence, to play it back

The WalkieTalkey app, which connects out to this server (the app opens no socket
of its own): its API, ``/app/v1/hello|next|takes|events``, is :mod:`.appapi`, shared
with Værkstedet (``wt-train studio``). The recorder hands the app
``http://127.0.0.1:<port>/app/v1#<token>`` with ``walkietalkey --training-session <url>``
(the single-instance handoff, like ``--toggle-transcription``).

Takes are written to training/data/recordings/ (git-ignored) and nowhere else (the
pilot's, ``wt-train pilot record``, to training/data/pilot/, which :func:`serve` runs too);
the server makes no outbound connections, and the page's Content-Security-Policy
lets it talk to this server only. Requests must name this server as their Host
(no DNS rebinding). The page's posts need its own header and origin, so another
web page in the same browser cannot drive it. The app's API needs the session's
token, which only the app gets (the page never sees it), and refuses any request
with an Origin, which a browser sends with every POST and every cross-origin
request.
"""

from __future__ import annotations

import argparse
import hmac
import re
import secrets
import signal
import sys
import threading
import time
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from ..conditions import CONDITIONS, IDS, condition
from ..paths import EXAM_YAML, PLAN_CSV, RECORDINGS, SENTENCES_CSV, SPELLING_YAML
from .appapi import MAX_JSON, LocalHandler
from .session import Session
from .takes import TakeStore, UnknownItem

HOST = "127.0.0.1"
DEFAULT_PORT = 8765
UPLOAD_HEADER = "X-WT-Recorder"

STATIC = Path(__file__).parent / "static"
FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "media-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'none'"
)
_TAKE_WAV = re.compile(r"/api/takes/([^/]+)\.wav")


def condition_rows(conditions=CONDITIONS) -> list[dict]:
    """The page's progress table: one row per condition (``progress`` is keyed by its id)."""
    return [{"id": c.id, "label": c.label, "device": c.device, "style": c.style} for c in conditions]


class RecorderServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, session: Session, token: str, port: int, progress=None, connect=None,
                 rows: list[dict] | None = None):
        super().__init__((HOST, port), _Handler)
        self.session = session
        self.token = token
        self._progress = progress or (lambda: {})
        self._progress_cache: tuple[int, dict] | None = None
        self.connect = connect
        self.link = {"status": "waiting", "detail": ""}
        # The rows of the page's progress table (the conditions, or the pilot's setups).
        self.rows = rows if rows is not None else condition_rows()

    @property
    def origins(self) -> set[str]:
        port = self.server_address[1]
        return {f"{HOST}:{port}", f"localhost:{port}"}

    def progress(self) -> dict:
        key = self.session.saved
        if self._progress_cache is None or self._progress_cache[0] != key:
            self._progress_cache = (key, self._progress())
        return self._progress_cache[1]

    def app_url(self) -> str:
        return f"http://{HOST}:{self.server_address[1]}/app/v1#{self.token}"

    # The app's API (appapi.py) ------------------------------------------------

    def app_session(self, authorization: str, fetching: bool = False) -> Session | None:
        if hmac.compare_digest(authorization.encode(), f"Bearer {self.token}".encode()):
            return self.session
        return None

    def app_link(self, status: str, detail: str) -> None:
        self.link = {"status": status, "detail": detail}


def make_server(session: Session, token: str, port: int = DEFAULT_PORT, progress=None,
                connect=None, rows: list[dict] | None = None) -> RecorderServer:
    """A server for ``session`` on 127.0.0.1:``port`` (0 picks a free port)."""
    return RecorderServer(session, token, port, progress=progress, connect=connect, rows=rows)


class _Handler(LocalHandler):
    server: RecorderServer
    server_version = "wt-train-recorder"
    csp = CSP

    # Guards ---------------------------------------------------------------

    def _page_post_ok(self) -> bool:
        origin = self.headers.get("Origin")
        same_origin = origin is None or origin in {f"http://{o}" for o in self.server.origins}
        return same_origin and self.headers.get(UPLOAD_HEADER) == "1"

    # Routes ---------------------------------------------------------------

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        path = url.path
        if path.startswith("/app/"):
            return self.app_get()
        if not self._host_ok():
            return self._error(403, "forbidden", "unknown Host")
        if path in FILES:
            name, content_type = FILES[path]
            return self._send(200, (STATIC / name).read_bytes(), content_type)
        if path == "/api/state":
            return self._json(200, self._state())
        m = _TAKE_WAV.fullmatch(path)
        if m:
            try:
                wav = self.server.session.store.wav_path(unquote(m.group(1)))
            except UnknownItem:
                return self._error(404, "unknown", "no such sentence")
            if wav.is_file():
                return self._send(200, wav.read_bytes(), "audio/wav")
        return self._error(404, "not-found", "not found")

    def do_POST(self) -> None:
        url = urlsplit(self.path)
        path = url.path
        if path.startswith("/app/"):
            return self.app_post()
        body = self._body(MAX_JSON)
        if body is None:
            return
        if not self._host_ok() or not self._page_post_ok():
            return self._error(403, "forbidden", "only the recorder page")
        session = self.server.session
        actions = {
            "/api/next": session.next,
            "/api/prev": session.prev,
            "/api/redo": session.redo_last,
            "/api/skip": session.skip,
            "/api/mac/start": session.mac_start,
            "/api/mac/stop": session.mac_stop,
            "/api/mac/cancel": session.mac_cancel,
        }
        if path in actions:
            actions[path]()
            return self._json(200, self._state())
        if path == "/api/go":
            try:
                session.go(int(parse_qs(url.query).get("index", [""])[0]))
            except ValueError:
                return self._error(400, "index", "index must be a number")
            return self._json(200, self._state())
        if path == "/api/connect":
            if self.server.connect:
                threading.Thread(target=self.server.connect, daemon=True).start()
            return self._json(200, self._state())
        return self._error(404, "not-found", "not found")

    # The page ---------------------------------------------------------------

    def _state(self) -> dict:
        return {"session": self.server.session.state(), "progress": self.server.progress(),
                "link": self.server.link, "conditions": self.server.rows}


# --- progress ---------------------------------------------------------------------


def progress_of(root: Path, sentences, plan: dict[str, str], exam) -> dict:
    """Per condition: planned sentences recorded, takes beyond the plan, exam paragraphs read."""
    from ..plan import progress

    texts = {s.id: s.text for s in sentences}
    recorded = {cid: TakeStore(root, cid, texts).recorded() for cid in IDS}
    out = progress(plan, recorded)
    exam_texts = {p.id: p.text for p in exam}
    for cid in IDS:
        out[cid]["exam_done"] = len(TakeStore(root, cid, exam_texts, exam=True).recorded())
        out[cid]["exam_total"] = len(exam_texts)
    return out


def progress_table(progress: dict, shown=CONDITIONS) -> str:
    lines = [f"{'condition':<15} {'sentences':>14} {'exam':>8}"]
    for c in shown:
        p = progress[c.id]
        extra = f" (+{p['extra']})" if p["extra"] else ""
        lines.append(f"{c.id:<15} {p['done']:>6} of {p['total']:<4}{extra} {p['exam_done']:>3} of {p['exam_total']}")
    return "\n".join(lines)


# --- the command line ----------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="wt-train record",
        description=(
            "Record the sentences through the WalkieTalkey app, one condition per session: on the "
            "phone (through its pairing, end-to-end encrypted like a dictation) or on the Mac's own "
            f"input. Serves http://{HOST}:<port>/ on this Mac only; takes go to training/data/recordings/."
        ),
    )
    parser.add_argument("--condition", choices=IDS,
                        help="a condition with a share in the mix (mix.yaml beside the plan; by default "
                             "phone-whisper, phone-normal or mac-normal); the exam takes any condition. "
                             "Without it, the progress is shown")  # fmt: skip
    parser.add_argument("--exam", action="store_true", help="read the exam paragraphs instead of the sentences")
    parser.add_argument("--phone", help="part of the phone's name, when several phones are paired")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"port on {HOST} (default {DEFAULT_PORT}; 0 picks a free one)")  # fmt: skip
    parser.add_argument("--no-browser", action="store_true", help="do not open the page in the browser")
    parser.add_argument("--app-bin", type=Path, help="the WalkieTalkey binary that hands the session to the app")
    parser.add_argument("--app-url-file", type=Path,
                        help="write the app's link (with its token) to this file instead (tests)")  # fmt: skip
    parser.add_argument("--sentences", type=Path, default=SENTENCES_CSV, help="sentence list (id,text,kind)")
    parser.add_argument("--plan", type=Path, default=PLAN_CSV,
                        help="the condition of each sentence (its split record, splits.csv, beside it)")
    parser.add_argument("--spelling", type=Path, default=SPELLING_YAML, help="spelling.yaml: the terms the split covers")
    parser.add_argument("--exam-file", type=Path, default=EXAM_YAML, help="the exam paragraphs")
    parser.add_argument("--recordings", type=Path, default=RECORDINGS, help="folder for the takes")
    args = parser.parse_args(argv)

    from ..exam import load_exam
    from ..plan import format_mix, mix_path, prepare

    # Run 12: the split record first, then the plan, for the list and the owner's own sentences.
    prepared = prepare(args.sentences, args.plan, spelling_path=args.spelling, recordings=args.recordings)
    sentences, plan, changes = prepared.sentences, prepared.plan, prepared.changes
    exam = load_exam(args.exam_file)
    if changes["added"] or changes["removed"]:
        print(f"plan: {changes['added']} sentence(s) added, {changes['removed']} removed ({args.plan})")
    if prepared.dealt.written:
        print("\n".join(prepared.dealt.describe()))
    mix = prepared.mix
    progress = lambda: progress_of(args.recordings, sentences, plan, exam)  # noqa: E731
    # The conditions in the mix, and any other the owner has takes in or chose for this session.
    def shown(p: dict | None = None) -> list:
        return [c for c in CONDITIONS if mix[c.id] > 0 or c.id == args.condition
                or (p is not None and (p[c.id]["done"] or p[c.id]["extra"] or p[c.id]["exam_done"]))]

    if not args.condition:
        p = progress()
        print(progress_table(p, shown(p)))
        print(f"\nmix: {format_mix(mix)} ({mix_path(args.plan)})")
        print("Record one condition per session, for example: wt-train record --condition phone-whisper")
        return 0

    c = condition(args.condition)
    if mix[c.id] == 0 and not args.exam:
        print(f"{c.id} has no share in the mix ({format_mix(mix)}; {mix_path(args.plan)}), so no sentence is "
              f"planned in it. Give it one with: wt-train plan --mix ...,{c.id}=<percent>", file=sys.stderr)
        return 2
    if args.exam:
        items, texts = exam, {p.id: p.text for p in exam}
    else:
        items = [s for s in sentences if plan.get(s.id) == c.id]
        texts = {s.id: s.text for s in sentences}
    session = Session(root=args.recordings, condition=c, items=items, texts=texts, exam=args.exam,
                      phone=args.phone)
    what = "the exam" if args.exam else "sentences"
    return serve(session, port=args.port, progress=progress, rows=condition_rows(shown()),
                 app_bin=args.app_bin, app_url_file=args.app_url_file, no_browser=args.no_browser,
                 describe=f"{c.id}, {what}: {session.state()['done']} of {len(items)} recorded; "
                          f"takes in {args.recordings}")  # fmt: skip


def _interrupt(signum, frame) -> None:
    raise KeyboardInterrupt


def stop_on_signals() -> None:
    """SIGTERM and SIGHUP (the terminal window closed) stop the recorder as Ctrl+C does, so the
    session ends on the way out: a Mac session's armed input is cancelled in the app (run 12)."""
    if threading.current_thread() is not threading.main_thread():
        return
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, _interrupt)


def serve(session: Session, *, port: int, progress, rows: list[dict] | None, app_bin: Path | None,
          app_url_file: Path | None, no_browser: bool, describe: str) -> int:
    """Run the page and the app's API for ``session`` until Ctrl+C, handing the session to the
    running app (or writing its link to ``app_url_file``); the session ends on the way out."""
    token = secrets.token_urlsafe(32)
    try:
        server = make_server(session, token, port, progress=progress, rows=rows)
    except OSError as e:
        print(f"cannot listen on {HOST}:{port}: {e.strerror}. Is the recorder already running? "
              "Try another --port.", file=sys.stderr)  # fmt: skip
        return 1

    def connect() -> None:
        url = server.app_url()
        if app_url_file:
            app_url_file.write_text(url + "\n", encoding="utf-8")
            app_url_file.chmod(0o600)
            server.link = {"status": "waiting", "detail": "manual"}
            return
        from ..app import handoff_training

        server.link = {"status": "connecting", "detail": ""}
        status, detail = handoff_training(url, app_bin)
        server.link = {"status": "waiting" if status == "ok" else status, "detail": detail}
        if status != "ok":
            print(f"WalkieTalkey: {detail}", file=sys.stderr, flush=True)

    server.connect = connect
    stop_on_signals()
    page = f"http://{HOST}:{server.server_address[1]}/"
    print(f"Recorder: {page}  ({describe})")
    print("Ctrl+C stops it.", flush=True)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()
    connect()
    if not no_browser:
        webbrowser.open(page)
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        # The app tells the phone, which returns to normal.
        session.end()
        deadline = time.time() + 3
        while time.time() < deadline and session.fetched < session.seq and server.link["status"] == "connected":
            time.sleep(0.05)
        server.shutdown()
        server.server_close()
    return 0
