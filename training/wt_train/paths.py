"""Where the workbench reads and writes.

Everything large (downloads, caches, runs, exported models) lives under the
work folder, which git ignores: ``training/work/`` by default, or ``WT_WORK_DIR``
to share one with ``models/eval/run.sh`` (its transcribe.cpp build, the Edda
snapshot and FLEURS test are then reused instead of fetched again).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[1]
REPO = TRAINING.parent

DATA = TRAINING / "data"
SENTENCES_CSV = DATA / "sentences.csv"
SPELLING_YAML = DATA / "spelling.yaml"
# Git-ignored; the owner's voice never leaves this Mac.
RECORDINGS = DATA / "recordings"
CONFIGS = TRAINING / "configs"
RESULTS_CSV = TRAINING / "results.csv"

# The accuracy job's harness (normaliser, WER); imported, never copied.
MODELS_EVAL = REPO / "models" / "eval"


def work_dir() -> Path:
    """The git-ignored folder for downloads, caches, runs and exports."""
    return Path(os.environ.get("WT_WORK_DIR") or TRAINING / "work").resolve()


def app_models_dir() -> Path:
    """The WalkieTalkey app's models folder, where an exported model is installed.

    ``WT_APP_MODELS_DIR`` overrides it (tests, or a portable install).
    """
    override = os.environ.get("WT_APP_MODELS_DIR")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "WalkieTalkey" / "models"
    if sys.platform == "win32":
        return Path(os.environ["LOCALAPPDATA"]) / "WalkieTalkey" / "models"
    return Path.home() / ".local" / "share" / "WalkieTalkey" / "models"
