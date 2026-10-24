"""Reading clips: 16 kHz mono audio, its length and a hash of its content.

The content hash is over the decoded samples as float32, not the file bytes, so
the same audio saved with a different WAV header is still recognised as the
same audio (the dataset builder's leakage check and the encoder cache both use
it). float32 holds 16-bit PCM exactly, and FLEURS ships 32-bit float WAV, which
libsndfile would truncate to zeros if read as int16 without scaling.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

SAMPLE_RATE = 16000
# Names the content hash; files that store hashes carry it, so a change of scheme
# never mixes old and new hashes.
CONTENT_HASH_SCHEME = "pcm-f32"


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
    """SHA-256 of the decoded float32 samples (channels interleaved) and the rate."""
    pcm, rate = sf.read(str(path), dtype="float32", always_2d=True)
    head = f"{CONTENT_HASH_SCHEME}:{rate}:{pcm.shape[1]}:".encode()
    return hashlib.sha256(head + np.ascontiguousarray(pcm).tobytes()).hexdigest()


def is_pcm16_16k_mono(path: Path) -> bool:
    i = sf.info(str(path))
    return i.samplerate == SAMPLE_RATE and i.channels == 1 and i.subtype == "PCM_16"


def pcm16_copy(path: Path, cache: Path) -> Path:
    """``path`` itself when it is 16 kHz mono 16-bit PCM WAV (what the app reads),
    otherwise a converted copy in ``cache``, made once per source file version."""
    path = Path(path)
    if is_pcm16_16k_mono(path):
        return path
    stat = path.stat()
    key = hashlib.sha256(f"{path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()[:24]
    out = Path(cache) / f"{path.stem}-{key}.wav"
    if not out.is_file():
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(f".{out.name}.tmp.wav")
        sf.write(str(tmp), read_16k_mono(path), SAMPLE_RATE, subtype="PCM_16")
        tmp.replace(out)
    return out


def file_sha256(path: Path, chunk: int = 1 << 22) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()
