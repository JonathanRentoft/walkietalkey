"""The recorder's local web server: ``wt-train record``.

It listens on 127.0.0.1 only (there is no option to change that) and serves one
page plus a small API to it:

    GET  /                       the page (static/index.html, app.js, ...)
    GET  /api/state              the sentences, their take status, where to resume
    POST /api/takes/<id>?rate=N  a raw take (float32 mono at N Hz) -> trimmed 16 kHz WAV
    GET  /api/takes/<id>.wav     a saved take, to play it back

Takes are written to training/data/recordings/ (git-ignored) and nowhere else;
the server makes no outbound connections, and the page's Content-Security-Policy
lets it talk to this server only. Requests must name this server as their Host
(no DNS rebinding), and uploads need the page's own header and origin, so
another web page in the same browser cannot write takes.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from ..paths import RECORDINGS, SENTENCES_CSV
from ..sentences import load_sentences
from . import audio
from .takes import Takes, UnknownSentence

HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_TAKE_S = 120
MAX_BODY = MAX_TAKE_S * audio.MAX_RATE * 4
UPLOAD_HEADER = "X-WT-Recorder"

STATIC = Path(__file__).parent / "static"
FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/capture-worklet.js": ("capture-worklet.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "media-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'none'"
)
_TAKE = re.compile(r"/api/takes/([^/]+)")
_TAKE_WAV = re.compile(r"/api/takes/([^/]+)\.wav")


class RecorderServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, takes: Takes, port: int):
        super().__init__((HOST, port), _Handler)
        self.takes = takes
        self.lock = threading.Lock()

    @property
    def origins(self) -> set[str]:
        port = self.server_address[1]
        return {f"{HOST}:{port}", f"localhost:{port}"}


def make_server(takes: Takes, port: int = DEFAULT_PORT) -> RecorderServer:
    """A server for ``takes`` on 127.0.0.1:``port`` (0 picks a free port)."""
    return RecorderServer(takes, port)


class _Handler(BaseHTTPRequestHandler):
    server: RecorderServer
    server_version = "wt-train-recorder"

    def log_message(self, format: str, *args) -> None:
        pass  # one line per saved take is printed instead

    # Guards ---------------------------------------------------------------

    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") in self.server.origins

    def _upload_ok(self) -> bool:
        origin = self.headers.get("Origin")
        same_origin = origin is None or origin in {f"http://{o}" for o in self.server.origins}
        return same_origin and self.headers.get(UPLOAD_HEADER) == "1"

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

    # Routes ---------------------------------------------------------------

    def do_GET(self) -> None:
        if not self._host_ok():
            return self._error(403, "forbidden", "unknown Host")
        path = urlsplit(self.path).path
        if path in FILES:
            name, content_type = FILES[path]
            return self._send(200, (STATIC / name).read_bytes(), content_type)
        if path == "/api/state":
            return self._json(200, self._state())
        m = _TAKE_WAV.fullmatch(path)
        if m:
            try:
                wav = self.server.takes.wav_path(unquote(m.group(1)))
            except UnknownSentence:
                return self._error(404, "unknown", "no such sentence")
            if wav.is_file():
                return self._send(200, wav.read_bytes(), "audio/wav")
        return self._error(404, "not-found", "not found")

    def do_POST(self) -> None:
        # Read the body first (within the cap), so every answer reaches the page cleanly.
        try:
            length = int(self.headers.get("Content-Length", ""))
            if length < 0:
                raise ValueError
        except ValueError:
            self.close_connection = True
            return self._error(411, "length", "Content-Length is required")
        if length > MAX_BODY:
            self.close_connection = True
            return self._error(413, "too-long", f"a take is at most {MAX_TAKE_S} s")
        body = self.rfile.read(length)

        if not self._host_ok() or not self._upload_ok():
            return self._error(403, "forbidden", "uploads come from the recorder page only")
        url = urlsplit(self.path)
        m = _TAKE.fullmatch(url.path)
        takes = self.server.takes
        if not m:
            return self._error(404, "not-found", "not found")
        sentence_id = unquote(m.group(1))
        try:
            takes.sentence(sentence_id)
        except UnknownSentence:
            return self._error(404, "unknown", "no such sentence")
        try:
            rate = int(parse_qs(url.query).get("rate", [""])[0])
            if not audio.MIN_RATE <= rate <= audio.MAX_RATE:
                raise ValueError
        except ValueError:
            return self._error(400, "rate", f"rate must be {audio.MIN_RATE}-{audio.MAX_RATE} Hz")
        if length > MAX_TAKE_S * rate * 4:
            return self._error(413, "too-long", f"a take is at most {MAX_TAKE_S} s")
        try:
            samples = audio.decode_float32(body)
            take = audio.process(samples, rate)
        except audio.SilentTake:
            return self._error(422, "silent", "the take is silent after trimming")
        except ValueError as e:
            return self._error(400, "audio", str(e))
        with self.server.lock:
            replaced = takes.wav_path(sentence_id).exists()
            takes.save(sentence_id, take)
            recorded = takes.recorded_count()
        note = f" ({', '.join(take.warnings)})" if take.warnings else ""
        print(f"{sentence_id}: {take.seconds:.1f} s saved{' (redo)' if replaced else ''}{note}", flush=True)
        self._json(
            200,
            {
                "id": sentence_id,
                "status": takes.status(sentence_id),
                "seconds": round(take.seconds, 3),
                "speech_seconds": round(take.speech_s, 3),
                "peak_dbfs": round(take.peak_dbfs, 1),
                "loudest_dbfs": round(take.loudest_dbfs, 1),
                "clipped": take.clipped,
                "warnings": take.warnings,
                "replaced": replaced,
                "recorded": recorded,
                "total": len(takes.sentences),
            },
        )

    def _state(self) -> dict:
        takes = self.server.takes
        statuses = takes.statuses()
        first = next((i for i, s in enumerate(statuses) if s != "recorded"), None)
        return {
            "total": len(takes.sentences),
            "recorded": statuses.count("recorded"),
            "first_open": first,
            "sentences": [
                {"id": s.id, "text": s.text, "kind": s.kind, "status": status}
                for s, status in zip(takes.sentences, statuses)
            ],
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="wt-train record",
        description=(
            "Read the sentences aloud in the browser, one take per sentence. "
            f"Serves http://{HOST}:<port>/ on this Mac only; takes go to training/data/recordings/."
        ),
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"port on {HOST} (default {DEFAULT_PORT}; 0 picks a free one)")  # fmt: skip
    parser.add_argument("--no-browser", action="store_true", help="do not open the page in the browser")
    parser.add_argument("--sentences", type=Path, default=SENTENCES_CSV, help="sentence list (id,text,kind)")
    parser.add_argument("--recordings", type=Path, default=RECORDINGS, help="folder for the takes")
    args = parser.parse_args(argv)

    takes = Takes(load_sentences(args.sentences), args.recordings)
    try:
        server = make_server(takes, args.port)
    except OSError as e:
        print(f"cannot listen on {HOST}:{args.port}: {e.strerror}. Is the recorder already running? "
              "Try another --port.", file=sys.stderr)  # fmt: skip
        return 1
    url = f"http://{HOST}:{server.server_address[1]}/"
    done, total = takes.recorded_count(), len(takes.sentences)
    print(f"Recorder: {url}  ({done} of {total} recorded; takes in {args.recordings})")
    print("Ctrl+C stops it.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
