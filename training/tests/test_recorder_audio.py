"""The recorder's audio processing: trim with padding, 16 kHz mono 16-bit WAV, silence, clipping."""

import numpy as np
import pytest
import soundfile as sf
from fake_audio import rms_dbfs, take
from wt_train.recorder import audio
from wt_train.recorder.audio import PADDING_S, TARGET_RATE, SilentTake, process

PAD = PADDING_S


def seconds(t) -> float:
    return len(t.samples) / TARGET_RATE


def test_padding_is_150_to_200_ms():
    assert 0.150 <= PAD <= 0.200


@pytest.mark.parametrize("rate", [48000, 44100, 16000])
def test_trims_leading_and_trailing_silence_and_keeps_the_padding(rate):
    x = take(rate, [("silence", 0.8), ("speech", 1.5), ("silence", 0.6)])
    t = process(x, rate)
    assert t.rate == TARGET_RATE
    assert seconds(t) == pytest.approx(1.5 + 2 * PAD, abs=0.04)
    # The padding is the room before the speech, the speech starts after it.
    head = t.samples[: int(0.10 * TARGET_RATE)]
    assert rms_dbfs(head) < -55
    voiced = t.samples[int((PAD + 0.05) * TARGET_RATE) : int((PAD + 0.25) * TARGET_RATE)]
    assert rms_dbfs(voiced) > -30
    assert t.speech_s == pytest.approx(1.5, abs=0.04)


def test_padding_is_cut_short_at_the_edges():
    x = take(48000, [("silence", 0.05), ("speech", 1.0), ("silence", 0.05)])
    assert seconds(process(x, 48000)) == pytest.approx(1.1, abs=0.03)


def test_a_pause_inside_the_sentence_is_kept():
    x = take(48000, [("silence", 0.5), ("speech", 0.6), ("silence", 0.5), ("speech", 0.6), ("silence", 0.5)])
    assert seconds(process(x, 48000)) == pytest.approx(1.7 + 2 * PAD, abs=0.04)


def test_a_key_click_before_the_speech_is_not_speech():
    rate = 48000
    x = take(rate, [("silence", 1.0), ("speech", 1.5), ("silence", 1.0)])
    click = slice(int(0.15 * rate), int(0.165 * rate))
    x[click] = 0.9 * np.sign(np.sin(np.arange(click.stop - click.start)))
    x[int(3.2 * rate) : int(3.21 * rate)] = 0.8  # and one after
    assert seconds(process(x, rate)) == pytest.approx(1.5 + 2 * PAD, abs=0.04)


def test_resamples_to_16_khz_without_moving_the_pitch():
    rate = 44100
    t_ = np.arange(int(rate * 2.0)) / rate
    x = (0.3 * np.sin(2 * np.pi * 1000 * t_)).astype(np.float32)
    out = process(x, rate).samples.astype(np.float64)
    spectrum = np.abs(np.fft.rfft(out * np.hanning(len(out))))
    peak_hz = np.argmax(spectrum) * TARGET_RATE / len(out)
    assert peak_hz == pytest.approx(1000, abs=5)
    assert seconds(process(x, rate)) == pytest.approx(2.0, abs=0.01)


def test_writes_a_16_bit_mono_16_khz_wav(tmp_path):
    t = process(take(48000, [("silence", 0.5), ("speech", 1.0), ("silence", 0.5)]), 48000)
    path = tmp_path / "s0001.wav"
    audio.write_wav(path, t)
    info = sf.info(str(path))
    assert (info.samplerate, info.channels, info.subtype, info.format) == (16000, 1, "PCM_16", "WAV")
    back, rate = sf.read(str(path), dtype="int16")
    assert rate == 16000 and np.array_equal(back, t.samples)
    assert t.samples.dtype == np.int16


@pytest.mark.parametrize(
    "x",
    [
        np.zeros(48000 * 2, dtype=np.float32),  # a dead input: digital silence
        take(48000, [("silence", 2.0)], noise_dbfs=-75),  # nothing but a quiet room
        take(48000, [("silence", 2.0)], noise_dbfs=-58),  # a noisy room, still nobody talking
    ],
    ids=["digital-silence", "quiet-room", "noisy-room"],
)
def test_a_silent_take_is_refused(x):
    with pytest.raises(SilentTake):
        process(x, 48000)


def test_a_short_sound_alone_is_refused():
    x = take(48000, [("silence", 1.0)])
    x[24000:24480] = 0.7  # 10 ms: a click, not a sentence
    with pytest.raises(SilentTake):
        process(x, 48000)


def test_clipping_is_flagged():
    x = take(48000, [("silence", 0.5), ("speech", 1.0), ("silence", 0.5)], speech_dbfs=-3)
    clipped = np.clip(x * 2.5, -1.0, 1.0)
    t = process(clipped, 48000)
    assert t.clipped and "clipping" in t.warnings
    assert not process(x * 0.5, 48000).clipped


def test_a_quiet_take_is_kept_with_a_warning():
    t = process(take(48000, [("silence", 0.5), ("speech", 1.0), ("silence", 0.5)], speech_dbfs=-42), 48000)
    assert "quiet" in t.warnings
    assert "quiet" not in process(take(48000, [("silence", 0.5), ("speech", 1.0)]), 48000).warnings


def test_peak_level_is_reported():
    t = process(take(48000, [("silence", 0.5), ("speech", 1.0), ("silence", 0.5)]), 48000)
    assert -20 < t.peak_dbfs < 0


def test_decodes_little_endian_float32():
    x = np.array([0.0, 0.5, -0.25], dtype="<f4")
    assert np.array_equal(audio.decode_float32(x.tobytes()), x)
    with pytest.raises(ValueError, match="multiple of 4"):
        audio.decode_float32(b"\x00\x00\x00")
    with pytest.raises(ValueError, match="finite"):
        audio.decode_float32(np.array([np.nan], dtype="<f4").tobytes())


@pytest.mark.parametrize("rate", [0, 7999, 400000])
def test_rejects_unusable_sample_rates(rate):
    with pytest.raises(ValueError, match="rate"):
        process(np.zeros(1000, dtype=np.float32), rate)
