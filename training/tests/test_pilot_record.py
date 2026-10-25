"""The pilot's recording (run 7): setup names, how a setup records, and a phone and a Mac
setup end to end against the recorder's API, with the takes in ``<pilot>/<setup>/``."""

import base64
import json
import threading
import urllib.error
import urllib.request

import pytest
from fake_audio import app_take, pcm16
from wt_train import pilot
from wt_train.recorder.server import HOST, make_server
from wt_train.recorder.session import Session
from wt_train.recorder.takes import TakeStore
from wt_train.sentences import Sentence

ROWS = [
    Sentence("pilot-01", "Jeg har pushet rettelsen til branchen.", "terms"),
    Sentence("pilot-02", "Mødet er flyttet til torsdag.", "plain"),
]
TOKEN = "dGVzdC10b2tlbi1mb3ItdGhlLXBpbG90LXJlY29yZGVy"
PHONE = {"id": "cGhvbmUtaWQtMTIzNDU2Nw", "name": "Jonathans iPhone", "platform": "ios", "online": True}


@pytest.mark.parametrize("name, device, style, condition", [
    ("iphone-whisper", "phone", "whisper", "phone-whisper"),
    ("iphone-normal", "phone", "normal", "phone-normal"),
    ("phone-whisper", "phone", "whisper", "phone-whisper"),
    ("android-quiet-office", "phone", "normal", "phone-normal"),
    ("mac-normal", "mac", "normal", "mac-normal"),
    ("mac-whisper", "mac", "whisper", "mac-whisper"),
    ("airpods-normal", "mac", "normal", "mac-normal"),
    ("airpods-whisper", "mac", "whisper", "mac-whisper"),
    ("studio", "mac", "normal", "mac-normal"),
    ("rode-podmic-2", "mac", "normal", "mac-normal"),
])
def test_the_setup_name_says_where_and_how_it_records(name, device, style, condition):
    s = pilot.parse_setup(name)
    assert (s.name, s.device, s.style, s.condition.id) == (name, device, style, condition)


@pytest.mark.parametrize("name", ["", "iPhone-whisper", "studio mic", "../recordings", "..", ".replaced",
                                  "sessions.jsonl", "-studio", "studio-", "mac_normal", "x" * 41, "æble", "a/b"])
def test_unsafe_setup_names_are_refused(name):
    with pytest.raises(ValueError, match="lower-case letters, digits and '-'"):
        pilot.parse_setup(name)


def test_a_refusal_suggests_a_safe_name():
    with pytest.raises(ValueError, match="for example iphone-whisper"):
        pilot.parse_setup("iPhone Whisper")


def test_the_take_store_keeps_a_setup_inside_the_pilot_folder(tmp_path):
    store = TakeStore(tmp_path, "mac-normal", {"pilot-01": "Hej."}, setup="studio")
    assert store.folder == tmp_path / "studio" and store.replaced == tmp_path / ".replaced" / "studio"
    for bad in ("../x", "Studio", ".replaced"):
        with pytest.raises(ValueError, match="setup"):
            TakeStore(tmp_path, "mac-normal", {"pilot-01": "Hej."}, setup=bad)
    with pytest.raises(ValueError, match="no exam"):
        TakeStore(tmp_path, "mac-normal", {"pilot-01": "Hej."}, exam=True, setup="studio")


def test_the_cli_refuses_an_unsafe_setup(capsys):
    with pytest.raises(SystemExit):
        pilot.main(["record", "--setup", "../evil"])
    assert "lower-case letters" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        pilot.main(["fly"])


# --- a session end to end against the recorder's API ----------------------------------------


def serve(tmp_path, setup_name: str):
    setup = pilot.parse_setup(setup_name)
    session = Session(root=tmp_path / "pilot", condition=setup.condition, items=ROWS,
                      texts={s.id: s.text for s in ROWS}, setup=setup.name)
    srv = make_server(session, token=TOKEN, port=0, rows=[{"id": setup.name, "label": setup.name,
                                                            "device": setup.device, "style": setup.style}],
                      progress=lambda: {setup.name: {"done": session.state()["done"], "total": len(ROWS)}})
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    return srv


def request(srv, method, path, body=None, headers=None):
    req = urllib.request.Request(f"http://{HOST}:{srv.server_address[1]}{path}", data=body, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def app(srv, method, path, body=None, headers=None):
    return request(srv, method, path, body, {"Authorization": f"Bearer {TOKEN}", **(headers or {})})


def page(srv, method, path):
    return request(srv, method, path, b"" if method == "POST" else None, {"X-WT-Recorder": "1"})


def hello(srv, phones):
    body = json.dumps({"app": "walkietalkey", "version": "0.2.1", "os": "mac", "phones": phones,
                       "input": "AirPods Pro"}).encode()
    return app(srv, "POST", "/app/v1/hello", body, {"Content-Type": "application/json"})


def upload(srv, meta: dict, samples) -> dict:
    encoded = base64.urlsafe_b64encode(json.dumps(meta).encode()).rstrip(b"=").decode()
    status, result = app(srv, "POST", "/app/v1/takes", pcm16(samples).tobytes(),
                         {"Content-Type": "application/octet-stream", "X-WT-Take": encoded})
    assert status == 200
    return result


def test_a_phone_setup_records_on_the_phone_into_its_own_folder(tmp_path):
    srv = serve(tmp_path, "iphone-whisper")
    try:
        status, answer = hello(srv, [PHONE])
        # The app sees an ordinary session: a device and a style, nothing about the pilot.
        assert status == 200 and set(answer) == {"training", "device", "style", "phone"}
        assert (answer["device"], answer["style"], answer["phone"]) == ("phone", "whisper", PHONE["id"])
        state = page(srv, "GET", "/api/state")[1]
        assert state["session"]["pilot"] == {"setup": "iphone-whisper"}
        assert state["session"]["condition"]["id"] == "phone-whisper"
        assert state["conditions"] == [{"id": "iphone-whisper", "label": "iphone-whisper", "device": "phone",
                                        "style": "whisper"}]
        meta = {"prompt": "pilot-01", "source": "phone", "session": "c2Vzc2lvbi1pZC0xMjM0NQ", "chunks": 12,
                "missing": 0, "microphone": "iPhone-mikrofon", "phone": PHONE["id"]}
        take = app_take([("silence", 0.5), ("speech", 2.5), ("silence", 0.4)], style="whisper")
        result = upload(srv, meta, take)
        assert result["saved"] and result["check"] == "ok"
        folder = tmp_path / "pilot" / "iphone-whisper"
        assert sorted(p.name for p in folder.iterdir()) == ["pilot-01.json", "pilot-01.txt", "pilot-01.wav"]
        saved = json.loads((folder / "pilot-01.json").read_text(encoding="utf-8"))
        assert saved["setup"] == "iphone-whisper" and saved["pilot"] is True
        assert (saved["device"], saved["device_class"], saved["style"], saved["microphone"]) == (
            "iphone", "phone", "whisper", "iPhone-mikrofon")
        assert saved["condition"] == "phone-whisper" and saved["text"] == ROWS[0].text
        assert saved["relay"]["chunks"] == 12
        state = page(srv, "GET", "/api/state")[1]
        assert state["progress"]["iphone-whisper"] == {"done": 1, "total": 2}
        # A redo keeps the earlier take aside, in the pilot's own .replaced/.
        page(srv, "POST", "/api/redo")
        assert upload(srv, meta, take)["replaced"] is True
        assert len(list((tmp_path / "pilot" / ".replaced" / "iphone-whisper").glob("pilot-01.*.wav"))) == 1
        srv.session.end()
    finally:
        srv.shutdown()
        srv.server_close()
    events = [json.loads(line) for line in (tmp_path / "pilot" / "sessions.jsonl").read_text().splitlines()]
    assert [(e["event"], e["setup"], e["pilot"]) for e in events] == [("start", "iphone-whisper", True),
                                                                      ("end", "iphone-whisper", True)]
    # Nothing outside the pilot folder.
    assert sorted(p.name for p in tmp_path.iterdir()) == ["pilot"]


def test_a_mac_setup_records_on_the_macs_input_with_the_microphone_named(tmp_path):
    srv = serve(tmp_path, "airpods-normal")
    try:
        status, answer = hello(srv, [])
        assert status == 200 and (answer["device"], answer["style"], answer["phone"]) == ("mac", "normal", None)
        assert page(srv, "POST", "/api/mac/start")[0] == 200
        commands = app(srv, "GET", "/app/v1/next?after=0&wait=0")[1]["commands"]
        assert commands[-1] == {**commands[-1], "type": "mac_start", "prompt": "pilot-01"}
        body = json.dumps({"type": "recording", "prompt": "pilot-01", "source": "mac", "input": "AirPods Pro"})
        app(srv, "POST", "/app/v1/events", body.encode(), {"Content-Type": "application/json"})
        assert page(srv, "POST", "/api/mac/stop")[0] == 200
        take = app_take([("silence", 0.4), ("speech", 2.2), ("silence", 0.4)], style="normal")
        result = upload(srv, {"prompt": "pilot-01", "source": "mac", "missing": 0}, take)
        assert result["saved"]
        saved = json.loads((tmp_path / "pilot" / "airpods-normal" / "pilot-01.json").read_text(encoding="utf-8"))
        assert (saved["setup"], saved["pilot"], saved["device"], saved["style"], saved["microphone"]) == (
            "airpods-normal", True, "mac", "normal", "AirPods Pro")
        assert saved["phone"] is None and "relay" not in saved
        state = page(srv, "GET", "/api/state")[1]
        assert state["session"]["pilot"] == {"setup": "airpods-normal"} and state["session"]["index"] == 1
    finally:
        srv.shutdown()
        srv.server_close()


def test_a_whispered_mac_setup_uses_the_whisper_limits(tmp_path):
    srv = serve(tmp_path, "mac-whisper")
    try:
        hello(srv, [])
        page(srv, "POST", "/api/mac/start")
        page(srv, "POST", "/api/mac/stop")
        # Whispered at -42 dBFS: quiet for a normal voice, fine for a whisper.
        take = app_take([("silence", 0.4), ("speech", 2.2), ("silence", 0.4)], style="whisper", level_dbfs=-42)
        result = upload(srv, {"prompt": "pilot-01", "source": "mac", "missing": 0}, take)
        assert result["saved"] and result["check"] == "ok"
        saved = json.loads((tmp_path / "pilot" / "mac-whisper" / "pilot-01.json").read_text(encoding="utf-8"))
        assert (saved["condition"], saved["style"], saved["device"]) == ("mac-whisper", "whisper", "mac")
    finally:
        srv.shutdown()
        srv.server_close()


def test_known_setups_come_from_the_folders_and_the_session_log(tmp_path):
    root = tmp_path / "pilot"
    (root / "studio").mkdir(parents=True)
    (root / ".replaced" / "old").mkdir(parents=True)
    (root / "sessions.jsonl").write_text(
        json.dumps({"event": "start", "setup": "iphone-whisper", "pilot": True}) + "\nnot json\n"
        + json.dumps({"event": "start", "setup": "../evil"}) + "\n", encoding="utf-8")
    assert pilot.known_setups(root) == ["iphone-whisper", "studio"]
    assert pilot.known_setups(tmp_path / "none") == []


def test_wt_train_pilot_record_serves_the_pilot(tmp_path, monkeypatch):
    csv_path = tmp_path / "pilot.csv"
    csv_path.write_text("id,text,kind\n" + "".join(f'{s.id},"{s.text}",{s.kind}\n' for s in ROWS), encoding="utf-8")
    seen = {}

    def fake_serve(session, **kw):
        seen.update(session=session, **kw)
        return 0

    monkeypatch.setattr("wt_train.recorder.server.serve", fake_serve)
    root = tmp_path / "pilot"
    (root / "studio").mkdir(parents=True)
    assert pilot.main(["record", "--setup", "iphone-normal", "--sentences", str(csv_path), "--pilot-dir", str(root),
                       "--no-browser", "--port", "0"]) == 0
    session = seen["session"]
    assert session.setup == "iphone-normal" and session.condition.id == "phone-normal"
    assert [i.id for i in session.items] == ["pilot-01", "pilot-02"]
    assert [r["id"] for r in seen["rows"]] == ["iphone-normal", "studio"]
    assert seen["progress"]() == {"iphone-normal": {"done": 0, "total": 2}, "studio": {"done": 0, "total": 2}}
    assert "pilot iphone-normal" in seen["describe"]


def test_an_ordinary_session_is_unchanged(tmp_path):
    from wt_train.conditions import condition

    s = Session(root=tmp_path / "recordings", condition=condition("mac-normal"), items=ROWS,
                texts={r.id: r.text for r in ROWS})
    s.hello({"phones": [], "input": "MacBook Pro-mikrofon"})
    s.mac_start()
    take = pcm16(app_take([("silence", 0.4), ("speech", 2.2), ("silence", 0.4)], style="normal"))
    assert s.take({"prompt": "pilot-01", "source": "mac", "missing": 0}, take)["saved"]
    meta = json.loads((tmp_path / "recordings" / "mac-normal" / "pilot-01.json").read_text())
    assert "setup" not in meta and "pilot" not in meta
    assert s.state()["pilot"] is None
    start = json.loads((tmp_path / "recordings" / "sessions.jsonl").read_text().splitlines()[0])
    assert "setup" not in start and "pilot" not in start
