"""The recorder's local server: 127.0.0.1 only, the page, the takes API and its guards."""

import json
import threading
import urllib.error
import urllib.request

import numpy as np
import pytest
import soundfile as sf
from fake_audio import take
from wt_train.recorder import main as recorder_main
from wt_train.recorder.server import HOST, STATIC, make_server
from wt_train.recorder.takes import Takes
from wt_train.sentences import Sentence

ROWS = [
    Sentence("s0001", "Vi merger PR'en i dag.", "terms"),
    Sentence("s0002", "Det regner i Aarhus.", "plain"),
]


@pytest.fixture
def server(tmp_path):
    srv = make_server(Takes(ROWS, tmp_path / "recordings"), port=0)
    thread = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def url(srv, path: str) -> str:
    return f"http://{HOST}:{srv.server_address[1]}{path}"


def request(srv, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
    base = {"X-WT-Recorder": "1"} if method == "POST" else {}
    req = urllib.request.Request(url(srv, path), data=body, method=method, headers={**base, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def float32(x: np.ndarray) -> bytes:
    return x.astype("<f4").tobytes()


def speech(rate=48000) -> bytes:
    return float32(take(rate, [("silence", 0.5), ("speech", 1.2), ("silence", 0.5)]))


def test_binds_127_0_0_1_only(server):
    assert HOST == "127.0.0.1"
    assert server.server_address[0] == "127.0.0.1"


def test_there_is_no_option_to_listen_elsewhere(capsys):
    with pytest.raises(SystemExit):
        recorder_main(["--help"])
    out = capsys.readouterr().out
    assert "--host" not in out and "--bind" not in out
    assert "--port" in out and "--no-browser" in out


def test_serves_the_page_and_its_files(server):
    status, headers, body = request(server, "GET", "/")
    assert status == 200 and headers["Content-Type"].startswith("text/html")
    assert b'lang="da"' in body
    for name, kind in [("app.js", "text/javascript"), ("capture-worklet.js", "text/javascript"), ("style.css", "text/css")]:
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
    ["/../pyproject.toml", "/%2e%2e/pyproject.toml", "/static/../../pyproject.toml", "/nope.js", "/api/takes/s0001.txt"],
)
def test_nothing_else_is_served(server, path):
    assert request(server, "GET", path)[0] == 404


def test_state_lists_the_sentences_and_where_to_resume(server):
    status, _, body = request(server, "GET", "/api/state")
    state = json.loads(body)
    assert status == 200
    assert state["total"] == 2 and state["recorded"] == 0 and state["first_open"] == 0
    assert state["sentences"][0] == {"id": "s0001", "text": "Vi merger PR'en i dag.", "kind": "terms", "status": "missing"}


def test_a_take_is_processed_saved_and_played_back(server, tmp_path):
    status, _, body = request(server, "POST", "/api/takes/s0001?rate=48000", speech())
    result = json.loads(body)
    assert status == 200, result
    assert result["id"] == "s0001" and result["status"] == "recorded" and result["replaced"] is False
    assert result["seconds"] == pytest.approx(1.2 + 0.35, abs=0.05)
    wav = tmp_path / "recordings" / "s0001.wav"
    assert sf.info(str(wav)).samplerate == 16000
    state = json.loads(request(server, "GET", "/api/state")[2])
    assert state["recorded"] == 1 and state["first_open"] == 1
    status, headers, audio = request(server, "GET", "/api/takes/s0001.wav")
    assert status == 200 and headers["Content-Type"] == "audio/wav" and audio == wav.read_bytes()
    # A redo replaces it and keeps the old one.
    result = json.loads(request(server, "POST", "/api/takes/s0001?rate=44100", speech(44100))[2])
    assert result["replaced"] is True
    assert len(list((tmp_path / "recordings" / ".replaced").glob("s0001.*.wav"))) == 1


def test_a_silent_take_is_refused_and_nothing_is_saved(server, tmp_path):
    status, _, body = request(server, "POST", "/api/takes/s0001?rate=48000", float32(np.zeros(96000)))
    assert status == 422 and json.loads(body)["error"] == "silent"
    assert not (tmp_path / "recordings" / "s0001.wav").exists()


def test_warnings_come_back_with_the_take(server):
    loud = np.clip(take(48000, [("silence", 0.3), ("speech", 1.0), ("silence", 0.3)], speech_dbfs=-3) * 3, -1, 1)
    result = json.loads(request(server, "POST", "/api/takes/s0002?rate=48000", float32(loud))[2])
    assert result["warnings"] == ["clipping"]


@pytest.mark.parametrize("path", ["/api/takes/s9999?rate=48000", "/api/takes/..%2Fx?rate=48000", "/api/takes/?rate=48000"])
def test_only_ids_from_the_csv(server, path, tmp_path):
    assert request(server, "POST", path, speech())[0] == 404
    assert not (tmp_path / "x.wav").exists()


@pytest.mark.parametrize("query", ["", "?rate=abc", "?rate=1000"])
def test_needs_a_sample_rate(server, query):
    assert request(server, "POST", f"/api/takes/s0001{query}", speech())[0] == 400


def test_refuses_takes_that_are_too_long(server):
    status, _, _ = request(server, "POST", "/api/takes/s0001?rate=48000", b"", {"Content-Length": str(10**9)})
    assert status == 413


@pytest.mark.parametrize(
    "headers",
    [
        {"X-WT-Recorder": ""},  # a plain form post from another page cannot set it
        {"Origin": "https://example.com"},
        {"Host": "evil.example:80"},  # DNS rebinding
    ],
)
def test_requests_from_other_pages_are_refused(server, headers, tmp_path):
    assert request(server, "POST", "/api/takes/s0001?rate=48000", speech(), headers)[0] == 403
    assert not (tmp_path / "recordings" / "s0001.wav").exists()


def test_reads_from_other_hosts_are_refused(server):
    assert request(server, "GET", "/api/state", headers={"Host": "evil.example"})[0] == 403


def test_the_page_may_be_opened_as_localhost(server):
    port = server.server_address[1]
    status, _, _ = request(server, "POST", "/api/takes/s0001?rate=48000", speech(),
                           {"Host": f"localhost:{port}", "Origin": f"http://localhost:{port}"})  # fmt: skip
    assert status == 200
