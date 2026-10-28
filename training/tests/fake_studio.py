"""Værkstedet in a test's tmp folder: its files, a stand-in for Edda, a server on a free
port, and the page's and the app's requests. Nothing here touches training/data/, the
journal, the real MLflow store or the WalkieTalkey app: the app's link goes to a file,
the handoff is never called, VS Code is never opened, and Edda is a stand-in."""

from __future__ import annotations

import base64
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

from fake_audio import app_take, pcm16

SENTENCES = [
    ("s0001", "Vi merger PR'en, når buildet er grønt.", "terms", "phone-whisper"),
    ("s0002", "Det regner i Aarhus i dag.", "plain", "phone-whisper"),
    ("s0003", "Kan du deploye til staging?", "terms", "phone-whisper"),
    ("s0004", "Mødet er flyttet til torsdag.", "plain", "mac-normal"),
]
PILOT = [("pilot-01", "Buildet fejler på CI'en i dag.", "terms"),
         ("pilot-02", "Mødet med kunden er flyttet til torsdag.", "plain")]
PHONE = {"id": "cGhvbmUtaWQtMTIzNDU2Nw", "name": "Jonathans iPhone", "platform": "ios", "online": True}
CONFIG = """name: tiny
data:
  validation_fraction: 0.25
  test_fraction: 0.25
  seed: 3
training:
  epochs: 1
"""


def write_places(tmp_path: Path, monkeypatch):
    """Every file Værkstedet reads, in tmp; the work folder and the app's models folder too."""
    from wt_train.studio.places import StudioPaths

    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_APP_MODELS_DIR", str(tmp_path / "app" / "models"))
    data = tmp_path / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "sentences.csv").write_text(
        "id,text,kind\n" + "".join(f'{i},"{t}",{k}\n' for i, t, k, _ in SENTENCES), encoding="utf-8")
    (data / "plan.csv").write_text("id,condition\n" + "".join(f"{i},{c}\n" for i, _, _, c in SENTENCES),
                                   encoding="utf-8")
    (data / "exam.yaml").write_text(
        "paragraphs:\n  - id: e01\n    title: Mandag\n    text: God morgen allesammen, vi starter standuppen nu.\n",
        encoding="utf-8")
    (data / "pilot.csv").write_text("id,text,kind\n" + "".join(f'{i},"{t}",{k}\n' for i, t, k in PILOT),
                                    encoding="utf-8")
    (data / "spelling.yaml").write_text("terms:\n  deploy:\n    forms: [deploye, deployer]\n", encoding="utf-8")
    configs = tmp_path / "configs"
    configs.mkdir(exist_ok=True)
    (configs / "tiny.yaml").write_text(CONFIG, encoding="utf-8")
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True, exist_ok=True)
    (dist / "index.html").write_text('<!doctype html><html lang="da"><div id="root"></div></html>\n',
                                     encoding="utf-8")
    (dist / "assets" / "index-abc123.js").write_text("console.log('page')\n", encoding="utf-8")
    (dist / "assets" / "font.woff2").write_bytes(b"wOF2fake")
    (dist / "favicon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>\n", encoding="utf-8")
    (dist / ".source-hash").write_text("x\n", encoding="utf-8")
    return StudioPaths(recordings=tmp_path / "recordings", pilot=tmp_path / "pilot", sentences=data / "sentences.csv",
                       plan=data / "plan.csv", exam=data / "exam.yaml", pilot_sentences=data / "pilot.csv",
                       spelling=data / "spelling.yaml", configs=configs, journal=tmp_path / "journal", dist=dist,
                       app_bin=tmp_path / "no-app", app_url_file=tmp_path / "app-url")


class StandIn:
    """Base Edda: writes each take's own text, unless ``wrote`` says otherwise (by WAV stem);
    ``errors`` fail one take; ``broken`` fails the whole batch."""

    def __init__(self, wrote=None, errors=None, broken=None):
        self.wrote, self.errors, self.broken = dict(wrote or {}), dict(errors or {}), broken
        self.calls: list[list[Path]] = []

    def transcribe(self, wavs, progress=None):
        self.calls.append([Path(w) for w in wavs])
        if self.broken:
            raise RuntimeError(self.broken)
        out = []
        for w in wavs:
            w = Path(w)
            if w.stem in self.errors:
                out.append(("", self.errors[w.stem]))
            else:
                out.append((self.wrote.get(w.stem, w.with_suffix(".txt").read_text(encoding="utf-8").strip()), None))
        return out


def start_server(places, *, transcriber=None, find_app=None, caffeinate=None, handoff=None, launch=None):
    from wt_train.studio.server import StudioServer

    stand_in = transcriber if transcriber is not None else StandIn()

    def no_handoff(url, app_bin):  # pragma: no cover - the link goes to a file in tests
        raise AssertionError("the tests never hand a session to the app")

    def no_launch(argv):  # pragma: no cover - a test that opens a notebook passes its own
        raise AssertionError(f"the tests never open VS Code: {argv}")

    srv = StudioServer(places, 0, transcriber=lambda: stand_in, handoff=handoff or no_handoff,
                       find_app=find_app or (lambda: None), caffeinate=caffeinate or [],
                       launch=launch or no_launch)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    srv.stand_in = stand_in
    return srv


def stop_server(srv) -> None:
    srv.recorder.shutdown(wait_s=0)
    srv.jobs.stop_all()
    srv.reviewer.stop()
    srv.shutdown()
    srv.server_close()


def request(srv, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
    url = f"http://127.0.0.1:{srv.server_address[1]}{path}"
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def get(srv, path: str, headers: dict | None = None):
    status, _, body = request(srv, "GET", path, headers=headers)
    return status, json.loads(body) if body[:1] in (b"{", b"[") else body


def post(srv, path: str, payload: dict | None = None, headers: dict | None = None):
    status, _, body = request(srv, "POST", path, json.dumps(payload or {}).encode(),
                              {"X-WT-Studio": "1", "Content-Type": "application/json", **(headers or {})})
    return status, json.loads(body)


class App:
    """The WalkieTalkey app, as the spec of the recorder plays it: its link from the file."""

    def __init__(self, srv, places):
        link = Path(places.app_url_file).read_text(encoding="utf-8").strip()
        self.srv, self.token = srv, link.split("#", 1)[1]
        self.after = 0

    def call(self, method, path, body=None, headers=None):
        status, _, raw = request(self.srv, method, path, body,
                                 {"Authorization": f"Bearer {self.token}", **(headers or {})})
        return status, (json.loads(raw) if raw[:1] == b"{" else raw)

    def hello(self, phones=(PHONE,), input_name="MacBook Pro-mikrofon"):
        body = json.dumps({"app": "walkietalkey", "version": "0.3.0", "os": "mac", "phones": list(phones),
                           "input": input_name}).encode()
        return self.call("POST", "/app/v1/hello", body, {"Content-Type": "application/json"})

    def commands(self):
        status, body = self.call("GET", f"/app/v1/next?after={self.after}&wait=0")
        assert status == 200, body
        cmds = body["commands"]
        if cmds:
            self.after = cmds[-1]["seq"]
        return cmds

    def prompt(self):
        prompts = [c for c in self.commands() if c["type"] == "prompt"]
        return prompts[-1] if prompts else None

    def event(self, **ev):
        return self.call("POST", "/app/v1/events", json.dumps(ev).encode(), {"Content-Type": "application/json"})

    def take(self, prompt, samples, source="phone", **meta):
        info = {"prompt": prompt, "source": source, "session": "c2Vzc2lvbi1pZC0xMjM0NQ", "chunks": 12, "missing": 0,
                "microphone": "iPhone-mikrofon" if source == "phone" else None, **meta}
        encoded = base64.urlsafe_b64encode(json.dumps(info).encode()).rstrip(b"=").decode()
        return self.call("POST", "/app/v1/takes", samples.tobytes(),
                         {"Content-Type": "application/octet-stream", "X-WT-Take": encoded})


def good(style="whisper", seconds=2.0):
    return pcm16(app_take([("silence", 0.5), ("speech", seconds), ("silence", 0.4)], style=style))


def silent():
    return pcm16(app_take([("silence", 2.5)], noise_dbfs=-58))
