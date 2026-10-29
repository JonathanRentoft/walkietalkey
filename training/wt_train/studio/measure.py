"""Værkstedet's measurements (run 12): validation by default, the test set only on purpose.

* "Mål" runs ``wt-train eval --dataset validation`` as a job (kind ``eval``) for a training
  run (``--backend lora --run <name>``) or for Edda (``--backend hf --build <config>``), with
  ``--no-fleurs`` when the owner skips FLEURS. Its result joins the evaluations through
  MLflow, as every ``wt-train eval`` does.
* The test set is a separate request that must say ``confirm: true`` (the page asks first:
  the test set is for the final measurement, and every use is written down); it passes
  ``--dataset test``. Every studio eval job gets ``WT_TEST_USE_SOURCE=studio``, so the use
  log says it came from here.
* The use log is ``<work>/test-uses.jsonl`` (``wt-train eval`` appends one JSON object per
  test use: ``at``, ``runs``, ``backend``, ``build``, ``eval_run``, ``source``), and the
  frozen test set is ``training/data/test-lock.json`` (``created``, ``build``, ``sentences``,
  ``clips``, ``sha256``). Both are read as they are: a missing file or a bad line is
  skipped, never an error.
* ``WT_STUDIO_EVAL`` names a program run in place of ``wt-train eval`` (the end-to-end run's
  stand-in); otherwise it is this interpreter's ``-m wt_train eval``.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime
from pathlib import Path

from . import labels
from .jobs import Jobs, step_argv
from .places import StudioPaths
from .recording import StudioError

NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
DATASETS = ("validation", "test")
SOURCES = ("cli", "studio")


def eval_argv(*args: str) -> list[str]:
    """``wt-train eval <args>``, or ``WT_STUDIO_EVAL <args>`` when that names a stand-in."""
    stand_in = os.environ.get("WT_STUDIO_EVAL")
    return [stand_in, *args] if stand_in else step_argv("eval", *args)


def _json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _size(value) -> int | None:
    if isinstance(value, list):
        return len(value)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def read_lock(path: Path) -> dict | None:
    """The frozen test set: when, from which build, how many sentences and clips; None when
    there is no lock (or it is not one)."""
    raw = _json(path)
    if not isinstance(raw, dict):
        return None
    return {"created": raw.get("created") if isinstance(raw.get("created"), str) else None,
            "build": raw.get("build") if isinstance(raw.get("build"), str) else None,
            "sentences": _size(raw.get("sentences")), "clips": _size(raw.get("clips")),
            "sha256": raw.get("sha256") if isinstance(raw.get("sha256"), str) else None}


def read_uses(path: Path) -> list[dict]:
    """Every use of the test set, newest first; lines that are not a use are skipped."""
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            raw = json.loads(line)
        except ValueError:
            continue
        if not isinstance(raw, dict) or not isinstance(raw.get("at"), str):
            continue
        runs = raw.get("runs")
        runs = [str(r) for r in runs] if isinstance(runs, list) else ([str(runs)] if isinstance(runs, str) else [])
        source = raw.get("source") if raw.get("source") in SOURCES else None
        out.append({"at": raw["at"], "runs": runs, "backend": raw.get("backend") if isinstance(raw.get("backend"), str)
                    else None, "build": raw.get("build") if isinstance(raw.get("build"), str) else None,
                    "eval_run": raw.get("eval_run") if isinstance(raw.get("eval_run"), str) else None,
                    "source": source})

    def when(u: dict) -> float:
        try:
            d = datetime.fromisoformat(u["at"])
            return (d if d.tzinfo else d.astimezone()).timestamp()
        except ValueError:
            return 0.0

    return sorted(out, key=when, reverse=True)


class Measure:
    def __init__(self, places: StudioPaths, jobs: Jobs):
        self.places = places
        self.jobs = jobs
        self._lock = threading.Lock()

    @property
    def builds(self) -> Path:
        return Path(self.places.work) / "builds"

    def targets(self) -> dict:
        """What can be measured: training runs with an adapter, and the configs' builds for Edda."""
        from .data import config_names
        from .training import earlier_runs

        runs = []
        for r in earlier_runs(self.places.runs):
            if not r["adapter"]:
                continue
            folder = Path(self.places.runs) / r["name"] / "dataset"
            runs.append({"name": r["name"], "title": labels.model_title("lora", "", r["name"]), "date": r["date"],
                         "best_validation_wer": r["best_validation_wer"],
                         **{ds: (folder / f"{ds}.jsonl").is_file() for ds in DATASETS}})
        configs = [{"name": name, **{ds: (self.builds / name / f"{ds}.jsonl").is_file() for ds in DATASETS}}
                   for name in config_names(self.places.configs)]
        job = self.jobs.latest("eval")
        return {"runs": runs, "configs": configs, "base": labels.EVAL_MODELS["base"],
                "job": job.as_dict() if job is not None else None}

    def testset(self) -> dict:
        uses = read_uses(self.places.test_uses)
        return {"lock": read_lock(self.places.test_lock), "uses": uses, "count": len(uses)}

    def start(self, body: dict) -> dict:
        backend, dataset = body.get("backend"), body.get("dataset", "validation")
        if dataset not in DATASETS:
            raise StudioError(400, "dataset", "dataset is validation or test")
        if dataset == "test" and body.get("confirm") is not True:
            raise StudioError(409, "confirm", "the test set is for the final measurement: confirm to use it")
        if backend == "lora":
            name = str(body.get("run") or "")
            folder = Path(self.places.runs) / name
            if not NAME.fullmatch(name) or not (folder / "adapter" / "adapter_config.json").is_file():
                raise StudioError(404, "unknown", "no training run with an adapter by that name")
            if not (folder / "dataset" / f"{dataset}.jsonl").is_file():
                raise StudioError(409, "no-split", f"that run kept no {dataset} split")
            target, what = ["--run", name], labels.model_title("lora", "", name)
        elif backend == "hf":
            name = str(body.get("build") or "")
            if not NAME.fullmatch(name):
                raise StudioError(404, "unknown", "no such build")
            if not (self.builds / name / f"{dataset}.jsonl").is_file():
                raise StudioError(409, "no-build", f"the build has no {dataset} split; wt-train build makes it")
            target = ["--build", name]
            what = f"{labels.EVAL_MODELS['base']} · {name}"
        else:
            raise StudioError(400, "backend", "backend is lora (a training run) or hf (Edda)")
        args = ["--backend", backend, *target, "--dataset", dataset, "--spelling", str(self.places.spelling)]
        if body.get("fleurs") is False:
            args.append("--no-fleurs")
        with self._lock:
            if self.jobs.running("eval"):
                raise StudioError(409, "busy", "a measurement is running already")
            kind = "test" if dataset == "test" else "eval"
            job = self.jobs.start("eval", f"{labels.JOBS[kind]}: {what}", eval_argv(*args),
                                  env={"WT_TEST_USE_SOURCE": "studio"},
                                  meta={"dataset": dataset, "backend": backend, "target": name})
        return job.as_dict()
