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


def whisperlike(rate: int, seconds: float, rms_dbfs: float = -40.0, seed: int = 3) -> np.ndarray:
    """Whispered speech: breath noise, brighter than room noise, in syllables (no pitch)."""
    rng = np.random.default_rng(seed)
    n = int(rate * seconds)
    x = rng.standard_normal(n + 1)
    x = x[1:] - 0.9 * x[:-1]  # tilted towards the high frequencies, like breath through the teeth
    t = np.arange(n) / rate
    x = x * (0.2 + 0.8 * np.abs(np.sin(2 * np.pi * 2 * t)))
    x *= db(rms_dbfs) / np.sqrt(np.mean(x**2))
    return x.astype(np.float32)


def app_take(parts: list[tuple[str, float]], style: str = "normal", noise_dbfs: float = -60.0,
             level_dbfs: float | None = None, rate: int = 16000) -> np.ndarray:
    """A take as the app hands it over: 16 kHz float, over room noise; ("silence" | "speech",
    seconds) parts, spoken normally (about -20 dBFS) or whispered (about -40 dBFS)."""
    level = level_dbfs if level_dbfs is not None else (-20.0 if style == "normal" else -40.0)
    pieces = []
    for i, (kind, seconds) in enumerate(parts):
        piece = noise(rate, seconds, noise_dbfs, seed=20 + i)
        if kind == "speech":
            voice = (speechlike(rate, seconds, level, seed=i) if style == "normal"
                     else whisperlike(rate, seconds, level, seed=30 + i))
            piece = piece + voice
        pieces.append(piece)
    return np.concatenate(pieces).astype(np.float32)


def pcm16(x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(np.asarray(x) * 32767.0), -32768, 32767).astype(np.int16)
