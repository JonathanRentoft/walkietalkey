"""Where Værkstedet reads and writes: every path in one small dataclass, so tests and the
end-to-end run point it at temporary folders (``wt-train studio --recordings ...``).

The defaults are the workbench's (``wt_train.paths``): the recordings and the pilot's
takes in ``training/data/``, the configs, the journal, the learning notebooks, and the work
folder (``WT_WORK_DIR``) with the reports, the runs, the notebooks' working copies and
Værkstedet's own files in ``<work>/studio/`` (``server.json``, the training progress, the
pilot comparison). Run 12 adds the app's dictation history (read-only), the owner's own words
and sentences (``paths.LOCAL``), the test set's lock and the log of its uses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .. import paths

STUDIO = paths.TRAINING / "studio"


def _journal() -> Path:
    return paths.TRAINING / "journal"


@dataclass(frozen=True)
class StudioPaths:
    recordings: Path = paths.RECORDINGS
    pilot: Path = paths.PILOT
    sentences: Path = paths.SENTENCES_CSV
    plan: Path = paths.PLAN_CSV
    exam: Path = paths.EXAM_YAML
    pilot_sentences: Path = paths.PILOT_CSV
    spelling: Path = paths.SPELLING_YAML
    configs: Path = paths.CONFIGS
    journal: Path = field(default_factory=_journal)
    work: Path = field(default_factory=paths.work_dir)
    dist: Path = STUDIO / "dist"
    # The WalkieTalkey binary (default: the installed app first), and, for tests and the
    # end-to-end run, a file the app's link is written to instead of handing it over.
    app_bin: Path | None = None
    app_url_file: Path | None = None
    app_models: Path = field(default_factory=paths.app_models_dir)
    # Run 11: the learning notebooks as committed, and the folder VS Code opens as the
    # workspace (training/, with .vscode/settings.json and the .venv).
    notebooks: Path = paths.TRAINING / "notebooks"
    workspace: Path = paths.TRAINING
    # Run 12: the app's dictation history ("Dine egne ord" reads it, read-only), the owner's own
    # words and sentences (git-ignored), and the frozen test set's lock file.
    history_db: Path = field(default_factory=paths.app_history_db)
    local: Path = field(default_factory=paths.local_dir)
    test_lock: Path = paths.DATA / "test-lock.json"

    @property
    def own(self) -> Path:
        """Værkstedet's own files."""
        return self.work / "studio"

    @property
    def notebook_copies(self) -> Path:
        """The owner's working copies of the notebooks (git-ignored, as the whole work folder)."""
        return self.work / "notebooks"

    @property
    def test_uses(self) -> Path:
        """Run 12: every use of the test set, one JSON line each (``wt-train eval`` writes it)."""
        return self.work / "test-uses.jsonl"

    @property
    def reports(self) -> Path:
        return self.work / "reports"

    @property
    def runs(self) -> Path:
        return self.work / "runs" / "train"

    @property
    def eval_runs(self) -> Path:
        return self.work / "runs" / "eval"

    @property
    def app_settings(self) -> Path:
        """The app's settings (``selected_model`` is the model it uses), beside its models folder."""
        return self.app_models.parent / "settings_store.json"

    @property
    def default_recordings(self) -> bool:
        """The workbench's own recordings folder (a config's ``data.recordings`` then applies)."""
        return Path(self.recordings).resolve() == paths.RECORDINGS.resolve()
