"""The audio content hash tells clips apart in every WAV format FLEURS and the recorder use."""

import numpy as np
import soundfile as sf

from wt_train import audio


def test_float_wavs_with_quiet_audio_hash_apart(tmp_path):
    # FLEURS ships 32-bit float WAV with peaks around 0.01 to 0.1. Read as int16
    # without scaling, libsndfile returns zeros, and equal-length clips collided.
    rng = np.random.default_rng(0)
    paths = []
    for i in range(2):
        path = tmp_path / f"{i}.wav"
        sf.write(str(path), (rng.standard_normal(16000) * 0.01).astype(np.float32), 16000, subtype="FLOAT")
        paths.append(path)
    assert audio.content_sha256(paths[0]) != audio.content_sha256(paths[1])


def test_the_same_samples_hash_alike_in_pcm16_and_float(tmp_path):
    pcm = (np.random.default_rng(1).integers(-2000, 2000, 8000)).astype(np.int16)
    sf.write(str(tmp_path / "a.wav"), pcm, 16000, subtype="PCM_16")
    sf.write(str(tmp_path / "b.wav"), pcm.astype(np.float32) / 32768, 16000, subtype="FLOAT")
    assert audio.content_sha256(tmp_path / "a.wav") == audio.content_sha256(tmp_path / "b.wav")


def test_pcm16_copies_are_made_once_and_only_when_needed(tmp_path):
    pcm16 = tmp_path / "a.wav"
    sf.write(str(pcm16), np.zeros(1600, dtype=np.int16), 16000, subtype="PCM_16")
    assert audio.pcm16_copy(pcm16, tmp_path / "cache") == pcm16
    flt = tmp_path / "f.wav"
    sf.write(str(flt), (np.random.default_rng(3).standard_normal(1600) * 0.05).astype(np.float32), 16000,
             subtype="FLOAT")
    copy = audio.pcm16_copy(flt, tmp_path / "cache")
    assert copy.parent == tmp_path / "cache" and audio.is_pcm16_16k_mono(copy)
    assert audio.content_sha256(copy) != audio.content_sha256(pcm16)
    mtime = copy.stat().st_mtime_ns
    assert audio.pcm16_copy(flt, tmp_path / "cache") == copy and copy.stat().st_mtime_ns == mtime


def test_read_16k_mono_resamples_and_mixes_down(tmp_path):
    stereo = np.random.default_rng(2).standard_normal((44100, 2)).astype(np.float32) * 0.1
    sf.write(str(tmp_path / "s.wav"), stereo, 44100, subtype="PCM_16")
    out = audio.read_16k_mono(tmp_path / "s.wav")
    assert out.dtype == np.float32 and out.ndim == 1 and abs(len(out) - 16000) <= 1
    info = audio.info(tmp_path / "s.wav")
    assert not info.is_16k_mono and info.seconds == 1.0
