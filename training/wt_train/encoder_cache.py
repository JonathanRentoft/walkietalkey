"""Frozen-encoder outputs, computed once and kept on disk.

With the encoder frozen, its output for a clip never changes, so it is computed
once and training runs only the decoder. With the top N encoder layers adapted,
the output of the frozen layers below them is cached instead, and the top N
layers run every step.

Each entry is one ``.npy`` file (float16, [1500, 1280] for Edda: 3.84 MB per
clip) under ``<work>/cache/encoder/``, named by a SHA-256 over everything that
decides its content: the clip's audio content hash, the base model and its
revision, the feature-extractor settings, how many encoder layers were run
(and whether the final layer norm was), and the dtype it is stored in. A clip
shared by two experiments, or two runs of one, is computed once.

The frozen part is computed in float16 on the Apple GPU (Edda's own weights are
float16) or in float32 on the CPU, and stored as float16.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import numpy as np

from .dataset import Item


@dataclass(frozen=True)
class CacheSpec:
    model: str
    revision: str
    features: dict
    layers: int
    total_layers: int
    dtype: str = "float16"

    @property
    def final(self) -> bool:
        """True when the entry is the encoder's full output (after its layer norm)."""
        return self.layers == self.total_layers

    def key(self, audio_sha256: str) -> str:
        blob = json.dumps({"audio": audio_sha256, "model": self.model, "revision": self.revision,
                           "features": self.features, "layers": self.layers,
                           "total_layers": self.total_layers, "dtype": self.dtype}, sort_keys=True)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class EncoderCache:
    def __init__(self, root: Path, spec: CacheSpec):
        self.root = Path(root)
        self.spec = spec

    def path(self, item: Item) -> Path:
        key = self.spec.key(item.audio_sha256)
        return self.root / key[:2] / f"{key}.npy"

    def missing(self, items: Iterable[Item]) -> list[Item]:
        seen, out = set(), []
        for item in items:
            p = self.path(item)
            if p not in seen and not p.is_file():
                out.append(item)
            seen.add(p)
        return out

    def fill(self, items: list[Item], compute: Callable[[list[Item]], np.ndarray], batch_size: int,
             progress: Callable[[int, int], None] | None = None) -> list[Path]:
        """Compute and store every missing entry; returns the files it created."""
        todo = self.missing(items)
        created = []
        for start in range(0, len(todo), batch_size):
            batch = todo[start:start + batch_size]
            outputs = compute(batch)
            for item, out in zip(batch, outputs):
                path = self.path(item)
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_name(f".{path.name}.tmp.npy")
                np.save(tmp, np.asarray(out, dtype=np.float16))
                os.replace(tmp, path)
                created.append(path)
            if progress:
                progress(min(start + batch_size, len(todo)), len(todo))
        return created

    def load(self, items: list[Item]) -> np.ndarray:
        return np.stack([np.load(self.path(i)) for i in items])

    @staticmethod
    def bytes_of(files: Iterable[Path]) -> int:
        return sum(Path(f).stat().st_size for f in files if Path(f).is_file())
