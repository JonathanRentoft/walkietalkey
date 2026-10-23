"""Decode one speech segment per window: Silero VAD (the GGUF the app bundles,
through transcribe-cli) splits each clip at its pauses, every segment is
transcribed on its own, and the texts are joined in order.

Edda, decoded greedily, tends to stop at the first sentence boundary inside a
window (docs/MODELS.md); this mode measures what splitting at pauses recovers.
"""

from __future__ import annotations

import re
import subprocess
import wave
from pathlib import Path

_SEGMENT = re.compile(r"^\s*segment: \d+ start=(\d+) end=(\d+)", re.M)


def parse_segments(output: str) -> list[tuple[int, int]]:
    """The VAD CLI's `segment: <i> start=<sample> end=<sample>` lines."""
    return [(int(m[1]), int(m[2])) for m in _SEGMENT.finditer(output)]


def vad_segments(cli: Path, vad_model: Path, wav: Path) -> list[tuple[int, int]]:
    proc = subprocess.run([str(cli), "-q", "-m", str(vad_model), str(wav)], capture_output=True)
    return parse_segments(proc.stdout.decode("utf-8", errors="replace"))


def cut_segments(wav: Path, segments: list[tuple[int, int]], out_dir: Path, pad: int = 1600) -> list[Path]:
    """Write `<stem>-<k>.wav` per segment, widened by `pad` samples each side
    (clamped to the clip). A clip without speech is kept whole."""
    out_dir.mkdir(parents=True, exist_ok=True)
    with wave.open(str(wav)) as w:
        params = w.getparams()
        frames = w.readframes(w.getnframes())
    width = params.sampwidth * params.nchannels
    total = len(frames) // width
    spans = segments or [(0, total)]
    paths = []
    for k, (start, end) in enumerate(spans):
        a, b = max(0, start - pad), min(total, end + pad)
        path = out_dir / f"{wav.stem}-{k:03d}.wav"
        with wave.open(str(path), "wb") as o:
            o.setparams(params)
            o.writeframes(frames[a * width:b * width])
        paths.append(path)
    return paths
