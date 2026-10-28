"""Where the workbench reads and writes.

Everything large (downloads, caches, runs, exported models) lives under the
work folder, which git ignores: ``training/work/`` by default, or ``WT_WORK_DIR``
to share one with ``models/eval/run.sh`` (its transcribe.cpp build, the Edda
snapshot and FLEURS test are then reused instead of fetched again).

Layout of the work folder (the first four are shared with models/eval and
models/edda, so the same paths are used here):

    dl/edda-v0.2/                 Edda's Hugging Face snapshot
    datasets/fleurs-da_dk/        FLEURS da_dk: test.tsv + test/, train.tsv + train/
    src/transcribe.cpp-0.4.0/     transcribe.cpp build (converter, quantiser, CLI)
    hf/                           HF_HOME for downloads (never the user's own cache)
    builds/<experiment>/          dataset manifests from ``wt-train build``
    cache/encoder/                frozen-encoder outputs, fp16, keyed by content
    cache/pcm16/                  16-bit PCM copies of float WAVs for the app
    runs/train/<run>/             training runs (adapter, metrics, plot)
    runs/eval/<run>/              per-clip evaluation rows
    exports/<model id>/           merged model and GGUF files while exporting
    test-uses.jsonl               run 12: one line per evaluation on the owner's test split
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
# Which condition each sentence is recorded in (wt-train plan), committed.
PLAN_CSV = DATA / "plan.csv"
# Run 7: the share of the sentences each condition gets (wt-train plan --mix), committed next
# to the plan; a plan elsewhere keeps its own mix.yaml beside it.
MIX_YAML = DATA / "mix.yaml"
# Run 12: which split each sentence is in (splits.py) and the parameters it was dealt with,
# committed next to the plan; a plan elsewhere keeps its own beside it.
SPLITS_CSV = DATA / "splits.csv"
SPLIT_YAML = DATA / "split.yaml"
# Run 12: the frozen test set, written by the first `wt-train eval --dataset test` (testset.py);
# committed by the owner. Every use of the test set is logged in <work>/test-uses.jsonl.
TEST_LOCK = DATA / "test-lock.json"
# Run 12: the owner's own words and sentences (local.py), git-ignored and never committed;
# ``local_dir()`` (``WT_LOCAL_DIR``) is where they are read.
LOCAL = DATA / "local"
# The long-form exam paragraphs: read once per condition, never trained on.
EXAM_YAML = DATA / "exam.yaml"
# Git-ignored; the owner's voice never leaves this Mac.
RECORDINGS = DATA / "recordings"
# Run 7: the pilot. Twelve sentences (committed) read once per recording setup before the real
# recordings; the takes (git-ignored, like recordings/) never enter any split.
PILOT_CSV = DATA / "pilot.csv"
PILOT = DATA / "pilot"
CONFIGS = TRAINING / "configs"
RESULTS_CSV = TRAINING / "results.csv"
# Run 12: the owner's own words and sentences (own-words.yaml, sentences.csv), git-ignored like the
# recordings; ``WT_LOCAL_DIR`` names another folder (tests, the end-to-end run).
LOCAL = Path(os.environ.get("WT_LOCAL_DIR") or DATA / "local")


def local_dir() -> Path:
    """:data:`LOCAL`, with ``WT_LOCAL_DIR`` read when called (a test may set it after import)."""
    return Path(os.environ.get("WT_LOCAL_DIR") or DATA / "local")
MODEL_CARD_TEMPLATE = TRAINING / "model-card" / "TEMPLATE.md"

# The accuracy job's harness (normaliser, WER); imported, never copied.
MODELS_EVAL = REPO / "models" / "eval"
SETUP_TRANSCRIBE_CPP = REPO / "models" / "tools" / "setup-transcribe-cpp.sh"

# The base model: Edda v0.2 at the revision WalkieTalkey ships (models/edda/README.md).
EDDA_REPO = "danish-foundation-models/edda-v0.2"
EDDA_REVISION = "698f8d04b5970f963d31c4079c05a76fa7f4f5bb"
EDDA_SAFETENSORS_SHA256 = "84f31719f0a26ea774a9d4470f0a54fecf807afef6ac6fb04291cd2dabe40e4c"
# The shipped Edda GGUF in the app's models folder; an export never replaces it.
SHIPPED_EDDA_FILE = "edda-v0.2-Q8_0.gguf"
SHIPPED_EDDA_ID = "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf"

# FLEURS (google/fleurs, CC BY 4.0) at the revision models/eval pins.
FLEURS_REPO = "google/fleurs"
FLEURS_REVISION = "70bb2e84b976b7e960aa89f1c648e09c59f894dd"

TRANSCRIBE_CPP_VERSION = "0.4.0"


def work_dir() -> Path:
    """The git-ignored folder for downloads, caches, runs and exports."""
    return Path(os.environ.get("WT_WORK_DIR") or TRAINING / "work").resolve()


def local_dir() -> Path:
    """The owner's own words and sentences: ``training/data/local/`` (git-ignored), or
    ``WT_LOCAL_DIR`` (the tests always point it at an empty temporary folder)."""
    return Path(os.environ.get("WT_LOCAL_DIR") or LOCAL).resolve()


def test_uses_log() -> Path:
    """Run 12: one line per use of the owner's test split (testset.py)."""
    return work_dir() / "test-uses.jsonl"


def hf_home() -> Path:
    return work_dir() / "hf"


def snapshot_dir(repo: str, revision: str) -> Path:
    """Where a model snapshot is downloaded: ``dl/<name>`` for the pinned Edda
    (the folder models/edda/convert.sh uses), ``dl/<name>@<rev>`` otherwise."""
    name = repo.split("/")[-1]
    if repo == EDDA_REPO and revision == EDDA_REVISION:
        return work_dir() / "dl" / name
    return work_dir() / "dl" / f"{name}@{revision[:12]}"


def fleurs_dir() -> Path:
    """FLEURS da_dk, laid out like models/eval/fetch_fleurs.sh leaves it."""
    return work_dir() / "datasets" / "fleurs-da_dk"


def builds_dir() -> Path:
    return work_dir() / "builds"


def encoder_cache_dir() -> Path:
    return work_dir() / "cache" / "encoder"


def pcm16_cache_dir() -> Path:
    """16-bit PCM copies of clips the app cannot read as they are (FLEURS is float WAV)."""
    return work_dir() / "cache" / "pcm16"


def runs_dir() -> Path:
    return work_dir() / "runs" / "train"


def eval_runs_dir() -> Path:
    return work_dir() / "runs" / "eval"


def reports_dir() -> Path:
    """Run 7: the HTML pages of ``wt-train report`` and ``wt-train pilot report``."""
    return work_dir() / "reports"


def exports_dir() -> Path:
    return work_dir() / "exports"


def transcribe_cpp_dir() -> Path:
    return work_dir() / "src" / f"transcribe.cpp-{TRANSCRIBE_CPP_VERSION}"


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


def app_history_db() -> Path:
    """Run 12: the app's dictation history (``history.db``, beside its models folder), which
    Værkstedet's "Dine egne ord" reads, read-only. ``WT_APP_HISTORY_DB`` overrides it."""
    override = os.environ.get("WT_APP_HISTORY_DB")
    if override:
        return Path(override)
    return app_models_dir().parent / "history.db"
