"""Test clips: FLEURS da_dk test (CC BY 4.0) or a folder of the owner's own
wav + txt pairs (kept outside the repository; spec 15.1)."""

from __future__ import annotations

import csv
import struct
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Clip:
    id: str
    wav: Path
    reference: str
    seconds: float


@dataclass(frozen=True)
class WavInfo:
    format: int  # 1 = PCM integer, 3 = IEEE float, 0xFFFE = extensible
    channels: int
    rate: int
    bits: int
    frames: int

    @property
    def seconds(self) -> float:
        return self.frames / self.rate if self.rate else 0.0


def wav_info(path: Path) -> WavInfo:
    """Read the RIFF fmt and data chunk headers (no audio decoding)."""
    with path.open("rb") as f:
        head = f.read(12)
        if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise ValueError(f"not a WAV file: {path}")
        fmt = None
        while True:
            chunk = f.read(8)
            if len(chunk) < 8:
                raise ValueError(f"no data chunk in {path}")
            cid, size = chunk[:4], struct.unpack("<I", chunk[4:])[0]
            if cid == b"fmt ":
                body = f.read(size)
                fmt = struct.unpack("<HHIIHH", body[:16])
            elif cid == b"data":
                if fmt is None:
                    raise ValueError(f"data before fmt in {path}")
                tag, channels, rate, _, block, bits = fmt
                return WavInfo(tag, channels, rate, bits, size // block if block else 0)
            else:
                f.seek(size + (size & 1), 1)
            if cid == b"fmt " and size & 1:
                f.seek(1, 1)


def _spread(items: list, limit: int | None) -> list:
    """Deterministic, evenly spread subset: every (len/limit)-th item."""
    if not limit or limit >= len(items):
        return items
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def load_fleurs(fleurs_dir: Path, limit: int | None = None) -> list[Clip]:
    """FLEURS test.tsv columns: id, file, raw transcription, normalised
    transcription, characters, num_samples, gender. The raw (cased,
    punctuated) transcription is the reference; WER normalises both sides."""
    fleurs_dir = Path(fleurs_dir)
    clips = []
    with (fleurs_dir / "test.tsv").open(encoding="utf-8", newline="") as f:
        for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if len(row) < 6:
                continue
            name = row[1]
            clips.append(Clip(
                id=f"fleurs-da_dk-{Path(name).stem}",
                wav=fleurs_dir / "test" / name,
                reference=row[2].strip(),
                seconds=int(row[5]) / 16000,
            ))
    clips.sort(key=lambda c: c.id)
    return _spread(clips, limit)


def load_clips_dir(folder: Path, limit: int | None = None) -> list[Clip]:
    """Every <name>.wav with a <name>.txt next to it (UTF-8 reference text)."""
    folder = Path(folder).resolve()
    if folder == REPO_ROOT or REPO_ROOT in folder.parents:
        raise ValueError(f"--clips-dir must be outside the repository (got {folder})")
    clips = []
    for wav in sorted(folder.glob("*.wav")):
        txt = wav.with_suffix(".txt")
        if not txt.is_file():
            continue
        clips.append(Clip(
            id=wav.stem,
            wav=wav,
            reference=txt.read_text(encoding="utf-8").strip(),
            seconds=wav_info(wav).seconds,
        ))
    return _spread(clips, limit)
