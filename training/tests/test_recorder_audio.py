"""The recorder's audio helpers: speech found from frame levels, PCM16 in and out."""

import numpy as np
import pytest
import soundfile as sf
from fake_audio import app_take, pcm16, take
from wt_train.recorder import audio
from wt_train.recorder.audio import TARGET_RATE, speech_bounds


def span(x) -> float:
    b = speech_bounds(x, TARGET_RATE)
    return (b[1] - b[0]) / TARGET_RATE if b else 0.0


def test_finds_the_speech_between_the_silences():
    x = take(TARGET_RATE, [("silence", 0.8), ("speech", 1.5), ("silence", 0.6)])
    start, end = speech_bounds(x, TARGET_RATE)
    assert start / TARGET_RATE == pytest.approx(0.8, abs=0.03)
    assert end / TARGET_RATE == pytest.approx(2.3, abs=0.03)


def test_a_pause_inside_the_sentence_is_kept():
    x = take(TARGET_RATE, [("silence", 0.5), ("speech", 0.6), ("silence", 0.5), ("speech", 0.6), ("silence", 0.5)])
    assert span(x) == pytest.approx(1.7, abs=0.04)


def test_a_key_click_before_the_speech_is_not_speech():
    x = take(TARGET_RATE, [("silence", 1.0), ("speech", 1.5), ("silence", 1.0)])
    x[int(0.15 * TARGET_RATE) : int(0.165 * TARGET_RATE)] = 0.9
    x[int(3.2 * TARGET_RATE) : int(3.21 * TARGET_RATE)] = 0.8
    assert span(x) == pytest.approx(1.5, abs=0.04)


def test_a_whisper_is_found_with_a_whispers_floor():
    x = app_take([("silence", 0.6), ("speech", 2.0), ("silence", 0.6)], style="whisper", noise_dbfs=-72,
                 level_dbfs=-55)
    assert speech_bounds(x, TARGET_RATE) is None, "below a normal voice's floor"
    b = speech_bounds(x, TARGET_RATE, silent_dbfs=-62)
    assert b and (b[1] - b[0]) / TARGET_RATE == pytest.approx(2.0, abs=0.15)


@pytest.mark.parametrize("x", [np.zeros(TARGET_RATE * 2, dtype=np.float32),
                               take(TARGET_RATE, [("silence", 2.0)], noise_dbfs=-75)], ids=["zeros", "quiet-room"])
def test_no_speech_in_silence(x):
    assert speech_bounds(x, TARGET_RATE) is None


def test_pcm16_round_trip_and_the_wav_on_disk(tmp_path):
    x = pcm16(app_take([("silence", 0.3), ("speech", 1.0)]))
    assert np.array_equal(audio.decode_pcm16(x.astype("<i2").tobytes()), x)
    with pytest.raises(ValueError, match="even"):
        audio.decode_pcm16(b"\x00\x00\x00")
    path = tmp_path / "s0001.wav"
    audio.write_wav(path, x)
    info = sf.info(str(path))
    assert (info.samplerate, info.channels, info.subtype, info.format) == (16000, 1, "PCM_16", "WAV")
    back, rate = sf.read(str(path), dtype="int16")
    assert rate == 16000 and np.array_equal(back, x)
    assert not list(tmp_path.glob("*.part"))
