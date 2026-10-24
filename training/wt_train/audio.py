"""Reading clips: 16 kHz mono audio, its length and a hash of its content.

The content hash is over the decoded 16-bit samples, not the file bytes, so the
same audio saved with a different WAV header is still recognised as the same
audio (the dataset builder's leakage check and the encoder cache both use it).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

SAMPLE_RATE = 16000


@dataclass(frozen=True)
class AudioInfo:
    rate: int
    channels: int
    frames: int

    @property
    def seconds(self) -> float:
        return self.frames / self.rate if self.rate else 0.0

    @property
    def is_16k_mono(self) -> bool:
        return self.rate == SAMPLE_RATE and self.channels == 1


def info(path: Path) -> AudioInfo:
    i = sf.info(str(path))
    return AudioInfo(rate=int(i.samplerate), channels=int(i.channels), frames=int(i.frames))


def read_16k_mono(path: Path) -> np.ndarray:
    """float32 samples at 16 kHz; other rates are resampled, channels averaged."""
    pcm, rate = sf.read(str(path), dtype="float32", always_2d=True)
    pcm = pcm.mean(axis=1)
    if rate != SAMPLE_RATE:
        import soxr

        pcm = soxr.resample(pcm, rate, SAMPLE_RATE, quality="HQ")
    return np.ascontiguousarray(pcm, dtype=np.float32)


def content_sha256(path: Path) -> str:
    """SHA-256 of the decoded 16-bit samples (channels interleaved)."""
    pcm, _ = sf.read(str(path), dtype="int16", always_2d=True)
    return hashlib.sha256(b"pcm16:" + np.ascontiguousarray(pcm).tobytes()).hexdigest()


def file_sha256(path: Path, chunk: int = 1 << 22) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()
