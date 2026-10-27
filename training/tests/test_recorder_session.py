"""A recording session: the app's hello, prompts, takes and their checks, redo, resume."""

import json

import pytest
from fake_audio import app_take, pcm16
from wt_train.conditions import condition
from wt_train.exam import Paragraph
from wt_train.recorder.session import AppRefused, Session
from wt_train.sentences import Sentence

ROWS = [
    Sentence("s0001", "Vi merger PR'en i dag.", "terms"),
    Sentence("s0002", "Det regner i Aarhus.", "plain"),
    Sentence("s0003", "Kan du deploye til staging?", "terms"),
]
TEXTS = {s.id: s.text for s in ROWS}
PHONE = {"id": "cGhvbmUtaWQtMTIzNDU2Nw", "name": "Jonathans iPhone", "platform": "ios", "online": True}


def hello(session, phones=(PHONE,), **extra):
    return session.hello({"app": "walkietalkey", "version": "0.3.0", "os": "mac", "phones": list(phones),
                          "input": "MacBook Pro-mikrofon", **extra})


def new_session(tmp_path, cid="phone-whisper", items=ROWS, exam=False, **kw):
    texts = {i.id: i.text for i in items}
    return Session(root=tmp_path / "recordings", condition=condition(cid), items=list(items), texts=texts,
                   exam=exam, **kw)


def good(style="whisper", seconds=2.0):
    return pcm16(app_take([("silence", 0.5), ("speech", seconds), ("silence", 0.4)], style=style))


def silent():
    return pcm16(app_take([("silence", 2.5)], noise_dbfs=-58))


def phone_take(session, prompt, samples, **meta):
    return session.take({"prompt": prompt, "source": "phone", "session": "c2Vzc2lvbi1pZC0xMjM0NQ",
                         "phone": PHONE["id"], "microphone": "iPhone-mikrofon", "chunks": 12, "missing": 0,
                         **meta}, samples)


def commands(session, after=0):
    return session.next_commands(after, timeout=0)


def last_prompt(session):
    return [c for c in commands(session) if c["type"] == "prompt"][-1]


def test_hello_names_the_condition_the_phone_and_the_first_prompt(tmp_path):
    s = new_session(tmp_path)
    answer = hello(s)
    assert answer["device"] == "phone" and answer["style"] == "whisper"
    assert answer["phone"] == PHONE["id"]
    assert len(answer["training"]) == 22  # 16 bytes, base64url
    p = last_prompt(s)
    assert p["next"] == {"prompt": "s0001", "text": "Vi merger PR'en i dag."}
    assert p["last"] is None
    assert (p["done"], p["total"]) == (0, 3)
    assert s.state()["app"]["connected"]


def test_a_phone_session_needs_a_paired_phone(tmp_path):
    s = new_session(tmp_path)
    with pytest.raises(AppRefused, match="phone"):
        hello(s, phones=())
    # The Mac's own condition does not.
    assert hello(new_session(tmp_path, "mac-normal"), phones=())["phone"] is None


def test_the_chosen_phone_is_the_named_one_or_one_that_is_online(tmp_path):
    other = {"id": "b3RoZXItcGhvbmUtaWQxMg", "name": "Saras Android", "platform": "android", "online": True}
    away = {**PHONE, "online": False}
    assert hello(new_session(tmp_path), phones=(away, other))["phone"] == other["id"]
    named = new_session(tmp_path, phone="jonathan")
    assert hello(named, phones=(away, other))["phone"] == PHONE["id"]


def test_a_good_take_is_saved_with_its_metadata_and_the_next_sentence_follows(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    r = phone_take(s, "s0001", good())
    assert r["saved"] and r["check"] == "ok" and not r["replaced"]
    folder = tmp_path / "recordings" / "phone-whisper"
    assert (folder / "s0001.txt").read_text(encoding="utf-8") == "Vi merger PR'en i dag.\n"
    meta = json.loads((folder / "s0001.json").read_text(encoding="utf-8"))
    assert meta["id"] == "s0001" and meta["kind"] == "terms"
    assert (meta["condition"], meta["device"], meta["device_class"], meta["style"]) == (
        "phone-whisper", "iphone", "phone", "whisper")
    assert meta["microphone"] == "iPhone-mikrofon"
    assert meta["phone"] == {"name": "Jonathans iPhone", "platform": "ios"}
    assert meta["session"] == s.id and meta["take"] == 1 and meta["capture"] == "app"
    assert meta["checks"]["check"] == "ok" and meta["relay"]["missing"] == 0
    assert meta["recorded_at"]
    p = last_prompt(s)
    assert p["next"]["prompt"] == "s0002"
    assert p["last"] == {"prompt": "s0001", "text": "Vi merger PR'en i dag.", "check": "ok"}
    assert p["done"] == 1


def test_a_silent_take_is_refused_and_the_sentence_stays(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    r = phone_take(s, "s0001", silent())
    assert not r["saved"] and r["check"] == "silent"
    assert not (tmp_path / "recordings" / "phone-whisper" / "s0001.wav").exists()
    p = last_prompt(s)
    assert p["next"]["prompt"] == "s0001"
    assert p["last"]["check"] == "silent" and p["done"] == 0


def test_a_take_with_gaps_is_refused(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    assert phone_take(s, "s0001", good(), missing=3)["check"] == "gaps"


def test_a_failed_check_is_kept_and_offered_for_a_redo_of_the_last_take(tmp_path):
    s = new_session(tmp_path, "phone-normal")
    hello(s)
    # A whisper's level read in the normal-voice condition: quiet, kept, redo offered.
    r = phone_take(s, "s0001", good(style="whisper"))
    assert r["saved"] and r["check"] == "quiet"
    p = last_prompt(s)
    assert p["next"]["prompt"] == "s0002" and p["last"]["check"] == "quiet"
    # The phone records the last prompt again: a redo, the old take kept aside.
    r = phone_take(s, "s0001", good(style="normal"))
    assert r["saved"] and r["replaced"] and r["check"] == "ok"
    replaced = tmp_path / "recordings" / ".replaced" / "phone-normal"
    assert len(list(replaced.glob("s0001.*.wav"))) == 1
    assert len(list(replaced.glob("s0001.*.json"))) == 1
    meta = json.loads((tmp_path / "recordings" / "phone-normal" / "s0001.json").read_text())
    assert meta["take"] == 2
    p = last_prompt(s)
    assert p["next"]["prompt"] == "s0002", "a redo does not move the session"
    assert p["last"] == {"prompt": "s0001", "text": "Vi merger PR'en i dag.", "check": "ok"}


def test_a_take_for_another_sentence_is_refused(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    assert phone_take(s, "s0003", good())["check"] == "error"
    assert phone_take(s, "nope", good())["check"] == "error"
    # A Mac take in a phone session, too.
    assert s.take({"prompt": "s0001", "source": "mac"}, good())["check"] == "error"


def test_the_session_resumes_at_the_first_open_sentence_and_wraps(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    s.go(1)
    phone_take(s, "s0002", good())
    assert last_prompt(s)["next"]["prompt"] == "s0003"
    again = new_session(tmp_path)
    hello(again)
    assert last_prompt(again)["next"]["prompt"] == "s0001"
    phone_take(again, "s0001", good())
    assert last_prompt(again)["next"]["prompt"] == "s0003", "s0002 is done already"
    phone_take(again, "s0003", good())
    p = last_prompt(again)
    assert p["next"] is None and (p["done"], p["total"]) == (3, 3)
    assert again.state()["complete"]


def test_page_navigation_moves_the_prompt(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    s.next()
    assert last_prompt(s)["next"]["prompt"] == "s0002"
    s.prev()
    s.prev()
    assert last_prompt(s)["next"]["prompt"] == "s0001"
    phone_take(s, "s0001", good())
    s.redo_last()
    assert last_prompt(s)["next"]["prompt"] == "s0001"


def test_mac_takes_are_started_and_stopped_from_the_page(tmp_path):
    s = new_session(tmp_path, "mac-normal")
    hello(s, phones=())
    seen = len(commands(s))
    s.mac_start()
    cmds = commands(s, after=s.seq - 1)
    assert cmds[-1] == {"seq": s.seq, "type": "mac_start", "prompt": "s0001"}
    s.event({"type": "recording", "prompt": "s0001", "source": "mac", "input": "MacBook Pro-mikrofon"})
    assert s.state()["recording"]["confirmed"]
    s.mac_stop()
    assert commands(s, after=s.seq - 1)[-1]["type"] == "mac_stop"
    r = s.take({"prompt": "s0001", "source": "mac", "input": "MacBook Pro-mikrofon"}, good(style="normal"))
    assert r["saved"] and r["check"] == "ok"
    meta = json.loads((tmp_path / "recordings" / "mac-normal" / "s0001.json").read_text())
    assert (meta["device"], meta["microphone"], meta["phone"]) == ("mac", "MacBook Pro-mikrofon", None)
    assert "relay" not in meta
    assert s.state()["recording"] is None
    assert len(commands(s)) > seen


def test_the_mac_input_that_failed_is_reported(tmp_path):
    s = new_session(tmp_path, "mac-normal")
    hello(s, phones=())
    s.mac_start()
    s.event({"type": "mac_failed", "message": "Already recording"})
    st = s.state()
    assert st["recording"] is None and "Already recording" in st["error"]


def test_the_long_poll_waits_for_a_command(tmp_path):
    import threading
    import time

    s = new_session(tmp_path)
    hello(s)
    after = s.seq
    got = []
    t = threading.Thread(target=lambda: got.extend(s.next_commands(after, timeout=5)))
    t.start()
    time.sleep(0.1)
    s.next()
    t.join(2)
    assert got and got[0]["type"] == "prompt"
    assert s.next_commands(s.seq, timeout=0.05) == []


def test_the_end_reaches_the_app_and_the_log(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    phone_take(s, "s0001", good())
    s.end()
    assert commands(s, after=s.seq - 1)[-1]["type"] == "end"
    lines = (tmp_path / "recordings" / "sessions.jsonl").read_text().splitlines()
    events = [json.loads(line) for line in lines]
    assert [e["event"] for e in events] == ["start", "end"]
    assert events[0]["condition"] == "phone-whisper" and events[1]["saved"] == 1


def test_an_exam_session_records_paragraphs_into_the_exam_folder(tmp_path):
    exam = [Paragraph("e01", "Mandag", "God morgen allesammen, vi starter standuppen nu."),
            Paragraph("e02", "Nat", "I nat crashede backenden to gange.")]
    s = new_session(tmp_path, "phone-normal", items=exam, exam=True)
    hello(s)
    assert last_prompt(s)["next"]["prompt"] == "e01"
    r = phone_take(s, "e01", good(style="normal", seconds=3.0))
    assert r["saved"]
    meta = json.loads((tmp_path / "recordings" / "exam" / "phone-normal" / "e01.json").read_text())
    assert meta["exam"] is True and meta["kind"] == "exam"


def test_the_page_state_shows_progress_and_the_last_take(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    phone_take(s, "s0001", good())
    st = s.state()
    assert st["condition"]["id"] == "phone-whisper"
    assert (st["done"], st["total"], st["index"]) == (1, 3, 1)
    assert st["items"][0]["status"] == "recorded"
    assert st["last"]["check"] == "ok" and st["last"]["prompt"] == "s0001"
    assert st["phone"]["name"] == "Jonathans iPhone"


def test_a_redo_goes_back_to_the_last_kept_take_not_a_refused_one(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    phone_take(s, "s0001", good())
    assert phone_take(s, "s0002", silent())["check"] == "silent"
    s.redo_last()
    assert last_prompt(s)["next"]["prompt"] == "s0001"
    # Before anything is kept there is nothing to redo.
    fresh = new_session(tmp_path / "other")
    hello(fresh)
    fresh.redo_last()
    assert last_prompt(fresh)["next"]["prompt"] == "s0001"
    assert phone_take(fresh, "s0002", good())["check"] == "error", "only the current sentence"


# --- run 9: "Spring over", reviews, the end, hooks (shared with wt-train studio) -------------


def test_spring_over_passes_the_sentence_over_until_the_others_had_their_turn(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    assert s.skip()
    assert last_prompt(s)["next"]["prompt"] == "s0002"
    assert s.state()["items"][0]["skipped"] is True
    phone_take(s, "s0002", good())
    assert last_prompt(s)["next"]["prompt"] == "s0003", "the skipped s0001 waits"
    phone_take(s, "s0003", good())
    p = last_prompt(s)
    assert p["next"]["prompt"] == "s0001", "only the skipped one is left: a new round"
    assert s.skipped == set()


def test_the_phone_skips_in_band_and_it_is_never_a_take_or_recording(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    s.event({"type": "recording", "prompt": "skip:s0001", "source": "phone"})
    assert s.state()["recording"] is None
    s.event({"type": "cancelled", "prompt": "skip:s0001", "source": "phone"})
    assert last_prompt(s)["next"]["prompt"] == "s0002"
    assert not (tmp_path / "recordings" / "phone-whisper" / "s0001.wav").exists()
    # A skip of a sentence that is not the current one changes nothing.
    s.event({"type": "cancelled", "prompt": "skip:s0003", "source": "phone"})
    assert last_prompt(s)["next"]["prompt"] == "s0002"


def test_no_skip_while_a_take_is_recording(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    s.event({"type": "recording", "prompt": "s0001", "source": "phone"})
    assert not s.skip()
    assert last_prompt(s)["next"]["prompt"] == "s0001"


def test_a_take_whose_review_says_redo_is_open_again(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    phone_take(s, "s0001", good())
    s.store.update_meta("s0001", {"review": {"status": "redo", "by": "owner"}})
    again = new_session(tmp_path)
    hello(again)
    p = last_prompt(again)
    assert p["next"]["prompt"] == "s0001" and p["done"] == 0
    s.store.update_meta("s0001", {"review": {"status": "approved", "by": "owner"}})
    assert last_prompt(hello_and(new_session(tmp_path)))["next"]["prompt"] == "s0002"


def hello_and(session):
    hello(session)
    return session


def test_review_changed_moves_on_from_a_kept_sentence_and_restarts_a_finished_session(tmp_path):
    reviews = {}
    s = new_session(tmp_path, is_open=lambda i: reviews.get(i) != "kept")
    hello(s)
    reviews["s0001"] = "kept"
    s.review_changed("s0001")
    assert last_prompt(s)["next"]["prompt"] == "s0002"
    reviews.update({"s0002": "kept", "s0003": "kept"})
    s.review_changed("s0002")
    s.review_changed("s0003")
    assert last_prompt(s)["next"] is None
    reviews["s0002"] = "redo"
    s.review_changed("s0002")
    assert last_prompt(s)["next"]["prompt"] == "s0002"


def test_after_the_end_no_take_is_kept_and_no_mac_take_starts(tmp_path):
    s = new_session(tmp_path)
    hello(s)
    s.end()
    assert phone_take(s, "s0001", good())["check"] == "error"
    assert not (tmp_path / "recordings" / "phone-whisper" / "s0001.wav").exists()
    mac = new_session(tmp_path, "mac-normal")
    hello(mac, phones=())
    mac.end()
    assert not mac.mac_start()


def test_hooks_hear_every_change_and_every_kept_take(tmp_path):
    changes, kept = [], []
    s = new_session(tmp_path, on_change=lambda: changes.append(1),
                    on_take=lambda item, result, meta: kept.append((item.id, result.check, meta["take"])))
    hello(s)
    n = len(changes)
    phone_take(s, "s0001", good())
    phone_take(s, "s0002", silent())
    assert kept == [("s0001", "ok", 1)]
    assert len(changes) >= n + 2


def test_resume_from_picks_up_the_current_sentence_and_the_skips(tmp_path):
    s = new_session(tmp_path)
    s.resume_from("s0003", {"s0001", "nope"})
    hello(s)
    assert last_prompt(s)["next"]["prompt"] == "s0003"
    assert s.skipped == {"s0001"}
