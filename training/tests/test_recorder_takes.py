"""The takes on disk: one folder per condition, metadata beside each take, redo keeps the old take,
ids from the list only, and run 4's browser takes stay where they are."""

import json

import numpy as np
import pytest
import soundfile as sf
from fake_audio import app_take, pcm16
from wt_train.recorder.takes import TakeStore, UnknownItem, condition_folder, log_session

TEXTS = {"s0001": "Vi merger PR'en i dag.", "s0002": "Det regner i Aarhus."}


def a_take():
    return pcm16(app_take([("silence", 0.3), ("speech", 1.0), ("silence", 0.3)]))


@pytest.fixture
def store(tmp_path):
    return TakeStore(tmp_path / "recordings", "phone-whisper", TEXTS)


def test_a_take_is_a_wav_its_text_and_its_metadata(store, tmp_path):
    assert store.status("s0001") == "missing"
    assert store.save("s0001", a_take(), {"take": 1, "device": "iphone"}) is False
    folder = tmp_path / "recordings" / "phone-whisper"
    assert sf.info(str(folder / "s0001.wav")).samplerate == 16000
    assert (folder / "s0001.txt").read_text(encoding="utf-8") == "Vi merger PR'en i dag.\n"
    assert json.loads((folder / "s0001.json").read_text())["device"] == "iphone"
    assert store.meta("s0001")["take"] == 1
    assert store.status("s0001") == "recorded" and store.recorded() == {"s0001"}


def test_a_redo_keeps_every_earlier_take(store, tmp_path):
    store.save("s0001", a_take(), {"take": 1})
    assert store.earlier_takes("s0001") == 0
    assert store.save("s0001", a_take(), {"take": 2}) is True
    assert store.save("s0001", a_take(), {"take": 3}) is True
    replaced = tmp_path / "recordings" / ".replaced" / "phone-whisper"
    assert len(list(replaced.glob("s0001.*.wav"))) == 2
    assert len(list(replaced.glob("s0001.*.json"))) == 2
    assert store.earlier_takes("s0001") == 2
    assert store.meta("s0001")["take"] == 3


def test_an_edited_sentence_makes_its_take_stale(tmp_path):
    TakeStore(tmp_path, "mac-normal", TEXTS).save("s0002", a_take(), {})
    edited = TakeStore(tmp_path, "mac-normal", {**TEXTS, "s0002": "Det regner i Aalborg."})
    assert edited.status("s0002") == "stale"


def test_conditions_and_the_exam_have_their_own_folders(tmp_path):
    assert condition_folder(tmp_path, "phone-normal") == tmp_path / "phone-normal"
    assert condition_folder(tmp_path, "mac-normal", exam=True) == tmp_path / "exam" / "mac-normal"
    with pytest.raises(ValueError):
        condition_folder(tmp_path, "../x")
    TakeStore(tmp_path, "phone-normal", TEXTS).save("s0001", a_take(), {})
    assert TakeStore(tmp_path, "phone-whisper", TEXTS).status("s0001") == "missing"


def test_the_browser_takes_of_run_4_are_left_alone(tmp_path):
    # Run 4's recorder wrote <id>.wav and <id>.txt in the top folder; nothing here moves them.
    (tmp_path / "s0001.wav").write_bytes(b"RIFF")
    (tmp_path / "s0001.txt").write_text("Vi merger PR'en i dag.\n")
    store = TakeStore(tmp_path, "mac-normal", TEXTS)
    store.save("s0001", a_take(), {})
    assert (tmp_path / "s0001.wav").read_bytes() == b"RIFF"
    assert (tmp_path / "mac-normal" / "s0001.wav").is_file()


@pytest.mark.parametrize("bad", ["s9999", "../x", ""])
def test_only_ids_from_the_list(store, bad):
    with pytest.raises(UnknownItem):
        store.save(bad, a_take(), {})


def test_unsafe_ids_are_refused(tmp_path):
    with pytest.raises(ValueError, match="letters"):
        TakeStore(tmp_path, "mac-normal", {"../evil": "x"})


def test_the_session_log_appends_lines(tmp_path):
    log_session(tmp_path, {"event": "start", "session": "a"})
    log_session(tmp_path, {"event": "end", "session": "a"})
    lines = (tmp_path / "sessions.jsonl").read_text().splitlines()
    assert [json.loads(line)["event"] for line in lines] == ["start", "end"]


def test_no_part_files_are_left(store, tmp_path):
    store.save("s0002", np.zeros(1600, dtype=np.int16), {})
    assert not list((tmp_path / "recordings").rglob("*.part"))


def test_update_meta_merges_into_the_current_take_atomically(tmp_path):
    import json

    import numpy as np
    from wt_train.recorder.takes import TakeStore, review_status

    store = TakeStore(tmp_path, "phone-whisper", {"s0001": "Hej."})
    store.save("s0001", np.zeros(1600, dtype=np.int16), {"id": "s0001", "take": 1})
    assert review_status(store.meta("s0001")) is None
    meta = store.update_meta("s0001", {"review": {"status": "redo", "by": "owner"}})
    assert meta == {"id": "s0001", "take": 1, "review": {"status": "redo", "by": "owner"}}
    assert json.loads(store.meta_path("s0001").read_text(encoding="utf-8")) == meta
    assert review_status(meta) == "redo"
    assert review_status({"review": {"status": "maybe"}}) is None
    assert not list(store.folder.glob("*.part"))
