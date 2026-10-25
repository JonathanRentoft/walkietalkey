"""The recorder's local web server: ``wt-train record``.

It listens on 127.0.0.1 only (there is no option to change that). Two clients:

The page (static/index.html, app.js, style.css), in the owner's browser::

    GET  /                          the page
    GET  /api/state                 the session, the progress per condition, the app link
    POST /api/next | /api/prev      move to another sentence (the phone follows)
    POST /api/go?index=N
    POST /api/redo                  back to the sentence just recorded
    POST /api/mac/start | stop | cancel   a take on the Mac's own input (the mac condition)
    POST /api/connect               hand the session to the app again
    GET  /api/takes/<id>.wav        the current take of a sentence, to play it back

The WalkieTalkey app, which connects out to this server (the app opens no socket
of its own). The recorder hands it ``http://127.0.0.1:<port>/app/v1#<token>``
with ``walkietalkey --training-session <url>`` (the single-instance handoff, like
``--toggle-transcription``); every request carries ``Authorization: Bearer
<token>``::

    POST /app/v1/hello              the app's version, its paired phones, its input
                                    -> the training session id, device, style, phone
    GET  /app/v1/next?after=N       the commands numbered above N (session.py), waiting
                                    up to 20 s for one
    POST /app/v1/takes              a take: 16 kHz mono PCM16 little-endian in the body,
                                    its metadata as base64url JSON in X-WT-Take
                                    -> saved, check, problems, replaced
    POST /app/v1/events             recording, cancelled, mac_failed, phone, bye, error

Takes are written to training/data/recordings/ (git-ignored) and nowhere else;
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
import base64
import hmac
import json
import re
import secrets
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from ..conditions import CONDITIONS, IDS, condition
from ..paths import EXAM_YAML, PLAN_CSV, RECORDINGS, SENTENCES_CSV
from . import audio
from .session import AppRefused, Session
from .takes import TakeStore, UnknownItem

HOST = "127.0.0.1"
DEFAULT_PORT = 8765
# The phone stops at 5 minutes (PHONE-29); a little slack for the pre-roll.
MAX_TAKE_S = 330
MAX_BODY = MAX_TAKE_S * audio.TARGET_RATE * 2
MAX_JSON = 64 * 1024
LONG_POLL_S = 20.0
UPLOAD_HEADER = "X-WT-Recorder"
TAKE_HEADER = "X-WT-Take"

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


class RecorderServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, session: Session, token: str, port: int, progress=None, connect=None):
        super().__init__((HOST, port), _Handler)
        self.session = session
        self.token = token
        self._progress = progress or (lambda: {})
        self._progress_cache: tuple[int, dict] | None = None
        self.connect = connect
        self.link = {"status": "waiting", "detail": ""}

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


def make_server(session: Session, token: str, port: int = DEFAULT_PORT, progress=None,
                connect=None) -> RecorderServer:
    """A server for ``session`` on 127.0.0.1:``port`` (0 picks a free port)."""
    return RecorderServer(session, token, port, progress=progress, connect=connect)


class _Handler(BaseHTTPRequestHandler):
    server: RecorderServer
    server_version = "wt-train-recorder"

    def log_message(self, format: str, *args) -> None:
        pass  # one line per take is printed instead

    # Guards ---------------------------------------------------------------

    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") in self.server.origins

    def _page_post_ok(self) -> bool:
        origin = self.headers.get("Origin")
        same_origin = origin is None or origin in {f"http://{o}" for o in self.server.origins}
        return same_origin and self.headers.get(UPLOAD_HEADER) == "1"

    def _app_ok(self) -> int:
        """0 when the app may call, else the HTTP status to refuse with."""
        if not self._host_ok() or self.headers.get("Origin") is not None:
            return 403
        given = self.headers.get("Authorization", "")
        if not hmac.compare_digest(given.encode(), f"Bearer {self.server.token}".encode()):
            return 401
        return 0

    # Responses ------------------------------------------------------------

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json")

    def _error(self, status: int, error: str, message: str) -> None:
        self._json(status, {"error": error, "message": message})

    def _body(self, limit: int) -> bytes | None:
        """The request body within ``limit``, or None after answering with an error."""
        try:
            length = int(self.headers.get("Content-Length", ""))
            if length < 0:
                raise ValueError
        except ValueError:
            self.close_connection = True
            self._error(411, "length", "Content-Length is required")
            return None
        if length > limit:
            self.close_connection = True
            self._error(413, "too-long", f"a take is at most {MAX_TAKE_S} s")
            return None
        return self.rfile.read(length)

    # Routes ---------------------------------------------------------------

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        path = url.path
        if path.startswith("/app/"):
            refused = self._app_ok()
            if refused:
                return self._error(refused, "forbidden", "the app's API needs the session's token")
            if path == "/app/v1/next":
                return self._next(parse_qs(url.query))
            return self._error(404, "not-found", "not found")
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
            body = self._body(MAX_BODY if path == "/app/v1/takes" else MAX_JSON)
            if body is None:
                return
            refused = self._app_ok()
            if refused:
                return self._error(refused, "forbidden", "the app's API needs the session's token")
            if path == "/app/v1/hello":
                return self._hello(body)
            if path == "/app/v1/takes":
                return self._take(body)
            if path == "/app/v1/events":
                return self._event(body)
            return self._error(404, "not-found", "not found")
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
                "link": self.server.link, "conditions": [
                    {"id": c.id, "label": c.label, "device": c.device, "style": c.style} for c in CONDITIONS]}

    # The app ----------------------------------------------------------------

    def _json_body(self, body: bytes) -> dict | None:
        try:
            value = json.loads(body.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            value = None
        if not isinstance(value, dict):
            self._error(400, "json", "expected a JSON object")
            return None
        return value

    def _hello(self, body: bytes) -> None:
        info = self._json_body(body)
        if info is None:
            return
        try:
            answer = self.server.session.hello(info)
        except AppRefused as e:
            self.server.link = {"status": "no_phone", "detail": str(e)}
            return self._error(409, "no_phone", str(e))
        self.server.link = {"status": "connected", "detail": str(info.get("version") or "")}
        phone = self.server.session.phone
        print(f"WalkieTalkey {info.get('version') or ''} connected" + (f"; phone: {phone.get('name')}" if phone else ""),
              flush=True)  # fmt: skip
        return self._json(200, answer)

    def _next(self, query: dict) -> None:
        try:
            after = int(query.get("after", ["0"])[0])
            wait = min(25.0, max(0.0, float(query.get("wait", [LONG_POLL_S])[0])))
        except ValueError:
            return self._error(400, "after", "after and wait must be numbers")
        commands = self.server.session.next_commands(after, timeout=wait)
        return self._json(200, {"commands": commands})

    def _take(self, body: bytes) -> None:
        raw = self.headers.get(TAKE_HEADER, "")
        try:
            meta = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8"))
            if not isinstance(meta, dict) or not raw:
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            return self._error(400, "meta", f"{TAKE_HEADER} must be base64url JSON")
        try:
            samples = audio.decode_pcm16(body)
        except ValueError as e:
            return self._error(400, "audio", str(e))
        result = self.server.session.take(meta, samples)
        note = f" ({', '.join(result['problems'])})" if result["problems"] else ""
        what = "saved" if result["saved"] else "not saved"
        redo = " (redo)" if result.get("replaced") else ""
        print(f"{meta.get('prompt')} {self.server.session.condition.id}: {len(samples) / 16000:.1f} s "
              f"{what}{redo}{note}", flush=True)  # fmt: skip
        return self._json(200, result)

    def _event(self, body: bytes) -> None:
        ev = self._json_body(body)
        if ev is None:
            return
        self.server.session.event(ev)
        if ev.get("type") == "bye":
            self.server.link = {"status": "gone", "detail": ""}
        return self._json(200, {})


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


def progress_table(progress: dict) -> str:
    lines = [f"{'condition':<15} {'sentences':>14} {'exam':>8}"]
    for c in CONDITIONS:
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
                        help="phone-whisper, phone-normal or mac-normal; without it, the progress is shown")  # fmt: skip
    parser.add_argument("--exam", action="store_true", help="read the exam paragraphs instead of the sentences")
    parser.add_argument("--phone", help="part of the phone's name, when several phones are paired")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"port on {HOST} (default {DEFAULT_PORT}; 0 picks a free one)")  # fmt: skip
    parser.add_argument("--no-browser", action="store_true", help="do not open the page in the browser")
    parser.add_argument("--app-bin", type=Path, help="the WalkieTalkey binary that hands the session to the app")
    parser.add_argument("--app-url-file", type=Path,
                        help="write the app's link (with its token) to this file instead (tests)")  # fmt: skip
    parser.add_argument("--sentences", type=Path, default=SENTENCES_CSV, help="sentence list (id,text,kind)")
    parser.add_argument("--plan", type=Path, default=PLAN_CSV, help="the condition of each sentence")
    parser.add_argument("--exam-file", type=Path, default=EXAM_YAML, help="the exam paragraphs")
    parser.add_argument("--recordings", type=Path, default=RECORDINGS, help="folder for the takes")
    args = parser.parse_args(argv)

    from ..exam import load_exam
    from ..plan import ensure
    from ..sentences import load_sentences

    sentences = load_sentences(args.sentences)
    exam = load_exam(args.exam_file)
    plan, changes = ensure(sentences, args.plan)
    if changes["added"] or changes["removed"]:
        print(f"plan: {changes['added']} sentence(s) added, {changes['removed']} removed ({args.plan})")
    progress = lambda: progress_of(args.recordings, sentences, plan, exam)  # noqa: E731
    if not args.condition:
        print(progress_table(progress()))
        print("\nRecord one condition per session, for example: wt-train record --condition phone-whisper")
        return 0

    c = condition(args.condition)
    if args.exam:
        items, texts = exam, {p.id: p.text for p in exam}
    else:
        items = [s for s in sentences if plan.get(s.id) == c.id]
        texts = {s.id: s.text for s in sentences}
    session = Session(root=args.recordings, condition=c, items=items, texts=texts, exam=args.exam,
                      phone=args.phone)
    token = secrets.token_urlsafe(32)
    try:
        server = make_server(session, token, args.port, progress=progress)
    except OSError as e:
        print(f"cannot listen on {HOST}:{args.port}: {e.strerror}. Is the recorder already running? "
              "Try another --port.", file=sys.stderr)  # fmt: skip
        return 1

    def connect() -> None:
        url = server.app_url()
        if args.app_url_file:
            args.app_url_file.write_text(url + "\n", encoding="utf-8")
            args.app_url_file.chmod(0o600)
            server.link = {"status": "waiting", "detail": "manual"}
            return
        from ..app import handoff_training

        server.link = {"status": "connecting", "detail": ""}
        status, detail = handoff_training(url, args.app_bin)
        server.link = {"status": "waiting" if status == "ok" else status, "detail": detail}
        if status != "ok":
            print(f"WalkieTalkey: {detail}", file=sys.stderr, flush=True)

    server.connect = connect
    page = f"http://{HOST}:{server.server_address[1]}/"
    what = "the exam" if args.exam else "sentences"
    print(f"Recorder: {page}  ({c.id}, {what}: {session.state()['done']} of {len(items)} recorded; "
          f"takes in {args.recordings})")
    print("Ctrl+C stops it.", flush=True)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()
    connect()
    if not args.no_browser:
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
