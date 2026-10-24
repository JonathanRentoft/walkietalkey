"""The long-form exam: ``training/data/exam.yaml``.

Six paragraphs of Danish developer talk, one to two minutes each read aloud,
with English terms in the conventions of spelling.yaml. Each is read once per
condition (``wt-train record --condition <c> --exam``) into
``recordings/exam/<condition>/``. The exam tests the whole app path, the live
chunking and its joints included (``wt-train eval --backend gguf --dataset exam
--live``); it is never trained on, and the dataset builder's leakage check keeps
it out of every split (by text, by audio and by folder).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from .paths import EXAM_YAML

EXAM_FOLDER = "exam"
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


@dataclass(frozen=True)
class Paragraph:
    id: str
    title: str
    text: str
    # The sentence list's columns, so a paragraph can stand where a sentence does.
    kind: str = "exam"


def load_exam(path: Path = EXAM_YAML) -> list[Paragraph]:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    rows = raw.get("paragraphs")
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"{path}: expected a list under 'paragraphs'")
    out, seen = [], set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"id", "title", "text"}:
            raise ValueError(f"{path}: each paragraph has exactly id, title and text: {row!r}")
        pid, title, text = (str(row[k]).strip() for k in ("id", "title", "text"))
        if not SAFE_ID.fullmatch(pid) or pid in seen:
            raise ValueError(f"{path}: paragraph id {pid!r} is not a unique plain id")
        if not text:
            raise ValueError(f"{path}: {pid} has no text")
        seen.add(pid)
        out.append(Paragraph(id=pid, title=title, text=" ".join(text.split())))
    return out
