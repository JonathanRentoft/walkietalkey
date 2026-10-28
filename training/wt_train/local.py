"""The owner's own words and sentences (run 12): personal, local, never committed.

They live in ``training/data/local/`` (git-ignored; ``paths.local_dir()``, ``WT_LOCAL_DIR``
for another folder, which the tests always set to an empty temporary one). Værkstedet's
screen writes both files; either may be missing.

``own-words.yaml``
    ``words: [Grafana, Terraform, ...]``, each written as it is said. The dataset builder and
    the evaluation (and its report page) add each word as a term with that one form
    (:func:`with_own_words`), so a take that says "Grafana" is scored on it; a word that
    spelling.yaml already has, as a form or under ``also``, or that is listed twice (case does
    not count) is left out. The split is dealt with spelling.yaml alone, so the committed
    split record never depends on this file, and the tests of the public data never read it.

``sentences.csv``
    ``id,text,kind`` like ``training/data/sentences.csv``, ids ``own-0001``, ``own-0002``, ...
    The recorder (``wt-train record`` and Værkstedet) offers them with the list, and the
    dataset builder reads them on top of it. They go to train or validation only, never to
    test, so the frozen test set stays the same public sentences for everyone; their plan and
    split (``plan.csv``, ``mix.yaml``, ``splits.csv``, ``split.yaml``) live beside them in this
    folder, never in the committed files. An own sentence equal to a sentence of the list, the
    pilot, the exam or FLEURS test is refused by the build's leakage check, by its id.

Nothing personal goes into the repository, the MLflow params and tags, or the logs: errors and
logs name ids and counts, never a text or a word.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from . import paths
from .sentences import Sentence, load_sentences as _load_list
from .spelling import Spelling, Term, _squash

OWN_WORDS = "own-words.yaml"
SENTENCES = "sentences.csv"
ID = re.compile(r"own-\d{4,}")
PREFIX = "own-"


def folder(local_dir: Path | None = None) -> Path:
    return Path(local_dir) if local_dir is not None else paths.local_dir()


def is_own(sentence_id: str) -> bool:
    """Whether a sentence id (or a take's sentence) is one of the owner's own sentences."""
    return str(sentence_id or "").startswith(PREFIX)


def load_sentences(local_dir: Path | None = None) -> list[Sentence]:
    """The owner's own sentences, or none. Ids must be ``own-<number>``; an error names the id."""
    path = folder(local_dir) / SENTENCES
    if not path.is_file():
        return []
    try:
        listed = _load_list(path)
    except ValueError as e:
        # load_sentences names a row by its fields; keep only what names no text.
        raise ValueError(f"{path}: {_without_text(str(e))}") from None
    for s in listed:
        if not ID.fullmatch(s.id):
            raise ValueError(f"{path}: id {s.id!r} must be own-<number>, like own-0001")
    return listed


def _without_text(message: str) -> str:
    """load_sentences' message with any quoted Sentence(...) shown by its id only."""
    return re.sub(r"Sentence\(id='([^']*)'[^)]*\)", r"\1", message)


def own_words(local_dir: Path | None = None) -> list[str]:
    """The words in own-words.yaml, as written (none when the file is missing)."""
    path = folder(local_dir) / OWN_WORDS
    if not path.is_file():
        return []
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        raise ValueError(f"{path}: not valid YAML") from None
    if not isinstance(raw, dict) or set(raw) - {"words"}:
        raise ValueError(f"{path}: expected only 'words', a list of words")
    words = raw.get("words") or []
    if not isinstance(words, list):
        raise ValueError(f"{path}: 'words' must be a list")
    for n, word in enumerate(words, 1):
        if not isinstance(word, str) or not word.strip() or "\n" in word:
            raise ValueError(f"{path}: entry {n} of 'words' must be a word on one line")
    return [w.strip() for w in words]


def with_own_words(spelling: Spelling, words: list[str]) -> Spelling:
    """``spelling`` and each own word as a term with that one form, unless spelling.yaml covers
    it (a form or an ``also`` spelling) or it came earlier in the list (case does not count)."""
    covered = {_squash(f) for t in spelling.terms for f in t.forms}
    covered |= {_squash(a) for t in spelling.terms for a in t.also}
    extra = []
    for word in words:
        key = _squash(word)
        if key in covered:
            continue
        covered.add(key)
        extra.append(Term(name=word, forms=(word,)))
    return Spelling(list(spelling.terms) + extra) if extra else spelling


def spelling_with_own_words(spelling: Spelling, local_dir: Path | None = None) -> Spelling:
    return with_own_words(spelling, own_words(local_dir))


def check_ids(own: list[Sentence], listed: list[Sentence]) -> None:
    """An own sentence's id must not be a listed sentence's id (it would share its takes)."""
    clash = sorted({s.id for s in own} & {s.id for s in listed})
    if clash:
        raise ValueError(f"own sentence id(s) {', '.join(clash)} are in the sentence list too")
