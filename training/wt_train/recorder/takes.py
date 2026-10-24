"""The takes on disk, one per sentence, in training/data/recordings/.

For sentence ``s0042`` a take is ``s0042.wav`` (16 kHz mono 16-bit PCM) and
``s0042.txt`` (the sentence exactly as the page showed it, plus a newline).
A redo moves the previous pair into ``.replaced/`` as
``s0042.<UTC time>.wav`` and ``.txt``, so a slip never loses a take; the
dataset builder reads only the top folder.

A take counts as recorded while its ``.txt`` matches the sentence list. If the
owner edits a sentence (a spelling convention changed), the old take is
"stale" and the recorder brings him back to it.

Paths are built only from ids in the sentence list, and those must be plain
(letters, digits, ``_`` and ``-``), so nothing outside the folder is touched.
"""

from __future__ import annotations

import os
import re
import shutil
from datetime import UTC, datetime, timezone
from pathlib import Path

from ..sentences import Sentence
from .audio import Take, write_wav

SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
STATUSES = ("missing", "recorded", "stale")


class UnknownSentence(KeyError):
    """An id that is not in the sentence list."""


class Takes:
    def __init__(self, sentences: list[Sentence], folder: Path):
        for s in sentences:
            if not SAFE_ID.fullmatch(s.id):
                raise ValueError(f"sentence id {s.id!r} must be letters, digits, '_' or '-' (at most 64)")
        self.sentences = list(sentences)
        self._by_id = {s.id: s for s in self.sentences}
        self.folder = Path(folder)
        self.replaced = self.folder / ".replaced"

    def sentence(self, sentence_id: str) -> Sentence:
        try:
            return self._by_id[sentence_id]
        except KeyError:
            raise UnknownSentence(sentence_id) from None

    def wav_path(self, sentence_id: str) -> Path:
        return self.folder / f"{self.sentence(sentence_id).id}.wav"

    def txt_path(self, sentence_id: str) -> Path:
        return self.folder / f"{self.sentence(sentence_id).id}.txt"

    def status(self, sentence_id: str) -> str:
        """``missing``, ``recorded``, or ``stale`` (recorded, but the sentence changed since)."""
        wav, txt = self.wav_path(sentence_id), self.txt_path(sentence_id)
        if not wav.is_file():
            return "missing"
        try:
            shown = txt.read_text(encoding="utf-8").rstrip("\n")
        except FileNotFoundError:
            return "stale"
        return "recorded" if shown == self.sentence(sentence_id).text else "stale"

    def statuses(self) -> list[str]:
        return [self.status(s.id) for s in self.sentences]

    def first_open(self) -> int | None:
        """Index of the first sentence without a current take, or None when all are done."""
        for i, s in enumerate(self.sentences):
            if self.status(s.id) != "recorded":
                return i
        return None

    def recorded_count(self) -> int:
        return sum(status == "recorded" for status in self.statuses())

    def save(self, sentence_id: str, take: Take) -> Path:
        """Write the take and its text; an earlier take of the sentence goes to ``.replaced/``."""
        sentence = self.sentence(sentence_id)
        wav, txt = self.wav_path(sentence.id), self.txt_path(sentence.id)
        self.folder.mkdir(parents=True, exist_ok=True)
        if wav.exists() or txt.exists():
            self._keep(sentence.id, wav, txt)
        # Text first: a take only counts once its WAV is in place.
        part = txt.with_name(txt.name + ".part")
        part.write_text(sentence.text + "\n", encoding="utf-8")
        os.replace(part, txt)
        write_wav(wav, take)
        return wav

    def _keep(self, sentence_id: str, wav: Path, txt: Path) -> None:
        self.replaced.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        stem = f"{sentence_id}.{stamp}"
        n = 1
        while (self.replaced / f"{stem}.wav").exists() or (self.replaced / f"{stem}.txt").exists():
            n += 1
            stem = f"{sentence_id}.{stamp}-{n}"
        for path, suffix in ((wav, ".wav"), (txt, ".txt")):
            if path.exists():
                shutil.move(str(path), self.replaced / f"{stem}{suffix}")
