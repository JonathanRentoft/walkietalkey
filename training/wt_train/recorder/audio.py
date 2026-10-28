"""Takes from the app: 16 kHz levels, where the speech is, and the WAV on disk.

The app hands over each take as 16-bit PCM, mono, 16 kHz: exactly what the model
would hear, before VAD. From the phone that is the dictation capture after its
+15 dB gain and look-ahead limiter (PHONE-30); from the Mac, the input the app
records with (AudioRecordingManager, as for a key dictation). A take is saved as
it came, untrimmed, except that a Mac take is kept from 0.3 s before the press (its
input is armed ahead of it, run 12: :mod:`.session`); :mod:`.checks` judges it.

Levels are measured on 10 ms frames (RMS in dBFS). Speech is found as in run 4's
recorder: a frame is voiced above the room noise (the 10th percentile frame)
+ 10 dB, kept between 40 and 15 dB below the loudest frames (the 97th
percentile, so one click does not set the scale; and so a take that is speech
from end to end still has speech in it); voiced runs closer than 300 ms
are joined, and runs shorter than 80 ms (a key click, a creaking chair) are
dropped.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import soundfile as sf

TARGET_RATE = 16_000
# Loudest 100 ms below this: nobody spoke (or the input is dead), for a normal voice.
SILENT_DBFS = -50.0
# Samples at or above this magnitude count as clipped.
CLIP_LEVEL = 0.999
# A take's speech level: this percentile of its 10 ms frames (a click is one frame).
LOUD_PERCENTILE = 97

_FRAME_S = 0.010
_WINDOW_S = 0.100
_ABOVE_NOISE_DB = 10.0
_MOST_BELOW_LOUDEST_DB = 40.0
_LEAST_BELOW_LOUDEST_DB = 15.0
_JOIN_GAP_S = 0.300
_MIN_RUN_S = 0.080


def decode_pcm16(body: bytes) -> np.ndarray:
    """The app's upload: little-endian 16-bit samples."""
    if len(body) % 2:
        raise ValueError("the body must be 16-bit samples (an even number of bytes)")
    return np.frombuffer(body, dtype="<i2").astype(np.int16)


def to_float(samples: np.ndarray) -> np.ndarray:
    return np.asarray(samples, dtype=np.float32) / 32768.0


def _db(power: np.ndarray | float) -> np.ndarray:
    return 10 * np.log10(np.maximum(power, 1e-12))


def frame_levels(x: np.ndarray, rate: int = TARGET_RATE) -> np.ndarray:
    """RMS level in dBFS of each 10 ms frame."""
    n = int(rate * _FRAME_S)
    frames = len(x) // n
    if frames == 0:
        return np.full(1, -120.0)
    power = (x[: frames * n].astype(np.float64) ** 2).reshape(frames, n).mean(axis=1)
    return _db(power)


def loudest_window_dbfs(x: np.ndarray, rate: int = TARGET_RATE) -> float:
    """RMS level in dBFS of the loudest 100 ms."""
    if len(x) == 0:
        return -120.0
    n = max(1, min(len(x), int(rate * _WINDOW_S)))
    power = np.convolve(x.astype(np.float64) ** 2, np.ones(n) / n, mode="valid")
    return float(_db(power.max()))


def speech_bounds(x: np.ndarray, rate: int = TARGET_RATE, silent_dbfs: float = SILENT_DBFS
                  ) -> tuple[int, int] | None:
    """Sample indices [start, end) from the first to the last word, or None."""
    levels = frame_levels(x, rate)
    # The loudest frames, not the loudest one: a single click must not set the scale.
    loudest = float(np.percentile(levels, LOUD_PERCENTILE))
    if loudest < silent_dbfs:
        return None
    noise = float(np.percentile(levels, 10))
    threshold = min(
        max(noise + _ABOVE_NOISE_DB, loudest - _MOST_BELOW_LOUDEST_DB),
        loudest - _LEAST_BELOW_LOUDEST_DB,
    )
    voiced = levels > threshold
    runs: list[list[int]] = []
    join = round(_JOIN_GAP_S / _FRAME_S)
    for i in np.flatnonzero(voiced):
        if runs and i - runs[-1][1] <= join:
            runs[-1][1] = i + 1
        else:
            runs.append([int(i), int(i) + 1])
    shortest = round(_MIN_RUN_S / _FRAME_S)
    runs = [r for r in runs if r[1] - r[0] >= shortest]
    if not runs:
        return None
    n = int(rate * _FRAME_S)
    return runs[0][0] * n, min(len(x), runs[-1][1] * n)


def write_wav(path: Path, samples: np.ndarray, rate: int = TARGET_RATE) -> None:
    """16-bit PCM mono WAV, written atomically (a crash leaves no half file)."""
    path = Path(path)
    part = path.with_name(path.name + ".part")
    sf.write(str(part), np.asarray(samples, dtype=np.int16), rate, subtype="PCM_16", format="WAV")
    os.replace(part, path)
