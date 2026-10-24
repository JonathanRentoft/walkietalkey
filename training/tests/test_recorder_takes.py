"""The recorder's takes on disk: resume, redo keeps the old take, ids from the CSV only."""

import numpy as np
import pytest
import soundfile as sf
from fake_audio import take
from wt_train.recorder.audio import process
from wt_train.recorder.takes import Takes, UnknownSentence
from wt_train.sentences import Sentence

ROWS = [
    Sentence("s0001", "Vi merger PR'en i dag.", "terms"),
    Sentence("s0002", "Det regner i Aarhus.", "plain"),
    Sentence("s0003", "Kan du deploye til staging?", "terms"),
    Sentence("s0004", "Vi ses i morgen.", "plain"),
]


def a_take(seconds: float = 1.0):
    return process(take(48000, [("silence", 0.3), ("speech", seconds), ("silence", 0.3)]), 48000)


@pytest.fixture
def takes(tmp_path):
    return Takes(ROWS, tmp_path / "recordings")


def test_resumes_at_the_first_sentence_without_a_take(takes):
    assert takes.first_open() == 0
    takes.save("s0001", a_take())
    takes.save("s0002", a_take())
    assert takes.first_open() == 2
    takes.save("s0004", a_take())
    assert takes.first_open() == 2, "a gap is filled before going on"
    takes.save("s0003", a_take())
    assert takes.first_open() is None
    assert takes.recorded_count() == 4


def test_resume_survives_a_restart(tmp_path):
    Takes(ROWS, tmp_path).save("s0001", a_take())
    assert Takes(ROWS, tmp_path).first_open() == 1


def test_saves_the_wav_and_the_text_as_shown(takes):
    path = takes.save("s0001", a_take())
    assert path == takes.folder / "s0001.wav"
    assert sf.info(str(path)).samplerate == 16000
    assert (takes.folder / "s0001.txt").read_text(encoding="utf-8") == "Vi merger PR'en i dag.\n"
    assert takes.status("s0001") == "recorded"
    assert takes.status("s0002") == "missing"


def test_a_take_whose_text_changed_counts_as_open(tmp_path):
    Takes(ROWS, tmp_path).save("s0001", a_take())
    edited = [Sentence("s0001", "Vi merger PR'en i morgen.", "terms"), *ROWS[1:]]
    takes = Takes(edited, tmp_path)
    assert takes.status("s0001") == "stale"
    assert takes.first_open() == 0
    assert takes.recorded_count() == 0


def test_a_redo_keeps_the_replaced_take(takes):
    takes.save("s0001", a_take(1.0))
    first = sf.read(str(takes.folder / "s0001.wav"), dtype="int16")[0]
    takes.save("s0001", a_take(2.0))
    current = sf.read(str(takes.folder / "s0001.wav"), dtype="int16")[0]
    assert len(current) > len(first)
    kept = sorted(p.name for p in takes.replaced.iterdir())
    assert len(kept) == 2 and kept[0].startswith("s0001.") and {p[-4:] for p in kept} == {".wav", ".txt"}
    old = sf.read(str(next(takes.replaced.glob("s0001.*.wav"))), dtype="int16")[0]
    assert np.array_equal(old, first)
    # A third take keeps both earlier ones.
    takes.save("s0001", a_take(1.5))
    assert len(list(takes.replaced.glob("s0001.*.wav"))) == 2


def test_no_partial_files_are_left(takes):
    takes.save("s0001", a_take())
    assert sorted(p.name for p in takes.folder.iterdir()) == ["s0001.txt", "s0001.wav"]


@pytest.mark.parametrize("bad", ["../s0001", "s0001/../../x", "", "a b", "s0001.wav", ".hidden", "x" * 65])
def test_only_plain_ids_are_accepted_from_the_csv(tmp_path, bad):
    with pytest.raises(ValueError, match="id"):
        Takes([Sentence(bad, "Hej med dig.", "plain")], tmp_path)


@pytest.mark.parametrize("unknown", ["s9999", "../s0001", "s0001.wav", "..", ""])
def test_only_ids_from_the_csv_get_a_path(takes, unknown):
    with pytest.raises(UnknownSentence):
        takes.wav_path(unknown)
    with pytest.raises(UnknownSentence):
        takes.save(unknown, a_take())
    assert not takes.folder.exists() or list(takes.folder.iterdir()) == []
