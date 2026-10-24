"""Synthetic takes for the recorder tests: room noise with speech-like sound in it."""

from __future__ import annotations

import numpy as np


def db(level_dbfs: float) -> float:
    return 10 ** (level_dbfs / 20)


def speechlike(rate: int, seconds: float, rms_dbfs: float = -18.0, seed: int = 1) -> np.ndarray:
    """A voiced, syllable-modulated signal (140 Hz with harmonics, about 4 syllables a second)."""
    t = np.arange(int(rate * seconds)) / rate
    voice = sum(np.sin(2 * np.pi * 140 * k * t + k) / k for k in range(1, 12))
    syllables = 0.35 + 0.65 * np.abs(np.sin(2 * np.pi * 2 * t))
    x = voice * syllables
    x *= db(rms_dbfs) / np.sqrt(np.mean(x**2))
    return x.astype(np.float32)


def noise(rate: int, seconds: float, rms_dbfs: float = -70.0, seed: int = 2) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(int(rate * seconds)) * db(rms_dbfs)).astype(np.float32)


def take(rate: int, parts: list[tuple[str, float]], noise_dbfs: float = -70.0, speech_dbfs: float = -18.0):
    """Concatenate ("silence" | "speech", seconds) parts over room noise."""
    pieces = []
    for i, (kind, seconds) in enumerate(parts):
        piece = noise(rate, seconds, noise_dbfs, seed=10 + i)
        if kind == "speech":
            piece = piece + speechlike(rate, seconds, speech_dbfs, seed=i)
        pieces.append(piece)
    return np.concatenate(pieces).astype(np.float32)


def rms_dbfs(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=np.float64)
    if x.dtype.kind == "i" or np.abs(x).max(initial=0) > 2:
        x = x / 32768
    return float(20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-12))
