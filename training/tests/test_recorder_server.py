"""The recorder's local server: 127.0.0.1 only, the page and its API, and the app's API behind a
per-session token."""

import base64
import json
import threading
import time
import urllib.error
import urllib.request

import pytest
from fake_audio import app_take, pcm16
from wt_train.conditions import condition
from wt_train.recorder import main as recorder_main
from wt_train.recorder.server import HOST, STATIC, make_server
from wt_train.recorder.session import POST_ROLL_S, Session
from wt_train.sentences import Sentence

ROWS = [
    Sentence("s0001", "Vi merger PR'en i dag.", "terms"),
    Sentence("s0002", "Det regner i Aarhus.", "plain"),
]
TOKEN = "dGVzdC10b2tlbi1mb3ItdGhlLXJlY29yZGVyLWFwcA"
PHONE = {"id": "cGhvbmUtaWQtMTIzNDU2Nw", "name": "Jonathans iPhone", "platform": "ios", "online": True}


def make(tmp_path, cid="phone-whisper"):
    texts = {s.id: s.text for s in ROWS}
    session = Session(root=tmp_path / "recordings", condition=condition(cid), items=ROWS, texts=texts)
    return make_server(session, token=TOKEN, port=0)


@pytest.fixture
def server(tmp_path):
    srv = make(tmp_path)
    thread = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def url(srv, path: str) -> str:
    return f"http://{HOST}:{srv.server_address[1]}{path}"


def request(srv, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url(srv, path), data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def page(srv, method, path, body=b"", headers=None):
    return request(srv, method, path, body if method == "POST" else None, {"X-WT-Recorder": "1", **(headers or {})})


def app(srv, method, path, body=None, headers=None):
    return request(srv, method, path, body, {"Authorization": f"Bearer {TOKEN}", **(headers or {})})


def hello(srv, phones=(PHONE,)):
    body = json.dumps({"app": "walkietalkey", "version": "0.3.0", "os": "mac", "phones": list(phones),
                       "input": "MacBook Pro-mikrofon"}).encode()
    return app(srv, "POST", "/app/v1/hello", body, {"Content-Type": "application/json"})


def take_headers(meta: dict) -> dict:
    encoded = base64.urlsafe_b64encode(json.dumps(meta).encode()).rstrip(b"=").decode()
    return {"Content-Type": "application/octet-stream", "X-WT-Take": encoded}


def good() -> bytes:
    return pcm16(app_take([("silence", 0.5), ("speech", 2.0), ("silence", 0.4)], style="whisper")).tobytes()


def test_binds_127_0_0_1_only(server):
    assert HOST == "127.0.0.1"
    assert server.server_address[0] == "127.0.0.1"


def test_there_is_no_option_to_listen_elsewhere(capsys):
    with pytest.raises(SystemExit):
        recorder_main(["--help"])
    out = capsys.readouterr().out
    assert "--host" not in out and "--bind" not in out
    assert "--port" in out and "--no-browser" in out and "--condition" in out


def test_serves_the_page_and_its_files(server):
    status, headers, body = request(server, "GET", "/")
    assert status == 200 and headers["Content-Type"].startswith("text/html")
    assert b'lang="da"' in body
    for name, kind in [("app.js", "text/javascript"), ("style.css", "text/css")]:
        status, headers, _ = request(server, "GET", f"/{name}")
        assert status == 200 and headers["Content-Type"].startswith(kind), name


def test_the_page_can_only_talk_to_this_server(server):
    csp = request(server, "GET", "/")[1]["Content-Security-Policy"]
    assert "default-src 'none'" in csp and "connect-src 'self'" in csp and "script-src 'self'" in csp
    for path in STATIC.iterdir():
        text = path.read_text(encoding="utf-8")
        assert "http://" not in text and "https://" not in text and "//cdn" not in text, path.name


@pytest.mark.parametrize(
    "path",
    ["/../pyproject.toml", "/%2e%2e/pyproject.toml", "/static/../../pyproject.toml", "/nope.js",
     "/api/takes/s0001.txt", "/api/takes/s0001.json", "/app/v1/nope"],
)
def test_nothing_else_is_served(server, path):
    assert request(server, "GET", path, headers={"Authorization": f"Bearer {TOKEN}"})[0] == 404


def test_the_app_api_needs_the_token(server):
    assert request(server, "POST", "/app/v1/hello", b"{}")[0] == 401
    assert request(server, "POST", "/app/v1/hello", b"{}", {"Authorization": "Bearer nope"})[0] == 401
    assert request(server, "GET", "/app/v1/next?after=0", headers={"Authorization": f"Bearer {TOKEN}x"})[0] == 401


def test_browsers_cannot_use_the_app_api(server):
    # A web page in the browser always sends an Origin; the app never does.
    status, _, _ = app(server, "POST", "/app/v1/hello", b"{}", {"Origin": f"http://127.0.0.1:{server.server_address[1]}"})
    assert status == 403
    assert app(server, "POST", "/app/v1/hello", b"{}", {"Host": "evil.example"})[0] == 403


def test_hello_then_the_first_prompt(server):
    status, _, body = hello(server)
    answer = json.loads(body)
    assert status == 200 and answer["device"] == "phone" and answer["phone"] == PHONE["id"]
    status, _, body = app(server, "GET", "/app/v1/next?after=0&wait=0")
    cmds = json.loads(body)["commands"]
    assert cmds[0]["type"] == "prompt" and cmds[0]["next"]["prompt"] == "s0001"


def test_no_phone_is_a_clear_refusal(server):
    status, _, body = hello(server, phones=())
    assert status == 409 and json.loads(body)["error"] == "no_phone"


def test_a_take_is_checked_saved_and_played_back(server, tmp_path):
    hello(server)
    meta = {"prompt": "s0001", "source": "phone", "session": "c2Vzc2lvbi1pZC0xMjM0NQ", "chunks": 12,
            "missing": 0, "microphone": "iPhone-mikrofon", "phone": PHONE["id"]}
    status, _, body = app(server, "POST", "/app/v1/takes", good(), take_headers(meta))
    result = json.loads(body)
    assert status == 200 and result["saved"] and result["check"] == "ok"
    wav = tmp_path / "recordings" / "phone-whisper" / "s0001.wav"
    assert wav.is_file()
    state = json.loads(page(server, "GET", "/api/state")[2])
    assert state["session"]["done"] == 1 and state["session"]["index"] == 1
    status, headers, audio = request(server, "GET", "/api/takes/s0001.wav")
    assert status == 200 and headers["Content-Type"] == "audio/wav" and audio == wav.read_bytes()


def test_a_take_needs_its_metadata_and_whole_samples(server):
    hello(server)
    assert app(server, "POST", "/app/v1/takes", good(), {"Content-Type": "application/octet-stream"})[0] == 400
    meta = take_headers({"prompt": "s0001", "source": "phone"})
    assert app(server, "POST", "/app/v1/takes", good() + b"x", meta)[0] == 400


def test_refuses_takes_that_are_too_long(server):
    hello(server)
    headers = {**take_headers({"prompt": "s0001", "source": "phone"}), "Content-Length": str(10**9)}
    assert app(server, "POST", "/app/v1/takes", b"", headers)[0] == 413


def test_the_long_poll_returns_when_the_page_moves(server):
    hello(server)
    seq = json.loads(app(server, "GET", "/app/v1/next?after=0&wait=0")[2])["commands"][-1]["seq"]
    got = {}
    t = threading.Thread(target=lambda: got.update(json.loads(app(server, "GET", f"/app/v1/next?after={seq}")[2])))
    t.start()
    assert page(server, "POST", "/api/next")[0] == 200
    t.join(5)
    assert got["commands"][0]["next"]["prompt"] == "s0002"


def test_events_reach_the_page(server):
    hello(server)
    body = json.dumps({"type": "phone", "id": PHONE["id"], "online": False}).encode()
    assert app(server, "POST", "/app/v1/events", body, {"Content-Type": "application/json"})[0] == 200
    state = json.loads(page(server, "GET", "/api/state")[2])
    assert state["session"]["phone"]["online"] is False


@pytest.mark.parametrize(
    "headers",
    [
        {"X-WT-Recorder": ""},  # a plain form post from another page cannot set it
        {"Origin": "https://example.com"},
        {"Host": "evil.example:80"},  # DNS rebinding
    ],
)
def test_page_posts_from_other_pages_are_refused(server, headers):
    hello(server)
    assert page(server, "POST", "/api/next", b"", headers)[0] == 403


def test_reads_from_other_hosts_are_refused(server):
    assert request(server, "GET", "/api/state", headers={"Host": "evil.example"})[0] == 403


def test_the_page_may_be_opened_as_localhost(server):
    port = server.server_address[1]
    status, _, _ = page(server, "POST", "/api/next", b"",
                        {"Host": f"localhost:{port}", "Origin": f"http://localhost:{port}"})  # fmt: skip
    assert status == 200


def test_the_page_starts_and_stops_a_mac_take(tmp_path):
    srv = make(tmp_path, "mac-normal")
    thread = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    try:
        hello(srv, phones=())
        # Run 12: connected and idle, the session arms the Mac's input; the page shows it ready.
        cmds = json.loads(app(srv, "GET", "/app/v1/next?after=0&wait=0")[2])["commands"]
        assert cmds[-1]["type"] == "mac_start" and cmds[-1]["prompt"] == "s0001"
        assert json.loads(page(srv, "GET", "/api/state")[2])["session"]["recording"] is None
        event = json.dumps({"type": "recording", "prompt": "s0001", "source": "mac"}).encode()
        app(srv, "POST", "/app/v1/events", event, {"Content-Type": "application/json"})
        # The press only notes the time: the app records already.
        status, _, body = page(srv, "POST", "/api/mac/start")
        assert status == 200 and json.loads(body)["session"]["recording"]["prompt"] == "s0001"
        assert json.loads(app(srv, "GET", f"/app/v1/next?after={cmds[-1]['seq']}&wait=0")[2])["commands"] == []
        # The release: "Gemmer ..." at once, mac_stop half a second later (the long poll wakes for it).
        status, _, body = page(srv, "POST", "/api/mac/stop")
        assert status == 200 and json.loads(body)["session"]["recording"]["stopping"]
        t0 = time.monotonic()
        stop = json.loads(app(srv, "GET", f"/app/v1/next?after={cmds[-1]['seq']}&wait=3")[2])["commands"]
        assert [c["type"] for c in stop] == ["mac_stop"]
        assert time.monotonic() - t0 >= POST_ROLL_S - 0.05
    finally:
        srv.shutdown()
        srv.server_close()


def test_a_terminal_closed_or_a_kill_still_ends_the_session(tmp_path):
    # Run 12: the Mac's input is armed while the recorder runs, so it must reach the app's cancel
    # on its way out; SIGTERM and SIGHUP (the terminal window closed) end it as Ctrl+C does.
    import os
    import signal

    from wt_train.recorder.server import stop_on_signals

    before = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGHUP)}
    try:
        stop_on_signals()
        for sig in before:
            with pytest.raises(KeyboardInterrupt):
                os.kill(os.getpid(), sig)
                time.sleep(1)
    finally:
        for sig, handler in before.items():
            signal.signal(sig, handler)
