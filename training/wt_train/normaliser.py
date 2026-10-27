"""Which WER normaliser scored a run (run 11).

Every WER and CER the workbench reports is counted after the accuracy job's normaliser
(``models/eval/wt_eval/normalize.py``, with the number words of ``danish_numbers.py``). When
the normaliser changes, every number changes with it although no model did: run 8's fix on
26 October 2026 took the shipped Edda on FLEURS from 7.63 % to 6.72 % without touching a
weight. So runs are only comparable within one normaliser, and every tracked run is tagged
with its version (``wt.normaliser``, and the files' hash as ``wt.normaliser_sha``, set by
``tracking.run``); Værkstedet groups the evaluations by it.

A version is the hash of those two files (line ends folded, so a checkout's line endings do
not change it). ``VERSIONS`` lists every version with the day it took over, and ``CURRENT``
is the newest. When you change the normaliser, add the new hash as the next version with the
day it takes over and bump ``CURRENT``: ``tests/test_normaliser.py`` fails until you do.
models/eval is never modified from here; its file hashes key the accuracy CI cache.

A run tracked before the tag existed is classified by the day it was measured: the newest
version whose day it falls on or after (before 26 October 2026: version 1).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

from . import paths

TAG = "wt.normaliser"
HASH_TAG = "wt.normaliser_sha"
# The tag's value for a normaliser that is not in VERSIONS (an edit not given a number yet).
UNKNOWN = "unknown"


@dataclass(frozen=True)
class Version:
    number: int
    # The first day runs were scored with it (None: from the start).
    since: date | None
    # fingerprint() of its files.
    sha: str
    what: str


VERSIONS = (
    Version(1, None, "1083cdb05c9c06d1", "WalkieTalkey 0.1: lower case, punctuation, numbers as words"),
    Version(2, date(2026, 10, 26), "7c71d7633f04d9d0",
            "run 8: fractions, abbreviations, units, ordinals, clock times, ranges, accents, hyphenated compounds"),
)
CURRENT = 2


def files(root: Path | None = None) -> list[Path]:
    """The normaliser's files, in the order they are hashed."""
    folder = Path(root) if root is not None else paths.MODELS_EVAL / "wt_eval"
    return [folder / "normalize.py", folder / "danish_numbers.py"]


def fingerprint(root: Path | None = None) -> str:
    """The first 16 hex digits of a SHA-256 over the files, each with ``\\r\\n`` as ``\\n``."""
    h = hashlib.sha256()
    for f in files(root):
        h.update(f.name.encode() + b"\0" + f.read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()[:16]


def current(root: Path | None = None) -> int | None:
    """The version of the normaliser in models/eval now, or None for one not in VERSIONS."""
    sha = fingerprint(root)
    return next((v.number for v in VERSIONS if v.sha == sha), None)


def tags() -> dict[str, str]:
    """What ``tracking.run`` tags every run with."""
    try:
        sha = fingerprint()
    except OSError:
        return {}
    number = next((v.number for v in VERSIONS if v.sha == sha), None)
    return {TAG: str(number) if number is not None else UNKNOWN, HASH_TAG: sha}


def of_date(day: date) -> int:
    """The version that scored runs on that day."""
    out = VERSIONS[0].number
    for v in VERSIONS:
        if v.since is None or day >= v.since:
            out = v.number
    return out


def of_run(run_tags: dict, when: datetime | date | None) -> int | None:
    """A tracked run's version: its tag, else (a run from before the tag) the day it was
    measured; None for a normaliser without a number, or no tag and no day."""
    tagged = run_tags.get(TAG)
    if tagged is not None:
        try:
            return int(tagged)
        except ValueError:
            return None
    if when is None:
        return None
    return of_date(when.date() if isinstance(when, datetime) else when)
