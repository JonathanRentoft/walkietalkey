"""The WalkieTalkey app's API, ``/app/v1/*``, and the JSON helpers of a server on 127.0.0.1.

Shared by the recorder's server (``wt-train record``, ``wt-train pilot record``) and
Værkstedet's (``wt-train studio``, run 9), so the app talks to both the same way. The
app connects out to the server (it opens no socket of its own) with the link it was
handed, ``http://127.0.0.1:<port>/app/v1#<token>``; every request carries
``Authorization: Bearer <token>``::

    POST /app/v1/hello              the app's version, its paired phones, its input
                                    -> the training session id, device, style, phone
    GET  /app/v1/next?after=N       the commands numbered above N (session.py), waiting
                                    up to 20 s for one
    POST /app/v1/takes              a take: 16 kHz mono PCM16 little-endian in the body,
                                    its metadata as base64url JSON in X-WT-Take
                                    -> saved, check, problems, replaced
    POST /app/v1/events             recording, cancelled, mac_failed, phone, bye, error

A server using :class:`LocalHandler` provides ``origins`` (the Host values it answers
to), ``app_session(authorization, fetching=False)`` (the session that token belongs to,
or None: 401; ``fetching`` for ``next``, which may also reach a session that ended with
commands the app has not fetched yet, run 12) and ``app_link(status, detail)`` (what
the page says about the link). The app's API
refuses any request with an ``Origin``, which a browser sends with every POST and
every cross-origin request, and any Host but the server's own (no DNS rebinding).
"""

from __future__ import annotations

import base64
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

from . import audio
from .session import ARM_MAX_S, AppRefused

# The phone stops at 5 minutes (PHONE-29); a little slack for the pre-roll; and a Mac take
# holds up to a minute armed before the press until it is trimmed (session.py, run 12).
MAX_TAKE_S = 330 + int(ARM_MAX_S)
MAX_BODY = MAX_TAKE_S * audio.TARGET_RATE * 2
MAX_JSON = 64 * 1024
LONG_POLL_S = 20.0
TAKE_HEADER = "X-WT-Take"


class LocalHandler(BaseHTTPRequestHandler):
    """Responses, bodies and the Host guard; the app's API under ``/app/``."""

    # The Content-Security-Policy of every response; a server sets its own.
    csp = "default-src 'none'; frame-ancestors 'none'"

    def log_message(self, format: str, *args) -> None:
        pass  # one line per take is printed instead

    # Guards ---------------------------------------------------------------

    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") in self.server.origins

    # Responses ------------------------------------------------------------

    def _send(self, status: int, body: bytes, content_type: str, *, csp: str | None = None,
              cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", csp or self.csp)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload) -> None:
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
            self._error(413, "too-long", f"a body is at most {limit} bytes (a take at most {MAX_TAKE_S} s)")
            return None
        return self.rfile.read(length)

    def _json_body(self, body: bytes) -> dict | None:
        """A JSON object, or None after answering 400."""
        try:
            value = json.loads(body.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            value = None
        if not isinstance(value, dict):
            self._error(400, "json", "expected a JSON object")
            return None
        return value

    # The app ----------------------------------------------------------------

    def _app_session(self, fetching: bool = False):
        """The session the app's token names, or None after answering 403 or 401."""
        if not self._host_ok() or self.headers.get("Origin") is not None:
            self._error(403, "forbidden", "the app's API is for the WalkieTalkey app only")
            return None
        session = self.server.app_session(self.headers.get("Authorization", ""), fetching=fetching)
        if session is None:
            self._error(401, "forbidden", "the app's API needs the session's token")
        return session

    def app_get(self) -> None:
        """``GET /app/...``."""
        url = urlsplit(self.path)
        session = self._app_session(fetching=url.path == "/app/v1/next")
        if session is None:
            return
        if url.path == "/app/v1/next":
            return self._next(session, parse_qs(url.query))
        return self._error(404, "not-found", "not found")

    def app_post(self) -> None:
        """``POST /app/...``."""
        path = urlsplit(self.path).path
        body = self._body(MAX_BODY if path == "/app/v1/takes" else MAX_JSON)
        if body is None:
            return
        session = self._app_session()
        if session is None:
            return
        if path == "/app/v1/hello":
            return self._hello(session, body)
        if path == "/app/v1/takes":
            return self._take(session, body)
        if path == "/app/v1/events":
            return self._event(session, body)
        return self._error(404, "not-found", "not found")

    def _hello(self, session, body: bytes) -> None:
        info = self._json_body(body)
        if info is None:
            return
        try:
            answer = session.hello(info)
        except AppRefused as e:
            self.server.app_link("no_phone", str(e))
            return self._error(409, "no_phone", str(e))
        self.server.app_link("connected", str(info.get("version") or ""))
        phone = session.phone
        print(f"WalkieTalkey {info.get('version') or ''} connected" + (f"; phone: {phone.get('name')}" if phone else ""),
              flush=True)  # fmt: skip
        return self._json(200, answer)

    def _next(self, session, query: dict) -> None:
        try:
            after = int(query.get("after", ["0"])[0])
            wait = min(25.0, max(0.0, float(query.get("wait", [LONG_POLL_S])[0])))
        except ValueError:
            return self._error(400, "after", "after and wait must be numbers")
        return self._json(200, {"commands": session.next_commands(after, timeout=wait)})

    def _take(self, session, body: bytes) -> None:
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
        result = session.take(meta, samples)
        note = f" ({', '.join(result['problems'])})" if result["problems"] else ""
        what = "saved" if result["saved"] else "not saved"
        redo = " (redo)" if result.get("replaced") else ""
        where = session.setup or session.condition.id
        print(f"{meta.get('prompt')} {where}: {len(samples) / 16000:.1f} s {what}{redo}{note}", flush=True)
        return self._json(200, result)

    def _event(self, session, body: bytes) -> None:
        ev = self._json_body(body)
        if ev is None:
            return
        session.event(ev)
        if ev.get("type") == "bye":
            self.server.app_link("gone", "")
        return self._json(200, {})
