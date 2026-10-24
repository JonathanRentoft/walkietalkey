"""The sentences the owner reads aloud: ``training/data/sentences.csv``.

Columns ``id,text,kind``. ``kind`` is ``terms`` for Danish with English
developer terms in it, or ``plain`` for plain Danish.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

from .paths import SENTENCES_CSV

KINDS = ("terms", "plain")
COLUMNS = ["id", "text", "kind"]


@dataclass(frozen=True)
class Sentence:
    id: str
    text: str
    kind: str


def word_count(text: str) -> int:
    """Words as a reader counts them: runs of non-space characters."""
    return len(text.split())


def load_sentences(path: Path = SENTENCES_CSV) -> list[Sentence]:
    """Read and check the sentence list: the header, unique ids and known kinds."""
    with Path(path).open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != COLUMNS:
            raise ValueError(f"{path}: header must be {','.join(COLUMNS)}, got {reader.fieldnames}")
        sentences = [
            Sentence(id=row["id"].strip(), text=row["text"].strip(), kind=row["kind"].strip())
            for row in reader
        ]
    seen: set[str] = set()
    for s in sentences:
        if not s.id or not s.text:
            raise ValueError(f"{path}: empty id or text in {s}")
        if s.id in seen:
            raise ValueError(f"{path}: duplicate id {s.id}")
        if s.kind not in KINDS:
            raise ValueError(f"{path}: {s.id} has kind {s.kind!r}, expected one of {KINDS}")
        seen.add(s.id)
    return sentences
