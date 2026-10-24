"""FLEURS da_dk (google/fleurs, CC BY 4.0): plain Danish read speech.

* **train** is rehearsal data: mixed into training so the model keeps its plain
  Danish while it learns the English terms. Edda itself was trained on it, so
  it is in-domain and teaches nothing new by itself.
* **test** (930 clips) is the regression check. It is held out from Edda's
  training and must never enter ours; ``wt-train build`` fails if it does.

``wt-train fetch`` downloads both at the revision models/eval pins, into the
layout models/eval/fetch_fleurs.sh uses (``<split>.tsv`` and ``<split>/*.wav``,
16 kHz mono), so a test split fetched by either tool serves both. The archive
is deleted after unpacking unless ``--keep-archive``.

The TSV columns are: sentence id, file name, raw transcription (cased and
punctuated, used as the text), normalised transcription, characters, number of
samples, gender. Several speakers read the same sentence; their rows share the
sentence id.
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
import tarfile
from dataclasses import dataclass
from pathlib import Path

from . import paths
from .hub import download_file

SPLITS = ("train", "test")
# fetch_fleurs.sh marks a complete test split with ".complete"; keep that name.
_MARKERS = {"test": ".complete", "train": ".complete-train"}


@dataclass(frozen=True)
class FleursClip:
    id: str
    wav: Path
    text: str
    sentence_id: str
    split: str
    seconds: float


def _root(root: Path | None) -> Path:
    return Path(root) if root is not None else paths.fleurs_dir()


def is_ready(split: str, root: Path | None = None) -> bool:
    return (_root(root) / _MARKERS[split]).is_file()


def load_split(split: str, root: Path | None = None) -> list[FleursClip]:
    """Every clip of a fetched split, sorted by id. Ids match models/eval's."""
    if split not in SPLITS:
        raise ValueError(f"unknown FLEURS split {split!r}, expected one of {SPLITS}")
    root = _root(root)
    tsv = root / f"{split}.tsv"
    if not tsv.is_file():
        raise FileNotFoundError(f"{tsv} is missing; run: wt-train fetch --split {split}")
    clips, missing = [], []
    with tsv.open(encoding="utf-8", newline="") as f:
        for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if len(row) < 6:
                continue
            wav = root / split / row[1]
            if not wav.is_file():
                missing.append(row[1])
                continue
            clips.append(FleursClip(
                id=f"fleurs-da_dk-{Path(row[1]).stem}",
                wav=wav,
                text=row[2].strip(),
                sentence_id=row[0].strip(),
                split=split,
                seconds=int(row[5]) / 16000,
            ))
    if missing:
        raise FileNotFoundError(
            f"{len(missing)} FLEURS {split} files listed in {tsv} are missing "
            f"(first: {missing[0]}); delete {root / _MARKERS[split]} and fetch again")
    clips.sort(key=lambda c: c.id)
    return clips


def fetch(split: str, root: Path | None = None, *, keep_archive: bool = False,
          download=download_file) -> Path:
    """Download and unpack one split unless it is already there."""
    root = _root(root)
    if is_ready(split, root):
        return root
    raw = root.parent / "fleurs-raw"
    common = dict(repo_type="dataset", revision=paths.FLEURS_REVISION, local_dir=raw)
    tsv = download(paths.FLEURS_REPO, f"data/da_dk/{split}.tsv", **common)
    archive = download(paths.FLEURS_REPO, f"data/da_dk/audio/{split}.tar.gz", **common)
    root.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(tsv, root / f"{split}.tsv")
    with tarfile.open(archive) as tar:
        # The "data" filter refuses absolute paths, links out of the folder and devices.
        tar.extractall(root, filter="data")
    load_split(split, root)  # every listed file must now be there
    (root / _MARKERS[split]).touch()
    if not keep_archive:
        Path(archive).unlink(missing_ok=True)
    return root


def ensure(split: str, root: Path | None = None) -> Path:
    return fetch(split, root)


def _folder_bytes(folder: Path) -> int:
    return sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train fetch", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--split", choices=[*SPLITS, "all"], default="all")
    p.add_argument("--keep-archive", action="store_true", help="keep the downloaded .tar.gz")
    a = p.parse_args(argv)
    root = paths.fleurs_dir()
    for split in SPLITS if a.split == "all" else (a.split,):
        fetch(split, root, keep_archive=a.keep_archive)
        clips = load_split(split, root)
        hours = sum(c.seconds for c in clips) / 3600
        size = _folder_bytes(root / split) / 1e9
        print(f"FLEURS da_dk {split}: {len(clips)} clips, {hours:.1f} h, {size:.2f} GB in {root / split}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
