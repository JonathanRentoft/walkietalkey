"""The checks after each take: level, clipping, silence (whispers are quiet by nature), and the
phone's missing blocks."""

import numpy as np
import pytest
from fake_audio import app_take, pcm16
from wt_train.recorder import checks
from wt_train.recorder.checks import check_take

SENTENCE = "Vi merger PR'en, når buildet er grønt."


def judge(x, style="normal", device="phone", **kw):
    return check_take(pcm16(x), style=style, device=device, text=kw.pop("text", SENTENCE), **kw)


@pytest.mark.parametrize("style", ["normal", "whisper"])
def test_a_good_take_passes_in_either_voice(style):
    r = judge(app_take([("silence", 0.6), ("speech", 2.4), ("silence", 0.5)], style=style), style=style)
    assert r.check == "ok", r
    assert r.saved
    assert r.speech_seconds == pytest.approx(2.4, abs=0.25)
    assert r.seconds == pytest.approx(3.5, abs=0.01)


def test_a_whisper_is_judged_as_a_whisper_and_not_as_a_quiet_voice():
    x = app_take([("silence", 0.6), ("speech", 2.4), ("silence", 0.5)], style="whisper")
    assert judge(x, style="whisper").check == "ok"
    # Read in a normal voice at a whisper's level, it is too quiet: offered a redo, but kept.
    quiet = judge(x, style="normal")
    assert quiet.check == "quiet" and quiet.saved


def test_a_whisper_too_quiet_even_for_a_whisper():
    x = app_take([("silence", 0.6), ("speech", 2.4), ("silence", 0.5)], style="whisper",
                 noise_dbfs=-75, level_dbfs=-56)
    r = judge(x, style="whisper")
    assert r.check == "quiet" and r.saved


@pytest.mark.parametrize("style", ["normal", "whisper"])
def test_room_noise_only_is_silent_and_not_saved(style):
    x = app_take([("silence", 3.0)], style=style, noise_dbfs=-58)
    r = judge(x, style=style)
    assert r.check == "silent"
    assert not r.saved


def test_a_dead_input_is_silent():
    r = check_take(np.zeros(16000 * 3, dtype=np.int16), style="whisper", device="mac", text=SENTENCE)
    assert r.check == "silent" and not r.saved


def test_clipping_on_the_mac_input():
    x = app_take([("silence", 0.5), ("speech", 2.0), ("silence", 0.5)])
    x[16000:16100] = 1.0
    r = judge(x, device="mac")
    assert r.check == "clipped" and r.saved


def test_the_phone_limiter_held_at_its_ceiling_counts_as_clipping():
    # The phone's look-ahead limiter keeps every sample under -1 dBFS (PHONE-30), so a take
    # that is far too loud flattens at the ceiling instead of reaching full scale.
    x = app_take([("silence", 0.5), ("speech", 2.0), ("silence", 0.5)], level_dbfs=-3)
    ceiling = checks.PHONE_CEILING
    x = np.clip(x, -ceiling, ceiling)
    r = judge(x, device="phone")
    assert r.check == "clipped", r
    # The same audio from the Mac input is under full scale: not clipped there.
    assert judge(x, device="mac").check != "clipped"


def test_a_take_cut_too_short_for_its_sentence():
    x = app_take([("silence", 0.4), ("speech", 0.5), ("silence", 0.3)])
    r = judge(x, text="Det her er en ret lang sætning med mange ord i, som tager tid at sige.")
    assert r.check == "short" and r.saved
    assert judge(x, text="Ja tak.").check == "ok"


def test_missing_blocks_refuse_the_take():
    x = app_take([("silence", 0.5), ("speech", 2.0), ("silence", 0.5)])
    r = judge(x, missing=2)
    assert r.check == "gaps" and not r.saved


def test_the_worst_problem_names_the_check_and_all_are_listed():
    x = app_take([("silence", 0.4), ("speech", 0.4), ("silence", 0.3)], level_dbfs=-45)
    x[8000:8100] = 1.0
    r = judge(x, device="mac", text="En lang sætning med rigtig mange ord, der tager sin tid.")
    assert r.check == "clipped"
    assert set(r.problems) >= {"clipped", "quiet", "short"}
    d = r.as_dict()
    assert d["check"] == "clipped" and d["saved"] is True
    assert {"loudest_dbfs", "noise_dbfs", "peak_dbfs", "speech_seconds", "seconds"} <= set(d)
