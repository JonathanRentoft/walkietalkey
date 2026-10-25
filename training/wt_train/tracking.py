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

Run 6: every run is also tagged ``wt.change``, what it changed or measured:
``pipeline`` (the app around the model: chunking, punctuation, finishing) or
``model`` (the weights). So the history shows that run 5's 8.44 % to 7.63 %
on FLEURS came from the pipeline, with the same model file. Every export is a
new version of the registered model ``edda-da`` (``wt_train.versions``).
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

# Run 6: what a run changed or measured. Run 7 adds ``data``: a pilot compares recording setups
# (the audio going in), with the model and the pipeline unchanged.
CHANGES = ("pipeline", "model", "data")
DEFAULT_CHANGE = {"train": "model", "export": "model", "eval": "model", "pilot": "data"}


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
def run(kind: str, name: str, *, parent: Run | str | None = None, tags: dict | None = None,
        change: str | None = None) -> Iterator[Run]:
    """A run of ``kind`` named ``name`` (the workbench's own run name), finished
    when the block ends, FAILED if it raises. ``parent`` (a run or a run id) nests it
    under a training run. ``change`` is ``pipeline`` or ``model`` (run 6); training and
    exports change the model, and an eval measures a model unless it says otherwise."""
    change = change or DEFAULT_CHANGE.get(kind)
    if change not in CHANGES:
        raise ValueError(f"a run changes the pipeline, model or data, not {change!r}")
    if not enabled():
        yield NO_RUN
        return
    c, experiment = client()
    all_tags = {"wt.kind": kind, "wt.change": change, **git_tags(), **(tags or {})}
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


def attach(run_id: str, path: Path, folder: str | None = None) -> bool:
    """Run 7: adds a file (a report page) to a run that already exists, finished or not.
    False when tracking is off, the run is unknown or the file is missing."""
    if not enabled() or not run_id or not Path(path).is_file():
        return False
    c, _ = client()
    try:
        c.get_run(run_id)
    except Exception:
        return False
    c.log_artifact(run_id, str(path), folder)
    return True


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
    with run("eval", out.name, parent=train_run_id(report.get("train_run")), change=eval_change(report)) as r:
        r.params({"backend": report.get("backend", ""), "model": report.get("model", ""),
                  "dataset": report.get("dataset", ""), "train_run": report.get("train_run") or ""})
        r.metrics(report.get("metrics") or {})
        for name in ("summary.json", "terms.md", "side-by-side.md"):
            r.artifact(out / name)


def eval_change(report: dict) -> str:
    """An eval of the shipped Edda measures the pipeline around it; anything else a model."""
    model = str(report.get("model") or "")
    shipped = model == paths.SHIPPED_EDDA_ID or model.endswith(paths.SHIPPED_EDDA_FILE)
    return "pipeline" if shipped and not report.get("train_run") else "model"


def log_export(result: dict) -> int:
    """One ``wt-train export``: the installed model, the same-text check, the model card and
    the config, under its training run, registered as the next version of ``edda-da``
    (run 6). Returns the version number (0 when tracking is off)."""
    if not enabled():
        return 0
    from . import versions

    with run("export", result["model_id"], parent=train_run_id(result.get("run"))) as r:
        r.params({k: result.get(k, "") for k in ("model_id", "name", "path", "sha256", "run", "version",
                                                 "config_hash")})
        r.metrics({"size_bytes": result.get("size_bytes"), "verify": result.get("verify") or {},
                   "seconds": result.get("seconds") or {}, "validation_wer": result.get("validation_wer")})
        if result.get("card"):
            r.artifact(Path(result["card"]), "model")
        with tempfile.TemporaryDirectory() as tmp:
            exported = Path(tmp) / "export.json"
            exported.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            r.artifact(exported, "model")
        number = versions.register(r.id, result)
        r.tags({"wt.registered_model": versions.REGISTERED_MODEL, "wt.version": str(number)})
    return number


# results.csv columns that are numbers (logged as metrics) and the rest (params).
_RESULT_METRICS = ("n", "wer_pct", "cer_pct", "terms", "terms_strict", "terms_lenient", "term_accuracy_strict_pct",
                   "term_accuracy_lenient_pct", "fleurs_n", "fleurs_wer_pct", "fleurs_cer_pct")


def _ci_bounds(text: str) -> tuple[float, float] | None:
    parts = text.replace("%", "").split(" to ")
    try:
        return float(parts[0]), float(parts[1])
    except (IndexError, ValueError):
        return None


def _row_key(row: dict) -> str:
    return hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()[:16]


def _row_name(row: dict) -> str:
    return f"{row.get('backend', '')}-{row.get('dataset', '')}-{row.get('timestamp', '')[:10]}"


def row_change(row: dict) -> str:
    """Run 6: a results.csv row changed or measured the model (Transformers, or any LoRA or
    config), or the pipeline around the shipped model (the app path)."""
    if row.get("backend") == "hf" or row.get("lora") or row.get("config"):
        return "model"
    return "pipeline"


def _row_plan(rows: list[dict]) -> list[dict]:
    """What each row becomes: its kind, change, and for a pipeline eval the row it improves on
    (the previous pipeline row with the same model and dataset) with the difference in WER."""
    plans = []
    for i, row in enumerate(rows):
        kind = "baseline" if (row.get("notes") or "").lower().startswith("baseline") else "eval"
        change = row_change(row)
        plan = {"row": row, "key": _row_key(row), "name": _row_name(row), "kind": kind, "change": change,
                "note": row.get("notes", ""), "tags": {}, "metrics": {}}
        if kind == "eval" and change == "pipeline":
            before = next((p for p in reversed(plans) if p["change"] == "pipeline"
                           and p["row"].get("model") == row.get("model")
                           and p["row"].get("dataset") == row.get("dataset")), None)
            if before is not None:
                try:
                    a, b = float(before["row"]["wer_pct"]), float(row["wer_pct"])
                except (KeyError, ValueError):
                    a = b = None
                plan["tags"]["wt.compared_to"] = before["name"]
                if a is not None:
                    plan["metrics"]["wer_pct_delta"] = round(b - a, 2)
                    plan["note"] = (f"Pipeline change only: the same model file ({Path(row.get('model', '')).name}) "
                                    f"as {before['name']}; WER {a:.2f} % to {b:.2f} % without touching the model. "
                                    + plan["note"])
        plans.append(plan)
    return plans


def import_results(path: Path = paths.RESULTS_CSV) -> int:
    """Logs every ``results.csv`` row not tracked yet as a finished run (tag
    ``wt.results_row``, a hash of the row), so the UI shows them; returns how many were
    added. Rows marked "baseline" in their notes are ``baseline`` runs, the rest ``eval``
    runs; every one says what it changed (run 6), and a pipeline eval names the run it
    improves on. Rows tracked before run 6 get those tags too. Safe to call often."""
    if not enabled() or not Path(path).exists():
        return 0
    with Path(path).open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    known = {r.data.tags.get("wt.results_row"): r for r in find_runs()}
    c, experiment = client()
    added = 0
    for plan in _row_plan(rows):
        row = plan["row"]
        tags = {"wt.kind": plan["kind"], "wt.change": plan["change"], "wt.results_row": plan["key"],
                "wt.git_commit": row.get("git_commit", ""), "wt.source": "results.csv",
                "mlflow.note.content": plan["note"], **plan["tags"]}
        existing = known.get(plan["key"])
        if existing is not None:
            # Tracked before run 6: add what is missing (kind, change, comparison), nothing else.
            if existing.data.tags.get("wt.change") is None:
                for k, v in tags.items():
                    c.set_tag(existing.info.run_id, k, v)
                for k, v in plan["metrics"].items():
                    c.log_metric(existing.info.run_id, k, v)
            continue
        created = c.create_run(experiment, run_name=plan["name"], tags=tags)
        imported = Run(c, created.info.run_id)
        imported.params({k: v for k, v in row.items() if k not in _RESULT_METRICS and k != "notes"})
        numbers: dict[str, float] = dict(plan["metrics"])
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
    tag_changes()
    return added


def tag_changes() -> int:
    """Run 6: tags every run tracked before ``wt.change`` existed; returns how many."""
    if not enabled():
        return 0
    c, _ = client()
    done = 0
    for r in find_runs():
        if r.data.tags.get("wt.change"):
            continue
        kind = r.data.tags.get("wt.kind")
        params = r.data.params
        if kind == "baseline":
            change = row_change(params)
        elif kind == "eval":
            change = eval_change({"model": params.get("model"), "train_run": params.get("train_run")})
        else:
            change = "model"
        c.set_tag(r.info.run_id, "wt.change", change)
        done += 1
    return done
