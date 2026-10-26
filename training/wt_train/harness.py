"""The accuracy job's harness, ``models/eval/wt_eval``, imported in place.

The workbench scores text exactly like the app's accuracy job, so it imports
that harness instead of copying it: the normaliser (``wt_eval/normalize.py``;
a clip is scored with ``normalize_pair``, which also joins a hyphenated
compound the other text writes closed),
the word alignment (``wt_eval/wer.py``), FLEURS test loading with the same clip
ids and ``--limit`` spreading (``wt_eval/datasets.py``) and the transcribe-cli
runner (``wt_eval/engine.py``). models/eval is never modified from here; its
file hashes key the accuracy CI cache.
"""

from __future__ import annotations

import sys

from .paths import MODELS_EVAL

if str(MODELS_EVAL) not in sys.path:
    sys.path.append(str(MODELS_EVAL))

from wt_eval.datasets import Clip, load_fleurs  # noqa: E402
from wt_eval.engine import TranscribeCli  # noqa: E402
from wt_eval.normalize import normalize, normalize_pair  # noqa: E402
from wt_eval.wer import Counts, bootstrap_ci, corpus_wer, word_errors  # noqa: E402

__all__ = [
    "Clip",
    "Counts",
    "TranscribeCli",
    "bootstrap_ci",
    "corpus_wer",
    "load_fleurs",
    "normalize",
    "normalize_pair",
    "word_errors",
]
