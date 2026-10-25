"""Experiment tracking (run 5): every train, eval and export run goes to MLflow.

The store is local and git-ignored: ``<work>/mlflow/mlflow.db`` holds the runs,
their parameters and metrics, ``<work>/mlflow/artifacts/`` the plots, tables
and transcripts. Nothing is uploaded. ``wt-train ui`` opens MLflow's own UI on
127.0.0.1 (``wt_train.ui``); ``wt-train card <run>`` turns a run into a page of
the lab journal (``wt_train.journal``).

MLflow sends anonymous usage telemetry unless it is told not to. This module
switches it off before mlflow is ever imported (``MLFLOW_DISABLE_TELEMETRY``
and ``DO_NOT_TRACK``), for this process and for the UI server it starts.
``WT_TRACKING=0`` turns tracking off altogether: every call is then a no-op.

One experiment, ``wt-train``, holds every run, tagged ``wt.kind``: ``train``,
``eval``, ``export`` or ``baseline`` (a ``training/results.csv`` row, so run
4's FLEURS baselines are the first runs). An eval or export of a trained
adapter is a child of its training run, so the UI shows them together.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from . import paths

EXPERIMENT = "wt-train"
TELEMETRY_OFF = {"MLFLOW_DISABLE_TELEMETRY": "true", "DO_NOT_TRACK": "true"}
# Also MLflow's start-up hint for coding assistants, which is only noise in a log.
ENVIRONMENT = {**TELEMETRY_OFF, "MLFLOW_DISABLE_AGENT_HINT": "1"}
os.environ.update(ENVIRONMENT)

# MLflow's limits (mlflow.utils.validation): a batch takes 1,000 metrics or 100
# params, a param value at most 6,000 characters.
_METRIC_BATCH = 1000
_PARAM_BATCH = 100
_PARAM_MAX = 6000


def store_dir() -> Path:
    return paths.work_dir() / "mlflow"


def tracking_uri() -> str:
    return f"sqlite:///{store_dir() / 'mlflow.db'}"


def artifact_root() -> Path:
    return store_dir() / "artifacts"


def enabled() -> bool:
    return os.environ.get("WT_TRACKING", "1") != "0"


def client():
    """The MLflow client for the local store and the id of the ``wt-train`` experiment."""
    from mlflow.tracking import MlflowClient

    store_dir().mkdir(parents=True, exist_ok=True)
    c = MlflowClient(tracking_uri=tracking_uri())
    exp = c.get_experiment_by_name(EXPERIMENT)
    if exp is not None:
        return c, exp.experiment_id
    return c, c.create_experiment(EXPERIMENT, artifact_location=artifact_root().as_uri())


def flatten(values: dict, prefix: str = "") -> dict[str, str]:
    """Nested config sections as ``section.key`` params; lists and nested values as JSON."""
    out: dict[str, str] = {}
    for key, value in values.items():
        name = f"{prefix}{key}"
        if isinstance(value, dict):
            out.update(flatten(value, f"{name}."))
        elif isinstance(value, (list, tuple)):
            out[name] = json.dumps(list(value), ensure_ascii=False)
        else:
            out[name] = "" if value is None else str(value)
    return out


def condition_of(item) -> str:
    """A clip's recording condition (device and style) for counts and per-condition metrics.

    Clips without one (FLEURS rehearsal, older takes) count under their source.
    """
    get = item.get if isinstance(item, dict) else lambda key, default=None: getattr(item, key, default)
    condition = get("condition")
    if condition:
        return str(condition)
    device, style = get("device"), get("style")
    if device and style:
        return f"{device}-{style}"
    return str(get("source") or "unknown")


def dataset_fingerprint(splits: dict[str, list]) -> dict:
    """What a run saw: a hash over every clip's split, id and audio hash, and the
    clip count per split and condition (``train.iphone-whisper``: 412)."""
    h = hashlib.sha256()
    counts: dict[str, int] = {}
    for split in sorted(splits):
        items = splits[split]
        get = (lambda it, k: it.get(k)) if items and isinstance(items[0], dict) else getattr
        for item in sorted(items, key=lambda it: str(get(it, "id"))):
            h.update(f"{split}\t{get(item, 'id')}\t{get(item, 'audio_sha256')}\n".encode())
            key = f"{split}.{condition_of(item)}"
            counts[key] = counts.get(key, 0) + 1
        counts[f"{split}.total"] = len(items)
    return {"fingerprint": h.hexdigest()[:16], "counts": dict(sorted(counts.items()))}


class Run:
    """One MLflow run. Values are logged as they come; nothing is buffered."""

    def __init__(self, mlflow_client, run_id: str):
        self._c = mlflow_client
        self.id = run_id

    def params(self, values: dict) -> None:
        from mlflow.entities import Param

        flat = flatten(values)
        items = [Param(k, v[:_PARAM_MAX]) for k, v in flat.items()]
        for i in range(0, len(items), _PARAM_BATCH):
            self._c.log_batch(self.id, params=items[i:i + _PARAM_BATCH])

    def metrics(self, values: dict, step: int | None = None) -> None:
        """Numbers only; ``None`` and anything else is skipped (a metric is a number)."""
        import time

        from mlflow.entities import Metric

        now = int(time.time() * 1000)
        items = [Metric(k, float(v), now, step or 0) for k, v in flatten_numbers(values).items()]
        for i in range(0, len(items), _METRIC_BATCH):
            self._c.log_batch(self.id, metrics=items[i:i + _METRIC_BATCH])

    def tags(self, values: dict) -> None:
        for key, value in flatten(values).items():
            self._c.set_tag(self.id, key, value)

    def rename(self, name: str) -> None:
        """The workbench names a training run only once its folder exists."""
        self._c.update_run(self.id, name=name)

    def artifact(self, path: Path, folder: str | None = None) -> None:
        if Path(path).exists():
            self._c.log_artifact(self.id, str(path), folder)

    def text(self, text: str, name: str) -> None:
        """A small text artifact (a table, the config) under ``name``."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / name
            target.write_text(text, encoding="utf-8")
            self._c.log_artifact(self.id, str(target))

    def finish(self, status: str = "FINISHED") -> None:
        self._c.set_terminated(self.id, status=status)


class _NoRun(Run):
    """Tracking is off (``WT_TRACKING=0``): the same calls, doing nothing."""

    def __init__(self):
        self.id = ""

    def params(self, values: dict) -> None:
        pass

    def metrics(self, values: dict, step: int | None = None) -> None:
        pass

    def tags(self, values: dict) -> None:
        pass

    def rename(self, name: str) -> None:
        pass

    def artifact(self, path: Path, folder: str | None = None) -> None:
        pass

    def text(self, text: str, name: str) -> None:
        pass

    def finish(self, status: str = "FINISHED") -> None:
        pass


NO_RUN = _NoRun()


def flatten_numbers(values: dict, prefix: str = "") -> dict[str, float]:
    """``{"test": {"wer": 0.07}}`` as ``{"test/wer": 0.07}``, numbers only. Metric names use
    slashes, like the per-condition ones (``test/iphone-whisper/wer``); MLflow's UI groups
    charts by them."""
    out: dict[str, float] = {}
    for key, value in values.items():
        name = f"{prefix}{key}"
        if isinstance(value, dict):
            out.update(flatten_numbers(value, f"{name}/"))
        elif isinstance(value, bool):
            out[name] = float(value)
        elif isinstance(value, (int, float)) and value == value:  # NaN is not a result
            out[name] = float(value)
    return out


def git_tags() -> dict[str, str]:
    from .evaluate import git_commit

    commit = git_commit()
    return {"wt.git_commit": commit, "wt.git_dirty": str(commit.endswith("+dirty")).lower()}


@contextmanager
def run(kind: str, name: str, *, parent: Run | str | None = None, tags: dict | None = None) -> Iterator[Run]:
    """A run of ``kind`` named ``name`` (the workbench's own run name), finished
    when the block ends, FAILED if it raises. ``parent`` (a run or a run id) nests it
    under a training run."""
    if not enabled():
        yield NO_RUN
        return
    c, experiment = client()
    all_tags = {"wt.kind": kind, **git_tags(), **(tags or {})}
    parent_id = parent if isinstance(parent, str) else (parent.id if parent is not None else "")
    if parent_id:
        all_tags["mlflow.parentRunId"] = parent_id
    created = c.create_run(experiment, run_name=name, tags=all_tags)
    current = Run(c, created.info.run_id)
    try:
        yield current
    except BaseException:
        current.finish("FAILED")
        raise
    current.finish("FINISHED")


def find_runs(*, kind: str | None = None, name: str | None = None) -> list:
    """Runs of the ``wt-train`` experiment, newest first, filtered by kind and run name."""
    c, experiment = client()
    filters = []
    if kind:
        filters.append(f"tags.`wt.kind` = '{kind}'")
    if name:
        filters.append(f"attributes.run_name = '{name}'")
    return c.search_runs([experiment], filter_string=" and ".join(filters), order_by=["attributes.start_time DESC"],
                         max_results=1000)


def train_run_id(name: str | None) -> str | None:
    """The tracked training run of that name (the run folder's), if there is one."""
    if not name or not enabled():
        return None
    runs = find_runs(kind="train", name=name)
    return runs[0].info.run_id if runs else None


def log_training_inputs(tracked: Run, config: dict, config_hash: str, splits: dict) -> None:
    """A training run's inputs: the full config, its hash, and the dataset fingerprint
    with the clip count per split and condition."""
    fingerprint = dataset_fingerprint(splits)
    tracked.params({**config, "config_hash": config_hash,
                    "dataset": {"fingerprint": fingerprint["fingerprint"], "counts": fingerprint["counts"]}})


def log_eval(report: dict) -> None:
    """One ``wt-train eval``: every metric (overall, per condition, the FLEURS regression)
    and its files, under its training run when it scored one."""
    if not enabled():
        return
    out = Path(report["out"])
    with run("eval", out.name, parent=train_run_id(report.get("train_run"))) as r:
        r.params({"backend": report.get("backend", ""), "model": report.get("model", ""),
                  "dataset": report.get("dataset", ""), "train_run": report.get("train_run") or ""})
        r.metrics(report.get("metrics") or {})
        for name in ("summary.json", "terms.md", "side-by-side.md"):
            r.artifact(out / name)


def log_export(result: dict) -> None:
    """One ``wt-train export``: the installed model, the same-text check and the model
    card, under its training run."""
    if not enabled():
        return
    with run("export", result["model_id"], parent=train_run_id(result.get("run"))) as r:
        r.params({k: result.get(k, "") for k in ("model_id", "name", "path", "sha256", "run")})
        r.metrics({"size_bytes": result.get("size_bytes"), "verify": result.get("verify") or {},
                   "seconds": result.get("seconds") or {}})
        if result.get("card"):
            r.artifact(Path(result["card"]))


# results.csv columns that are numbers (logged as metrics) and the rest (params).
_RESULT_METRICS = ("n", "wer_pct", "cer_pct", "terms", "terms_strict", "terms_lenient", "term_accuracy_strict_pct",
                   "term_accuracy_lenient_pct", "fleurs_n", "fleurs_wer_pct", "fleurs_cer_pct")


def _ci_bounds(text: str) -> tuple[float, float] | None:
    parts = text.replace("%", "").split(" to ")
    try:
        return float(parts[0]), float(parts[1])
    except (IndexError, ValueError):
        return None


def import_results(path: Path = paths.RESULTS_CSV) -> int:
    """Logs every ``results.csv`` row not tracked yet as a finished ``baseline`` run
    (tag ``wt.results_row``, a hash of the row), so the UI shows them; returns how
    many were added. Rows already imported are skipped, so it is safe to call often."""
    if not enabled() or not Path(path).exists():
        return 0
    with Path(path).open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    known = {r.data.tags.get("wt.results_row") for r in find_runs(kind="baseline")}
    c, experiment = client()
    added = 0
    for row in rows:
        key = hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()[:16]
        if key in known:
            continue
        name = f"{row.get('backend', '')}-{row.get('dataset', '')}-{row.get('timestamp', '')[:10]}"
        tags = {"wt.kind": "baseline", "wt.results_row": key, "wt.git_commit": row.get("git_commit", ""),
                "wt.source": "results.csv", "mlflow.note.content": row.get("notes", "")}
        created = c.create_run(experiment, run_name=name, tags=tags)
        imported = Run(c, created.info.run_id)
        imported.params({k: v for k, v in row.items() if k not in _RESULT_METRICS and k != "notes"})
        numbers: dict[str, float] = {}
        for k in _RESULT_METRICS:
            try:
                numbers[k] = float(row[k])
            except (KeyError, TypeError, ValueError):
                pass
        for column, prefix in (("wer_ci95_pct", "wer"), ("fleurs_wer_ci95_pct", "fleurs_wer")):
            bounds = _ci_bounds(row.get(column, ""))
            if bounds:
                numbers[f"{prefix}_ci95_low_pct"], numbers[f"{prefix}_ci95_high_pct"] = bounds
        imported.metrics(numbers)
        imported.finish()
        added += 1
    return added
