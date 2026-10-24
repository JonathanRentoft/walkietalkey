"""Turn a raw browser take into a training clip: trim, resample, check, write.

The page sends the microphone's samples as they came (mono float32 at the
browser's sample rate, no echo cancellation, noise suppression or automatic
gain). :func:`process` makes the clip the dataset builder reads:

1. Clipping is counted on the raw samples (resampling would smear it).
2. The take is resampled to 16 kHz with soxr.
3. Speech is found from 10 ms frame levels: a frame is voiced above the room
   noise (the 10th percentile frame) + 10 dB, kept between 40 and 15 dB below
   the loudest frame (so a take that is speech from end to end still has
   speech in it); voiced runs closer than 300 ms are joined, and runs shorter
   than 80 ms (a key click, a creaking chair) are dropped.
4. Leading and trailing silence is trimmed to :data:`PADDING_S` of room on
   each side; a take with no speech left is refused (:class:`SilentTake`).
5. The clip is written as 16-bit PCM mono WAV.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

TARGET_RATE = 16_000
# Room kept before the first and after the last word.
PADDING_S = 0.175
MIN_RATE, MAX_RATE = 8_000, 192_000

_FRAME_S = 0.010
_WINDOW_S = 0.100
# Loudest 100 ms below this: nobody spoke (or the input is dead).
SILENT_DBFS = -50.0
# Loudest 100 ms below this: kept, but the input level is low.
QUIET_DBFS = -35.0
_ABOVE_NOISE_DB = 10.0
_MOST_BELOW_LOUDEST_DB = 40.0
_LEAST_BELOW_LOUDEST_DB = 15.0
_JOIN_GAP_S = 0.300
_MIN_RUN_S = 0.080
# Samples at or above this magnitude count as clipped; a few make a warning.
CLIP_LEVEL = 0.999
_CLIPPED_SAMPLES = 3


class SilentTake(ValueError):
    """The take has no speech in it (digital silence, a dead input, or nobody spoke)."""


@dataclass
class Take:
    """A processed take: 16-bit samples at :data:`TARGET_RATE`, and what was found."""

    samples: np.ndarray
    rate: int
    speech_s: float
    peak_dbfs: float
    loudest_dbfs: float
    clipped: bool
    warnings: list[str] = field(default_factory=list)

    @property
    def seconds(self) -> float:
        return len(self.samples) / self.rate


def decode_float32(body: bytes) -> np.ndarray:
    """The page's upload: little-endian float32 samples."""
    if len(body) % 4:
        raise ValueError("the body must be float32 samples (a multiple of 4 bytes)")
    x = np.frombuffer(body, dtype="<f4").astype(np.float32)
    if not np.all(np.isfinite(x)):
        raise ValueError("the samples must be finite numbers")
    return x


def _db(power: np.ndarray | float) -> np.ndarray:
    return 10 * np.log10(np.maximum(power, 1e-12))


def _frame_levels(x: np.ndarray, rate: int) -> np.ndarray:
    """RMS level in dBFS of each 10 ms frame."""
    n = int(rate * _FRAME_S)
    frames = len(x) // n
    if frames == 0:
        return np.full(1, -120.0)
    power = (x[: frames * n].astype(np.float64) ** 2).reshape(frames, n).mean(axis=1)
    return _db(power)


def _loudest_window_dbfs(x: np.ndarray, rate: int) -> float:
    """RMS level in dBFS of the loudest 100 ms."""
    n = max(1, min(len(x), int(rate * _WINDOW_S)))
    if len(x) == 0:
        return -120.0
    power = np.convolve(x.astype(np.float64) ** 2, np.ones(n) / n, mode="valid")
    return float(_db(power.max()))


def speech_bounds(x: np.ndarray, rate: int) -> tuple[int, int] | None:
    """Sample indices [start, end) from the first to the last word, or None."""
    if _loudest_window_dbfs(x, rate) < SILENT_DBFS:
        return None
    levels = _frame_levels(x, rate)
    noise = float(np.percentile(levels, 10))
    loudest = float(levels.max())
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


def process(x: np.ndarray, rate: int) -> Take:
    """Trim, resample to 16 kHz and check one take (see the module docstring)."""
    if not MIN_RATE <= rate <= MAX_RATE:
        raise ValueError(f"sample rate {rate} is outside {MIN_RATE}-{MAX_RATE} Hz")
    x = np.asarray(x, dtype=np.float32).reshape(-1)
    clipped = int(np.count_nonzero(np.abs(x) >= CLIP_LEVEL)) >= _CLIPPED_SAMPLES
    y = x if rate == TARGET_RATE else soxr.resample(x, rate, TARGET_RATE, quality="VHQ").astype(np.float32)
    bounds = speech_bounds(y, TARGET_RATE)
    if bounds is None:
        raise SilentTake("no speech in the take")
    pad = int(PADDING_S * TARGET_RATE)
    start, end = max(0, bounds[0] - pad), min(len(y), bounds[1] + pad)
    clip = y[start:end]
    loudest = _loudest_window_dbfs(clip, TARGET_RATE)
    peak = float(np.abs(clip).max())
    warnings = []
    if clipped:
        warnings.append("clipping")
    if loudest < QUIET_DBFS:
        warnings.append("quiet")
    samples = np.clip(np.round(clip * 32767.0), -32768, 32767).astype(np.int16)
    return Take(
        samples=samples,
        rate=TARGET_RATE,
        speech_s=(bounds[1] - bounds[0]) / TARGET_RATE,
        peak_dbfs=float(20 * np.log10(max(peak, 1e-6))),
        loudest_dbfs=loudest,
        clipped=clipped,
        warnings=warnings,
    )


def write_wav(path: Path, take: Take) -> None:
    """Write ``take`` as 16-bit PCM mono WAV, atomically (a crash leaves no half file)."""
    path = Path(path)
    part = path.with_name(path.name + ".part")
    sf.write(str(part), take.samples, take.rate, subtype="PCM_16", format="WAV")
    os.replace(part, path)
