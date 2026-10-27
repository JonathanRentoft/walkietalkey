"""Værkstedet's recording screen (run 9): a pick, its live session through the app's API, every
take checked (audio, then what Edda heard), the queue coming back to takes sent back,
"Spring over", "Tag om", "Godkend alligevel", pause, resume and stop, and the rows the same
after a restart."""

import json
import threading
import time

import pytest

from fake_studio import PHONE, App, StandIn, get, good, post, request, silent, start_server, stop_server, write_places


@pytest.fixture
def places(tmp_path, monkeypatch):
    return write_places(tmp_path, monkeypatch)


@pytest.fixture
def server(places):
    srv = start_server(places)
    yield srv
    stop_server(srv)


def state(srv):
    status, body = get(srv, "/api/recording/state")
    assert status == 200
    return body


def rows(srv):
    return {r["id"]: r for r in state(srv)["rows"]}


def settle(srv):
    assert srv.reviewer.idle(10)
    return state(srv)


def start_phone(srv, places, cid="phone-whisper"):
    status, body = post(srv, "/api/recording/start", {"kind": "condition", "id": cid, "exam": False})
    assert status == 200, body
    app = App(srv, places)
    assert app.hello()[0] == 200
    return app


def test_a_pick_starts_a_session_the_app_connects_to(server, places):
    status, st = post(server, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
    assert status == 200
    assert st["active"] and not st["paused"]
    assert st["pick"] == {"kind": "condition", "id": "phone-whisper", "label": "Telefonen, hvisket",
                          "device": "phone", "style": "whisper", "exam": False}
    assert [r["id"] for r in st["rows"]] == ["s0001", "s0002", "s0003"]
    assert st["counts"] == {"total": 3, "waiting": 3, "recording": 0, "received": 0, "approved": 0, "redo": 0}
    assert st["link"]["status"] == "waiting" and st["current"] == "s0001"
    assert st["limits"]["quiet_dbfs"] == -50.0 and st["limits"]["loud_dbfs"] == -25.0
    assert st["limits"]["good_dbfs"] == [-45.0, -31.0]
    app = App(server, places)
    assert app.hello()[0] == 200
    st = state(server)
    assert st["link"]["status"] == "connected" and st["app"]["connected"] and st["app"]["version"] == "0.3.0"
    assert st["phone"] == {"name": "Jonathans iPhone", "platform": "ios", "online": True}
    p = app.prompt()
    assert p["next"] == {"prompt": "s0001", "text": "Vi merger PR'en, når buildet er grønt."}
    assert (p["done"], p["total"]) == (0, 3)


def test_the_page_never_sees_the_token(server, places):
    _, st = post(server, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
    token = App(server, places).token
    assert token not in json.dumps(st) and token not in json.dumps(state(server))


def test_a_take_is_received_then_checked_and_approved(server, places):
    app = start_phone(server, places)
    app.event(type="recording", prompt="s0001", source="phone")
    row = rows(server)["s0001"]
    assert row["status"] == "recording" and state(server)["recording"]["prompt"] == "s0001"
    status, result = app.take("s0001", good())
    assert status == 200 and result["saved"]
    st = settle(server)
    row = {r["id"]: r for r in st["rows"]}["s0001"]
    assert row["status"] == "approved"
    take = row["take"]
    assert take["url"] == "/api/takes/phone-whisper/s0001.wav" and take["n"] == 1
    assert take["microphone"] == "iPhone-mikrofon" and take["seconds"] == pytest.approx(2.9, abs=0.05)
    assert len(take["envelope"]) == 48 and all(isinstance(v, float) for v in take["envelope"])
    assert -50 < take["level_dbfs"] < -30 and take["snr_db"] > 10
    assert take["heard"] == "Vi merger PR'en, når buildet er grønt." and take["wer"] == 0.0
    assert all(op["op"] == "eq" for op in take["diff"]) and take["diff"][0] == {"op": "eq", "ref": "vi", "hyp": "vi"}
    assert take["review"] == {"status": "approved", "by": "check"} and not take["transcribing"]
    assert take["edda_error"] is None and take["problems"] == []
    assert st["counts"]["approved"] == 1 and st["current"] == "s0002"
    assert st["microphone"] == {"name": "iPhone-mikrofon", "source": "phone"}
    assert st["minutes"] == pytest.approx(round(2.9 / 60, 1))
    # The review is in the take's metadata.
    meta = json.loads((places.recordings / "phone-whisper" / "s0001.json").read_text(encoding="utf-8"))
    assert meta["review"]["status"] == "approved" and meta["review"]["by"] == "check"
    assert meta["review"]["heard"] == take["heard"] and len(meta["review"]["envelope"]) == 48
    # The take plays back.
    status, headers, audio = request(server, "GET", take["url"])
    assert status == 200 and headers["Content-Type"] == "audio/wav"
    assert audio == (places.recordings / "phone-whisper" / "s0001.wav").read_bytes()
    # The phone's count: received plus approved.
    assert app.prompt()["done"] == 1


def test_every_waiting_take_goes_to_edda_in_one_batch(places):
    stand_in = StandIn()
    gate = threading.Event()
    original = stand_in.transcribe

    def slow(wavs, progress=None):
        gate.wait(5)
        return original(wavs, progress)

    stand_in.transcribe = slow
    srv = start_server(places, transcriber=stand_in)
    try:
        app = start_phone(srv, places)
        app.take("s0001", good())
        time.sleep(0.3)  # the first batch is being heard
        app.take("s0002", good())
        app.take("s0003", good())
        assert rows(srv)["s0003"]["status"] == "received" and rows(srv)["s0003"]["take"]["transcribing"]
        gate.set()
        settle(srv)
        assert [len(c) for c in stand_in.calls] == [1, 2]
        assert all(r["status"] == "approved" for r in state(srv)["rows"])
    finally:
        gate.set()
        stop_server(srv)


def test_a_take_edda_heard_as_another_sentence_goes_back_and_comes_up_again(places):
    srv = start_server(places, transcriber=StandIn(wrote={"s0001": "Hund"}))
    try:
        app = start_phone(srv, places)
        app.take("s0001", good())
        st = settle(srv)
        row = {r["id"]: r for r in st["rows"]}["s0001"]
        assert row["status"] == "redo" and row["take"]["review"] == {"status": "redo", "by": "check"}
        assert [p["kind"] for p in row["take"]["problems"]] == ["mismatch"]
        assert row["take"]["heard"] == "Hund" and row["take"]["wer"] > 0.5
        assert any(op["op"] != "eq" for op in row["take"]["diff"])
        assert st["current"] == "s0002", "the queue moves on; the take comes up when it wraps round"
        app.take("s0002", good())
        app.take("s0003", good())
        assert app.prompt()["next"]["prompt"] == "s0001"
        assert state(srv)["current"] == "s0001"
    finally:
        stop_server(srv)


def test_audio_problems_send_a_take_back_and_warnings_do_not(places):
    srv = start_server(places)
    try:
        status, _ = post(srv, "/api/recording/start", {"kind": "condition", "id": "mac-normal"})
        app = App(srv, places)
        app.hello(phones=())
        # A whisper read in the normal voice condition: too quiet.
        app.take("s0004", good(style="whisper"), source="mac", input="MacBook Pro-mikrofon")
        row = {r["id"]: r for r in settle(srv)["rows"]}["s0004"]
        assert row["status"] == "redo" and "quiet" in [p["kind"] for p in row["take"]["problems"]]
        assert state(srv)["microphone"] == {"name": "MacBook Pro-mikrofon", "source": "mac"}
    finally:
        stop_server(srv)


def test_without_edda_the_audio_alone_decides_and_the_row_says_why(places):
    def missing():
        raise FileNotFoundError("no WalkieTalkey binary found; build the app or pass --app-bin")

    from wt_train.studio.server import StudioServer

    srv = StudioServer(places, 0, transcriber=missing, find_app=lambda: None)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    try:
        app = start_phone(srv, places)
        app.take("s0001", good())
        take = {r["id"]: r for r in settle(srv)["rows"]}["s0001"]["take"]
        assert take["review"]["status"] == "approved" and take["heard"] is None and take["diff"] is None
        assert "no WalkieTalkey binary" in take["edda_error"]
    finally:
        stop_server(srv)


def test_a_silent_take_is_refused_and_the_sentence_stays(server, places):
    app = start_phone(server, places)
    status, result = app.take("s0001", silent())
    assert status == 200 and not result["saved"] and result["check"] == "silent"
    st = settle(server)
    assert st["current"] == "s0001" and st["rows"][0]["status"] == "waiting" and st["rows"][0]["take"] is None
    assert st["last"]["check"] == "silent" and st["last"]["saved"] is False


def test_spring_over_from_the_page_and_from_the_phone(server, places):
    app = start_phone(server, places)
    status, st = post(server, "/api/recording/skip")
    assert status == 200 and st["current"] == "s0002"
    assert {r["id"]: r for r in st["rows"]}["s0001"]["skipped"] is True
    assert app.prompt()["next"]["prompt"] == "s0002"
    # The phone's own: a take of "skip:<prompt>", cancelled at once; never a take or recording.
    app.event(type="recording", prompt="skip:s0002", source="phone")
    assert state(server)["recording"] is None
    app.event(type="cancelled", prompt="skip:s0002", source="phone")
    st = state(server)
    assert st["current"] == "s0003" and all(r["status"] == "waiting" for r in st["rows"])
    assert app.prompt()["next"]["prompt"] == "s0003"
    app.take("s0003", good())
    assert app.prompt()["next"]["prompt"] == "s0001", "a new round: the skipped come back"


def test_no_skip_or_go_while_a_take_is_recording(server, places):
    app = start_phone(server, places)
    app.event(type="recording", prompt="s0001", source="phone")
    assert post(server, "/api/recording/skip")[1]["error"] == "busy"
    assert post(server, "/api/recording/go", {"id": "s0002"})[0] == 409


def test_go_makes_a_sentence_the_current_one(server, places):
    app = start_phone(server, places)
    status, st = post(server, "/api/recording/go", {"id": "s0003"})
    assert status == 200 and st["current"] == "s0003"
    assert app.prompt()["next"]["prompt"] == "s0003"
    assert post(server, "/api/recording/go", {"id": "s9999"})[1]["error"] == "unknown"


def test_tag_om_sends_a_take_back_and_makes_it_current(server, places):
    app = start_phone(server, places)
    app.take("s0001", good())
    settle(server)
    status, st = post(server, "/api/recording/redo", {"id": "s0001"})
    assert status == 200 and st["current"] == "s0001"
    row = {r["id"]: r for r in st["rows"]}["s0001"]
    assert row["status"] == "redo" and row["take"]["review"] == {"status": "redo", "by": "owner"}
    assert row["take"]["heard"], "the check's numbers stay"
    assert app.prompt()["next"]["prompt"] == "s0001"
    meta = json.loads((places.recordings / "phone-whisper" / "s0001.json").read_text(encoding="utf-8"))
    assert meta["review"]["status"] == "redo" and meta["review"]["by"] == "owner"
    assert post(server, "/api/recording/redo", {"id": "s0002"})[1]["error"] == "unknown"
    # The new take replaces it, the old one kept aside, and is checked afresh.
    app.take("s0001", good())
    row = {r["id"]: r for r in settle(server)["rows"]}["s0001"]
    assert row["status"] == "approved" and row["take"]["n"] == 2
    assert len(list((places.recordings / ".replaced" / "phone-whisper").glob("s0001.*.wav"))) == 1


def test_godkend_alligevel_keeps_a_take_the_check_sent_back(places):
    srv = start_server(places, transcriber=StandIn(wrote={"s0001": "Hund"}))
    try:
        app = start_phone(srv, places)
        app.take("s0001", good())
        settle(srv)
        assert rows(srv)["s0001"]["status"] == "redo"
        status, st = post(srv, "/api/recording/approve", {"id": "s0001"})
        row = {r["id"]: r for r in st["rows"]}["s0001"]
        assert row["status"] == "approved" and row["take"]["review"] == {"status": "approved", "by": "owner"}
        app.take("s0002", good())
        app.take("s0003", good())
        settle(srv)
        assert app.prompt()["next"] is None, "it left the queue"
    finally:
        stop_server(srv)


def test_the_owners_verdict_is_never_overwritten_by_the_check(places):
    gate = threading.Event()
    stand_in = StandIn(wrote={"s0001": "Hund"})
    original = stand_in.transcribe
    stand_in.transcribe = lambda wavs, progress=None: (gate.wait(5), original(wavs))[1]
    srv = start_server(places, transcriber=stand_in)
    try:
        app = start_phone(srv, places)
        app.take("s0001", good())
        assert post(srv, "/api/recording/approve", {"id": "s0001"})[0] == 200
        gate.set()
        row = {r["id"]: r for r in settle(srv)["rows"]}["s0001"]
        assert row["status"] == "approved" and row["take"]["review"]["by"] == "owner"
        assert row["take"]["heard"] == "Hund", "the check still adds what Edda heard"
    finally:
        gate.set()
        stop_server(srv)


def test_pause_ends_the_session_and_resume_starts_a_new_one_where_it_was(server, places):
    app = start_phone(server, places)
    app.take("s0001", good())
    post(server, "/api/recording/skip")  # s0002 skipped, s0003 current
    status, st = post(server, "/api/recording/pause")
    assert status == 200 and st["paused"] and not st["active"] and st["pick"]["id"] == "phone-whisper"
    assert app.commands()[-1]["type"] == "end"
    # Nothing can be recorded while paused.
    assert app.take("s0003", good())[1]["saved"] is False
    assert post(server, "/api/recording/mac/start")[1]["error"] == "paused"
    old = app.token
    status, st = post(server, "/api/recording/resume")
    assert status == 200 and st["active"] and st["current"] == "s0003"
    assert {r["id"]: r for r in st["rows"]}["s0002"]["skipped"]
    assert app.call("GET", "/app/v1/next?after=0&wait=0")[0] == 401, "the old token is refused"
    again = App(server, places)
    assert again.token != old and again.hello()[0] == 200
    assert again.prompt()["next"]["prompt"] == "s0003"


def test_stop_forgets_the_pick(server, places):
    app = start_phone(server, places)
    status, st = post(server, "/api/recording/stop")
    assert status == 200 and st["pick"] is None and not st["active"] and not st["paused"] and st["rows"] == []
    assert app.commands()[-1]["type"] == "end"
    assert post(server, "/api/recording/resume")[1]["error"] == "no-pick"


def test_a_new_pick_replaces_the_running_session(server, places):
    app = start_phone(server, places)
    status, st = post(server, "/api/recording/start", {"kind": "pilot", "id": "iphone-normal"})
    assert status == 200 and st["pick"]["label"] == "iPhone, almindelig stemme"
    # The old session's token is refused at once: the app ends that session (the new handoff
    # replaces it too), and the phone returns to normal.
    assert app.call("GET", "/app/v1/next?after=0&wait=0")[0] == 401
    assert App(server, places).token != app.token


def test_the_rows_are_the_same_after_a_restart_and_unchecked_takes_are_checked(places):
    srv = start_server(places)
    try:
        app = start_phone(srv, places)
        app.take("s0001", good())
        settle(srv)
        post(srv, "/api/recording/redo", {"id": "s0002"})  # no take: unknown
        post(srv, "/api/recording/redo", {"id": "s0001"})
    finally:
        stop_server(srv)
    # A take recorded with wt-train record (no review yet).
    from wt_train.conditions import condition
    from wt_train.recorder.session import Session
    from wt_train.sentences import load_sentences

    sentences = [s for s in load_sentences(places.sentences) if s.id in ("s0002",)]
    s = Session(root=places.recordings, condition=condition("phone-whisper"), items=sentences,
                texts={x.id: x.text for x in sentences})
    s.hello({"version": "0.3.0", "phones": [PHONE]})
    s.take({"prompt": "s0002", "source": "phone", "microphone": "iPhone-mikrofon"}, good())
    stand_in = StandIn()
    again = start_server(places, transcriber=stand_in)
    try:
        post(again, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
        st = settle(again)
        by_id = {r["id"]: r for r in st["rows"]}
        assert by_id["s0001"]["status"] == "redo" and by_id["s0001"]["take"]["review"]["by"] == "owner"
        assert by_id["s0001"]["take"]["level_dbfs"] is not None and len(by_id["s0001"]["take"]["envelope"]) == 48
        assert by_id["s0001"]["take"]["diff"], "the diff comes back from what Edda heard"
        assert by_id["s0002"]["status"] == "approved"
        assert [p.stem for call in stand_in.calls for p in call] == ["s0002"], "only the unchecked take"
        assert st["current"] == "s0001", "the take sent back is the first open one"
    finally:
        stop_server(again)


def test_the_long_poll_answers_when_something_changes(server, places):
    app = start_phone(server, places)
    version = state(server)["version"]
    status, same = get(server, f"/api/recording/state?since={version - 1}")
    assert same["version"] == version, "a newer version answers at once"
    got = {}

    def poll():
        got.update(get(server, f"/api/recording/state?since={version}")[1])

    t = threading.Thread(target=poll)
    started = time.monotonic()
    t.start()
    time.sleep(0.2)
    app.event(type="recording", prompt="s0001", source="phone")
    t.join(10)
    assert got["version"] > version and got["recording"]["prompt"] == "s0001"
    assert time.monotonic() - started < 5
    assert get(server, "/api/recording/state?since=x")[0] == 400


def test_a_phone_session_needs_a_paired_phone(server, places):
    post(server, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
    app = App(server, places)
    status, body = app.hello(phones=())
    assert status == 409 and body["error"] == "no_phone"
    assert state(server)["link"]["status"] == "no_phone"


def test_mac_takes_from_the_page(server, places):
    post(server, "/api/recording/start", {"kind": "condition", "id": "mac-normal"})
    app = App(server, places)
    app.hello(phones=())
    status, st = post(server, "/api/recording/mac/start")
    assert status == 200 and st["recording"]["source"] == "mac" and st["recording"]["since"]
    assert app.commands()[-1] == {"seq": app.after, "type": "mac_start", "prompt": "s0004"}
    assert post(server, "/api/recording/mac/stop")[0] == 200
    assert app.commands()[-1]["type"] == "mac_stop"
    status, result = app.take("s0004", good(style="normal"), source="mac", input="MacBook Pro-mikrofon")
    assert result["saved"]
    assert post(server, "/api/recording/mac/cancel")[0] == 200
    assert {r["id"]: r for r in settle(server)["rows"]}["s0004"]["status"] == "approved"


def test_an_exam_pick_and_a_pilot_pick_keep_their_takes_apart(server, places):
    status, st = post(server, "/api/recording/start", {"kind": "condition", "id": "phone-normal", "exam": True})
    assert status == 200 and st["pick"]["exam"] and [r["id"] for r in st["rows"]] == ["e01"]
    assert st["rows"][0]["kind"] == "exam"
    app = App(server, places)
    app.hello()
    app.take("e01", good(style="normal", seconds=3.0))
    take = {r["id"]: r for r in settle(server)["rows"]}["e01"]["take"]
    assert take["url"] == "/api/takes/exam-phone-normal/e01.wav"
    assert request(server, "GET", take["url"])[0] == 200
    assert (places.recordings / "exam" / "phone-normal" / "e01.wav").is_file()

    status, st = post(server, "/api/recording/start", {"kind": "pilot", "id": "airpods-whisper"})
    assert st["pick"] == {"kind": "pilot", "id": "airpods-whisper", "label": "AirPods, hvisket", "device": "mac",
                          "style": "whisper", "exam": False}
    app = App(server, places)
    app.hello(phones=())
    post(server, "/api/recording/mac/start")
    app.take("pilot-01", good(style="whisper"), source="mac", input="AirPods")
    take = {r["id"]: r for r in settle(server)["rows"]}["pilot-01"]["take"]
    assert take["url"] == "/api/takes/pilot-airpods-whisper/pilot-01.wav"
    assert (places.pilot / "airpods-whisper" / "pilot-01.wav").is_file()
    meta = json.loads((places.pilot / "airpods-whisper" / "pilot-01.json").read_text(encoding="utf-8"))
    assert meta["pilot"] is True and meta["setup"] == "airpods-whisper" and meta["review"]["status"]


@pytest.mark.parametrize("pick, status, error", [
    ({"kind": "condition", "id": "nope"}, 404, "unknown"),
    ({"kind": "condition", "id": "mac-whisper"}, 409, "no-share"),
    ({"kind": "pilot", "id": "Bad Name"}, 400, "bad-setup"),
    ({"kind": "planet", "id": "x"}, 400, "unknown"),
])
def test_a_pick_that_cannot_start(server, pick, status, error):
    got, body = post(server, "/api/recording/start", pick)
    assert (got, body["error"]) == (status, error) and body["message"]


def test_the_options_and_the_progress(server, places):
    app = start_phone(server, places)
    app.take("s0001", good())
    app.take("s0002", good())
    settle(server)
    post(server, "/api/recording/redo", {"id": "s0002"})
    status, options = get(server, "/api/recording/options")
    assert status == 200
    by_id = {c["id"]: c for c in options["conditions"]}
    assert list(by_id) == ["phone-whisper", "phone-normal", "mac-normal", "mac-whisper"]
    pw = by_id["phone-whisper"]
    assert (pw["label"], pw["share"], pw["planned"], pw["done"], pw["redo"]) == ("Telefonen, hvisket", 40, 3, 1, 1)
    assert pw["minutes"] == pytest.approx(round(2 * 2.9 / 60, 1))
    assert by_id["mac-whisper"]["share"] == 0
    assert options["exam"] == {"paragraphs": 1}
    setups = {s["name"]: s for s in options["pilot"]["setups"]}
    assert options["pilot"]["sentences"] == 2
    assert list(setups)[:6] == ["iphone-whisper", "iphone-normal", "mac-normal", "mac-whisper", "airpods-normal",
                                "studio"]
    assert setups["iphone-whisper"] == {"name": "iphone-whisper", "label": "iPhone, hvisket", "device": "phone",
                                        "style": "whisper", "done": 0, "total": 2, "suggested": True}
    assert setups["studio"]["label"] == "Studiemikrofon, almindelig stemme"
    assert setups["mac-normal"]["label"] == "Mac'en, almindelig stemme"
    status, progress = get(server, "/api/progress")
    assert progress["mix"] == {"phone-whisper": 40, "phone-normal": 40, "mac-normal": 20, "mac-whisper": 0}
    assert progress["sentences"] == 4
    row = progress["conditions"][0]
    assert (row["id"], row["planned"], row["done"], row["redo"], row["exam_done"], row["exam_total"]) == (
        "phone-whisper", 3, 1, 1, 0, 1)


def test_a_pilot_setup_with_takes_is_offered_too(server, places):
    post(server, "/api/recording/start", {"kind": "pilot", "id": "usb-mic"})
    app = App(server, places)
    app.hello(phones=())
    post(server, "/api/recording/mac/start")
    app.take("pilot-01", good(style="normal"), source="mac")
    settle(server)
    setups = {s["name"]: s for s in get(server, "/api/recording/options")[1]["pilot"]["setups"]}
    assert setups["usb-mic"]["done"] == 1 and setups["usb-mic"]["suggested"] is False
    assert setups["usb-mic"]["label"] == "usb, almindelig stemme"
    status, pilot = get(server, "/api/pilot")
    assert pilot["sentences"] == 2 and pilot["comparison"] is None and pilot["job"] is None
    assert {s["name"]: s["done"] for s in pilot["setups"]}["usb-mic"] == 1


# --- the review's findings (run 9) ----------------------------------------------------------


def test_a_verdict_written_while_a_redo_is_saved_never_lands_on_the_new_take(tmp_path):
    # R1: the reviewer read the old take's metadata; the app's redo take of the same sentence
    # was saved meanwhile (from the session's thread). The verdict must not overwrite the new
    # take's metadata with the old take's: saving waits for the write, which lands on the old
    # take, then moved aside with it.
    import numpy as np

    from wt_train.recorder.takes import TakeStore
    from wt_train.studio import review as rv

    store = TakeStore(tmp_path, "phone-whisper", {"s1": "Hej med dig."})
    samples = (np.random.default_rng(1).standard_normal(16000) * 3000).astype(np.int16)
    old = {"id": "s1", "session": "A", "take": 1, "recorded_at": "t1", "microphone": "old-mic"}
    store.save("s1", samples, old)
    entry = rv.Entry(store, "s1", "Hej med dig.", "whisper", "phone", dict(old))
    real_meta = store.meta
    saver: list[threading.Thread] = []

    def racing_meta(item_id):
        meta = real_meta(item_id)
        if not saver:
            new = {"id": "s1", "session": "A", "take": 2, "recorded_at": "t2", "microphone": "new-mic"}
            saver.append(threading.Thread(target=store.save, args=("s1", samples, new)))
            saver[0].start()
            saver[0].join(0.3)  # with the shared lock it cannot finish before the write
        return meta

    store.meta = racing_meta
    rv.Reviewer(transcriber=lambda: None)._write(entry, {"status": "redo", "by": "check", "problems": []})
    saver[0].join(5)
    store.meta = real_meta
    current = store.meta("s1")
    assert (current["take"], current["microphone"]) == (2, "new-mic") and "review" not in current
    (moved,) = (tmp_path / ".replaced" / "phone-whisper").glob("s1.*.json")
    kept = json.loads(moved.read_text(encoding="utf-8"))
    assert kept["take"] == 1 and kept["review"]["status"] == "redo"
    assert not [p for p in store.folder.iterdir() if p.suffix not in (".wav", ".txt", ".json")]


def test_a_verdict_for_a_take_that_was_replaced_is_not_written(tmp_path):
    import numpy as np

    from wt_train.recorder.takes import TakeStore
    from wt_train.studio import review as rv

    store = TakeStore(tmp_path, "phone-whisper", {"s1": "Hej med dig."})
    samples = np.zeros(16000, dtype=np.int16)
    first = {"id": "s1", "session": "A", "take": 1, "recorded_at": "t1"}
    store.save("s1", samples, first)
    entry = rv.Entry(store, "s1", "Hej med dig.", "whisper", "phone", dict(first))
    store.save("s1", samples, {"id": "s1", "session": "A", "take": 2, "recorded_at": "t2"})
    reviewer = rv.Reviewer(transcriber=lambda: None)
    reviewer._write(entry, {"status": "redo", "by": "check"})
    reviewer.set_owner(entry, "approved")
    assert "review" not in store.meta("s1")
    assert store.update_meta("s1", {"x": 1}, expect=("A", 1, "t1")) is None
    assert store.update_meta("s1", {"x": 1}, expect=("A", 2, "t2"))["x"] == 1


def test_no_phone_from_the_apps_hello_is_not_overwritten_by_the_handoff(tmp_path, monkeypatch):
    # R2: the app's refused hello arrives before the handoff command has returned.
    import dataclasses

    places = dataclasses.replace(write_places(tmp_path, monkeypatch), app_url_file=None)
    holder = {}

    def handoff(url, app_bin):
        token = url.split("#", 1)[1]
        body = json.dumps({"app": "walkietalkey", "version": "0.3.0", "os": "mac", "phones": []}).encode()
        holder["hello"] = request(holder["srv"], "POST", "/app/v1/hello", body,
                                  {"Authorization": f"Bearer {token}", "Content-Type": "application/json"})[0]
        return "ok", "handed to WalkieTalkey"

    srv = start_server(places, handoff=handoff)
    holder["srv"] = srv
    try:
        assert post(srv, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})[0] == 200
        deadline = time.monotonic() + 5
        while "hello" not in holder and time.monotonic() < deadline:
            time.sleep(0.05)
        time.sleep(0.3)
        assert holder["hello"] == 409
        assert state(srv)["link"]["status"] == "no_phone"
    finally:
        stop_server(srv)


def test_a_handoff_that_fails_still_says_so(tmp_path, monkeypatch):
    import dataclasses

    places = dataclasses.replace(write_places(tmp_path, monkeypatch), app_url_file=None)
    srv = start_server(places, handoff=lambda url, app_bin: ("not_running", "WalkieTalkey is not running"))
    try:
        post(srv, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
        deadline = time.monotonic() + 5
        while state(srv)["link"]["status"] == "connecting" and time.monotonic() < deadline:
            time.sleep(0.05)
        assert state(srv)["link"] == {"status": "not_running", "detail": "WalkieTalkey is not running"}
    finally:
        stop_server(srv)


def test_an_unreadable_take_does_not_stop_a_pick_from_opening(server, places):
    # R3: a take with the owner's verdict, no audio numbers and a WAV that cannot be read.
    folder = places.recordings / "phone-whisper"
    folder.mkdir(parents=True)
    (folder / "s0001.txt").write_text("Vi merger PR'en, når buildet er grønt.\n", encoding="utf-8")
    (folder / "s0001.wav").write_bytes(b"RIFF\x00\x00\x00\x00WAVEjunk")
    (folder / "s0001.json").write_text(json.dumps({
        "id": "s0001", "session": "a", "take": 1, "recorded_at": "t", "seconds": 2.0,
        "review": {"status": "approved", "by": "owner", "audio": None}}), encoding="utf-8")
    assert post(server, "/api/recording/start", {"kind": "condition", "id": "mac-normal"})[0] == 200
    status, st = post(server, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
    assert status == 200 and st["pick"]["id"] == "phone-whisper" and st["active"]
    row = {r["id"]: r for r in st["rows"]}["s0001"]
    assert row["status"] == "approved" and row["take"]["level_dbfs"] is None
    assert [p["kind"] for p in row["take"]["problems"]] == ["error"]


def test_a_pick_that_fails_to_open_leaves_the_running_session_alone(server, places, monkeypatch):
    from wt_train.studio.recording import Recorder

    assert post(server, "/api/recording/start", {"kind": "condition", "id": "mac-normal"})[0] == 200
    app = App(server, places)
    app.hello(phones=())

    def broken(self, pick):
        raise RuntimeError("the disk is gone")

    monkeypatch.setattr(Recorder, "_load", broken)
    status, body = post(server, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
    assert status == 500 and body["error"] == "internal" and "the disk is gone" in body["message"]
    st = state(server)
    assert st["pick"]["id"] == "mac-normal" and st["active"]
    assert all(c["type"] != "end" for c in app.commands())


def test_a_take_with_broken_metadata_still_opens(server, places):
    folder = places.recordings / "phone-whisper"
    folder.mkdir(parents=True)
    from wt_train.recorder.audio import write_wav

    write_wav(folder / "s0001.wav", good())
    (folder / "s0001.txt").write_text("Vi merger PR'en, når buildet er grønt.\n", encoding="utf-8")
    (folder / "s0001.json").write_text("{not json", encoding="utf-8")
    status, st = post(server, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
    assert status == 200 and st["active"]
    assert server.reviewer.idle(10)
    row = {r["id"]: r for r in state(server)["rows"]}["s0001"]
    assert row["status"] == "received" and [p["kind"] for p in row["take"]["problems"]] == ["error"]
