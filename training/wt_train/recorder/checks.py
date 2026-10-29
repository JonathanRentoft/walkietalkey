"""The checks after each take: level, clipping and silence, plus the phone's gaps.

A take is judged on the 16 kHz audio the app received (:mod:`.audio`), with
limits for its style, because a whisper is quiet by nature:

=========  ==================  =========================  ===================
style      nothing was said    said, but quiet             (level: the 97th
           (refused)           (kept, redo offered)        percentile 10 ms
                                                           frame, so a click
                                                           does not count)
=========  ==================  =========================  ===================
normal     below -50 dBFS, or  below -35 dBFS
           < 12 dB above the
           room noise
whisper    below -62 dBFS, or  below -50 dBFS
           < 8 dB above the
           room noise
=========  ==================  =========================  ===================

Measured with the phone's +15 dB gain in place: a normal voice reaches about
-20 dBFS on either device, a whisper about -40 dBFS, and a quiet office about
-60 dBFS. The room noise is the 10th percentile frame.

* **clipped** (kept, redo offered): on the Mac, 3 samples at full scale; on the
  phone, whose limiter keeps every sample under -1 dBFS (PHONE-30), 0.2 % of the
  samples pressed against that ceiling, which flattens a far too loud voice.
* **cut** (kept, redo offered; run 12): speech within 50 ms of the start or the end
  (``audiostats``), so a word may be cut: the button went down after the first word
  began, or up before the last ended. Judged only in a take :data:`CUT_MIN_SNR_DB`
  clear of its noise and not noisy, as ``wt-train check`` and Værkstedet judge it
  (:func:`cut_edges`, shared with them), so the owner hears of it right after the
  take. PROTOCOL.md 8.4 has no ``cut``: the phone is told ``short`` (session.py).
* **short** (kept, redo offered): the speech is shorter than 0.12 s per word of
  the text (and 0.4 s), so the button was probably let go too soon.
* **gaps** (refused): the phone's resend did not fill every 200 ms block
  (DESK-61); a spliced take would not match its text.
* **silent** (refused): see the table; also when no speech is found at all.

The first problem in :data:`ORDER` names the take's check; ``problems`` lists
them all. A refused take is not saved; a kept one is saved with its checks in
its metadata, and the recorder offers a redo.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from . import audio
from .. import audiostats
from ..sentences import word_count


@dataclass(frozen=True)
class Limits:
    silent_dbfs: float
    min_snr_db: float
    quiet_dbfs: float


LIMITS = {
    "normal": Limits(silent_dbfs=-50.0, min_snr_db=12.0, quiet_dbfs=-35.0),
    "whisper": Limits(silent_dbfs=-62.0, min_snr_db=8.0, quiet_dbfs=-50.0),
}
# The phone's limiter ceiling, -1 dBFS (PHONE-30).
PHONE_CEILING = 10 ** (-1 / 20)
# Within 0.1 dB of the ceiling counts as pressed against it.
_NEAR_CEILING = 10 ** (-0.1 / 20)
PHONE_CEILING_SHARE = 0.002
MAC_CLIPPED_SAMPLES = 3
LEVEL_PERCENTILE = audio.LOUD_PERCENTILE
MIN_SPEECH_S = 0.4
SECONDS_PER_WORD = 0.12
# speech_bounds counts every frame within 15 dB of the speech level as voiced: in a take less
# than this far above its noise, the noise reaches the edges and "cut" cannot be told.
CUT_MIN_SNR_DB = 15.0
# The estimated SNR (speech level over the median pause) below which a take is noisy (wt-train check).
NOISY_SNR_DB = {"normal": 15.0, "whisper": 10.0}

ORDER = ("gaps", "silent", "clipped", "cut", "quiet", "short")
REFUSED = frozenset({"gaps", "silent"})


@dataclass(frozen=True)
class CheckResult:
    check: str
    saved: bool
    problems: tuple[str, ...]
    seconds: float
    speech_seconds: float
    level_dbfs: float
    loudest_dbfs: float
    noise_dbfs: float
    peak_dbfs: float
    clipped_samples: int

    def as_dict(self) -> dict:
        d = asdict(self)
        d["problems"] = list(self.problems)
        for k, v in d.items():
            if isinstance(v, float):
                d[k] = round(v, 3 if k.endswith("seconds") else 1)
        return d


def cut_edges(stats: audiostats.AudioStats, style: str, *, silent: bool = False) -> str:
    """Where the speech touches the take's edge: ``"start"``, ``"end"``, ``"start and end"``, or
    ``""`` (none, or a take too noisy, or ``silent``, to tell)."""
    noisy = silent or stats.snr_db < NOISY_SNR_DB[style]
    if stats.silent or noisy or stats.snr_db < CUT_MIN_SNR_DB:
        return ""
    return " and ".join(edge for edge, cut in (("start", stats.cut_start), ("end", stats.cut_end)) if cut)


def check_take(samples: np.ndarray, *, style: str, device: str, text: str, missing: int = 0,
               rate: int = audio.TARGET_RATE) -> CheckResult:
    """Judge one take (16-bit samples) read in ``style`` on ``device`` (phone or mac)."""
    if style not in LIMITS:
        raise ValueError(f"unknown style {style!r}")
    limits = LIMITS[style]
    x = audio.to_float(samples)
    levels = audio.frame_levels(x, rate)
    level = float(np.percentile(levels, LEVEL_PERCENTILE))
    noise = float(np.percentile(levels, 10))
    loudest = audio.loudest_window_dbfs(x, rate)
    peak = float(np.abs(x).max(initial=0.0))
    bounds = audio.speech_bounds(x, rate, silent_dbfs=limits.silent_dbfs)
    speech = (bounds[1] - bounds[0]) / rate if bounds else 0.0

    if device == "phone":
        clipped = int(np.count_nonzero(np.abs(x) >= PHONE_CEILING * _NEAR_CEILING))
        too_hot = clipped >= max(MAC_CLIPPED_SAMPLES, PHONE_CEILING_SHARE * len(x))
    else:
        clipped = int(np.count_nonzero(np.abs(x) >= audio.CLIP_LEVEL))
        too_hot = clipped >= MAC_CLIPPED_SAMPLES

    problems = []
    if missing > 0:
        problems.append("gaps")
    if bounds is None or level < limits.silent_dbfs or level - noise < limits.min_snr_db:
        problems.append("silent")
    if too_hot:
        problems.append("clipped")
    if level < limits.quiet_dbfs:
        problems.append("quiet")
    if bounds is not None and speech < max(MIN_SPEECH_S, SECONDS_PER_WORD * word_count(text)):
        problems.append("short")
    if "silent" not in problems and cut_edges(audiostats.measure_samples(x, rate), style):
        problems.append("cut")
    problems.sort(key=ORDER.index)
    check = problems[0] if problems else "ok"
    return CheckResult(
        check=check,
        saved=check not in REFUSED,
        problems=tuple(problems),
        seconds=len(x) / rate,
        speech_seconds=speech,
        level_dbfs=level,
        loudest_dbfs=loudest,
        noise_dbfs=noise,
        peak_dbfs=float(20 * np.log10(max(peak, 1e-6))),
        clipped_samples=clipped,
    )
