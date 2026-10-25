"""What a recording sounds like, in numbers (run 7): for the pilot report, which
compares recording setups, and ``wt-train check``, which looks over a session.

Per clip, from the WAV as saved (any rate, any sample format):

* ``level_dbfs``  the speech level: the 97th percentile 10 ms frame, the
  recorder's own measure (``recorder/audio.py``), so a click does not count;
* ``peak_dbfs``   the loudest sample;
* ``noise_dbfs``  the room in the pauses: the median frame outside the speech
  (before the first word, after the last, and in gaps), or the 10th percentile
  frame when there is no pause to measure;
* ``snr_db``      level minus noise, an estimate of the signal-to-noise ratio;
* ``clipped_samples``  samples at or above 0.999 of full scale;
* ``seconds``, ``speech_seconds``  the take and the part from the first to the
  last word;
* ``silent``      no speech found at all;
* ``cut_start``, ``cut_end``  speech within 50 ms of the edge: the button went
  down late or up early, so a word may be cut.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import median

import numpy as np
import soundfile as sf

from .recorder.audio import CLIP_LEVEL, LOUD_PERCENTILE, frame_levels, speech_bounds

FRAME_S = 0.010
EDGE_S = 0.050


@dataclass(frozen=True)
class AudioStats:
    seconds: float
    speech_seconds: float
    level_dbfs: float
    peak_dbfs: float
    noise_dbfs: float
    snr_db: float
    clipped_samples: int
    silent: bool
    cut_start: bool
    cut_end: bool

    def as_dict(self) -> dict:
        return asdict(self)


def _db(x: float) -> float:
    return float(20 * np.log10(max(x, 1e-6)))


def measure_samples(x: np.ndarray, rate: int) -> AudioStats:
    """The stats of float samples (-1 to 1) at ``rate``; values rounded to 0.1 dB, so
    ``snr_db`` is exactly ``level_dbfs - noise_dbfs``."""
    x = np.asarray(x, dtype=np.float32)
    if x.ndim > 1:
        x = x.mean(axis=1)
    seconds = len(x) / rate if rate else 0.0
    levels = frame_levels(x, rate)
    level = round(float(np.percentile(levels, LOUD_PERCENTILE)), 1)
    peak = _db(float(np.abs(x).max())) if len(x) else -120.0
    clipped = int((np.abs(x) >= CLIP_LEVEL).sum())
    bounds = speech_bounds(x, rate)
    if bounds is None:
        noise = round(float(np.percentile(levels, 10)), 1)
        return AudioStats(round(seconds, 3), 0.0, round(level, 1), round(peak, 1), round(noise, 1),
                          round(level - noise, 1), clipped, True, False, False)
    start, end = bounds
    frame = int(rate * FRAME_S)
    voiced = np.zeros(len(levels), dtype=bool)
    voiced[start // frame:max(start // frame + 1, end // frame)] = True
    threshold = level - 15.0
    pauses = levels[(~voiced) | (levels < threshold - 10.0)]
    noise = round(float(np.median(pauses)) if len(pauses) >= 5 else float(np.percentile(levels, 10)), 1)
    edge = int(rate * EDGE_S)
    return AudioStats(
        seconds=round(seconds, 3), speech_seconds=round((end - start) / rate, 3), level_dbfs=round(level, 1),
        peak_dbfs=round(peak, 1), noise_dbfs=round(noise, 1), snr_db=round(level - noise, 1),
        clipped_samples=clipped, silent=False, cut_start=start < edge, cut_end=end > len(x) - edge)


def measure(path: Path) -> AudioStats:
    x, rate = sf.read(str(path), dtype="float32", always_2d=False)
    return measure_samples(x, rate)


def summarize(stats: list[AudioStats]) -> dict:
    """A group of takes (one setup, one session): medians of the levels, counts of the problems."""
    if not stats:
        return {"clips": 0}
    heard = [s for s in stats if not s.silent] or stats
    return {
        "clips": len(stats),
        "level_dbfs": round(median(s.level_dbfs for s in heard), 1),
        "peak_dbfs": round(max(s.peak_dbfs for s in stats), 1),
        "noise_dbfs": round(median(s.noise_dbfs for s in heard), 1),
        "snr_db": round(median(s.snr_db for s in heard), 1),
        "clipped_clips": sum(s.clipped_samples > 0 for s in stats),
        "silent_clips": sum(s.silent for s in stats),
        "cut_clips": sum(s.cut_start or s.cut_end for s in stats),
        "seconds": round(sum(s.seconds for s in stats), 1),
        "speech_seconds": round(sum(s.speech_seconds for s in stats), 1),
    }
