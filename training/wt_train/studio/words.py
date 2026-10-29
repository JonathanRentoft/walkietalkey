"""Værkstedet's "Dine egne ord" (run 12): the English words of the owner's own dictations.

The app's history (``places.history_db``: ``history.db`` beside its models folder,
``WT_APP_HISTORY_DB`` or ``--history-db``) is read read-only by :mod:`wt_train.ownwords`,
which finds the words ``spelling.yaml`` does not cover. The Danish vocabulary is the plain
sentences of the sentence list, FLEURS da_dk's transcripts when they are in the work folder,
and the module's own list.

Privacy, as API.md says: the words come and go in JSON bodies only (no word is ever in a URL,
a query string, a log line, a job or an error message), nothing from the history is written
anywhere, and the analysis is kept in memory only, until the history, the spelling, the
sentences or FLEURS change. The only files written are the owner's own: the ticked words
(``<local>/own-words.yaml``) and his sentences (``<local>/sentences.csv``).
"""

from __future__ import annotations

import csv
import os
import threading
from pathlib import Path

from .. import ownwords, paths
from ..recorder.takes import write_atomic
from ..sentences import Sentence
from .places import StudioPaths
from .recording import StudioError

OWN_WORDS = "own-words.yaml"
OWN_SENTENCES = "sentences.csv"
# The list the page gets: the most often said first, at most this many.
MAX_LISTED = 300


def _stat(path: Path) -> tuple:
    try:
        s = os.stat(path)
        return (s.st_mtime_ns, s.st_size)
    except OSError:
        return (0, 0)


def fleurs_texts(root: Path) -> list[str]:
    """The raw transcripts of FLEURS da_dk (``train.tsv``, ``test.tsv``) when they are there."""
    out: list[str] = []
    for name in ("train.tsv", "test.tsv"):
        try:
            with (Path(root) / name).open(encoding="utf-8", newline="") as f:
                for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
                    if len(row) > 2:
                        out.append(row[2])
        except OSError:
            continue
    return out


class OwnWords:
    def __init__(self, places: StudioPaths):
        self.places = places
        self._lock = threading.Lock()
        self._cache: tuple[tuple, dict] | None = None

    @property
    def words_file(self) -> Path:
        return Path(self.places.local) / OWN_WORDS

    @property
    def sentences_file(self) -> Path:
        return Path(self.places.local) / OWN_SENTENCES

    # --- the analysis (in memory only) ---------------------------------------------------

    def _key(self) -> tuple:
        db = Path(self.places.history_db)
        fleurs = paths.fleurs_dir()
        return (str(db), _stat(db), _stat(db.with_name(db.name + "-wal")), _stat(self.places.spelling),
                _stat(self.places.sentences), _stat(fleurs / "train.tsv"), _stat(fleurs / "test.tsv"))

    def _vocabulary(self) -> frozenset[str]:
        from ..sentences import load_sentences

        plain: list[str] = []
        try:
            plain = [s.text for s in load_sentences(self.places.sentences) if s.kind == "plain"]
        except (OSError, ValueError):
            pass
        return ownwords.vocabulary([*plain, *fleurs_texts(paths.fleurs_dir())])

    def _spelling(self):
        from ..spelling import load_spelling

        try:
            return load_spelling(self.places.spelling)
        except (OSError, ValueError):
            return None

    def analysis(self) -> dict:
        key = self._key()
        with self._lock:
            if self._cache is not None and self._cache[0] == key:
                return self._cache[1]
        db = Path(self.places.history_db)
        try:
            texts = ownwords.read_history(db)
        except ownwords.HistoryError:
            out = {"found": True, "readable": False, "dictations": 0, "words": []}
        else:
            if texts is None:
                out = {"found": False, "readable": False, "dictations": 0, "words": []}
            else:
                result = ownwords.find(texts, self._vocabulary(), self._spelling())
                out = {"found": True, "readable": True, "dictations": result.dictations, "words": result.words}
        with self._lock:
            self._cache = (key, out)
        return out

    # --- the page --------------------------------------------------------------------------

    def _ticked(self) -> list[str]:
        try:
            return ownwords.read_own_words(self.words_file)
        except (OSError, ValueError):
            raise StudioError(409, "own-words", f"{OWN_WORDS} in the local folder cannot be read; "
                                                "fix or remove it by hand") from None

    def _sentences(self) -> list[Sentence]:
        try:
            return ownwords.read_own_sentences(self.sentences_file)
        except (OSError, ValueError):
            raise StudioError(409, "own-sentences", f"{OWN_SENTENCES} in the local folder has another header; "
                                                     "fix it by hand") from None

    def view(self) -> dict:
        a = self.analysis()
        ticked = self._ticked()
        own = self._sentences()
        found = a["words"]
        total = a["dictations"]
        by_key = {ownwords.squash(f.word): f for f in found}
        chosen = {ownwords.squash(w) for w in ticked}

        def row(f: ownwords.Found) -> dict:
            return {"word": f.word, "count": f.count, "dictations": f.dictations,
                    "share": round(f.dictations / total, 4) if total else None, "phrase": f.phrase}

        new = [row(f) for f in found if ownwords.squash(f.word) not in chosen]
        mine = []
        for w in ticked:
            f = by_key.get(ownwords.squash(w))
            mine.append({"word": w, "count": f.count if f else None, "dictations": f.dictations if f else None,
                         "share": round(f.dictations / total, 4) if f and total else None,
                         "phrase": len(w.split()) > 1,
                         "sentences": [{"id": s.id, "text": s.text} for s in own if ownwords.mentions(s.text, w)]})
        return {
            "history": {"found": a["found"], "readable": a["readable"], "path": str(self.places.history_db),
                        "dictations": total},
            "found": len(found),
            "words": new[:MAX_LISTED],
            "more": max(0, len(new) - MAX_LISTED),
            "ticked": mine,
            "files": {"words": str(self.words_file), "sentences": str(self.sentences_file)},
        }

    def tick(self, body: dict) -> dict:
        word = ownwords.clean_word(body.get("word"))
        if word is None or not isinstance(body.get("ticked"), bool):
            raise StudioError(400, "word", "name a word (a string of at most 64 characters) and ticked true or false")
        with self._lock:
            words = self._ticked()
            key = ownwords.squash(word)
            rest = [w for w in words if ownwords.squash(w) != key]
            words = rest + [word] if body["ticked"] else rest
            Path(self.places.local).mkdir(parents=True, exist_ok=True)
            write_atomic(self.words_file, ownwords.own_words_text(words))
        return self.view()

    def add_sentence(self, body: dict) -> dict:
        from ..sentences import load_sentences

        word = ownwords.clean_word(body.get("word"))
        text = body.get("text")
        if word is None or not isinstance(text, str):
            raise StudioError(400, "text", "name the word and the sentence, both as strings")
        text = " ".join(text.split())
        with self._lock:
            own = self._sentences()
            try:
                public = [s.text for s in load_sentences(self.places.sentences)]
            except (OSError, ValueError):
                public = []
            problem = ownwords.check_sentence(text, word, [*public, *(s.text for s in own)])
            if problem is not None:
                status = 409 if problem == "duplicate" else 400
                raise StudioError(status, problem, {
                    "length": f"a sentence has {ownwords.MIN_WORDS} to {ownwords.MAX_WORDS} words",
                    "dash": "a sentence has no em or en dash",
                    "no-word": "the sentence does not have the word in it",
                    "duplicate": "that sentence is in the list already",
                }[problem])
            added = Sentence(id=ownwords.next_id(own), text=text, kind=ownwords.OWN_KIND)
            Path(self.places.local).mkdir(parents=True, exist_ok=True)
            write_atomic(self.sentences_file, ownwords.sentences_text([*own, added]))
        return {"sentence": {"id": added.id, "text": added.text, "kind": added.kind}, **self.view()}
