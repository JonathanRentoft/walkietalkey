"""Værkstedet's training screen: the configs, one training at a time, and its progress.

A config is shown setting by setting (``config.to_dict``, in its own order), each with
its Danish line from :mod:`.labels`. A training is ``wt-train train configs/<name>.yaml
--progress <file>`` as a job (:mod:`.jobs`), the progress file in ``<work>/studio/``,
and ``caffeinate -i -w <pid>`` beside it so the Mac does not sleep while it runs
(``WT_CAFFEINATE`` names another program, or ``0`` none; tests use a stand-in). The
state folds the progress file's JSON lines (``train.py``) into the curves the page draws;
the runs before it come from ``<work>/runs/train/``.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
from datetime import datetime
from pathlib import Path

from .jobs import Jobs, step_argv
from .labels import JOBS, SECTIONS, SETTINGS
from .places import StudioPaths
from .recording import StudioError

NAME = re.compile(r"[a-z0-9][a-z0-9-]*")


def caffeinate_command() -> list[str] | None:
    """``caffeinate`` (macOS), or ``WT_CAFFEINATE``; ``WT_CAFFEINATE=0`` turns it off."""
    chosen = os.environ.get("WT_CAFFEINATE")
    if chosen is not None:
        return None if chosen in ("", "0") else [chosen]
    found = shutil.which("caffeinate")
    return [found] if found else None


def settings(cfg) -> list[dict]:
    """Every setting of the resolved config with its label, in the config's order."""
    from ..config import to_dict

    out = []
    for section, value in to_dict(cfg).items():
        if isinstance(value, dict):
            for key, v in value.items():
                full = f"{section}.{key}"
                out.append({"key": full, "section": section, "value": v, "label": SETTINGS.get(full, full),
                            "section_label": SECTIONS.get(section, section)})
        else:
            out.append({"key": section, "section": None, "value": value, "label": SETTINGS.get(section, section),
                        "section_label": None})
    return out


def read_progress(path: Path) -> dict:
    """The progress file's events folded into what the page draws."""
    p = {"run": None, "dir": None, "phase": None, "epoch": 0, "epochs": None, "step": 0, "total_steps": None,
         "steps_per_epoch": None, "train_loss": [], "validation_loss": [], "validation_wer": [],
         "best_epoch": None, "best_validation_wer": None, "message": None}
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return p
    for line in lines:
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue  # a line still being written
        kind = ev.get("event") if isinstance(ev, dict) else None
        if kind == "phase":
            p["phase"] = ev.get("phase")
        elif kind == "run":
            p["run"], p["dir"] = ev.get("name"), ev.get("dir")
        elif kind == "plan":
            p["epochs"], p["total_steps"], p["steps_per_epoch"] = ev.get("epochs"), ev.get("total_steps"), \
                ev.get("steps_per_epoch")
        elif kind == "step":
            p["step"], p["epoch"] = ev.get("step", p["step"]), ev.get("epoch", p["epoch"])
            p["train_loss"].append([ev.get("step"), ev.get("loss")])
        elif kind == "epoch":
            p["epoch"] = ev.get("epoch", p["epoch"])
            p["validation_loss"].append([ev.get("step"), ev.get("validation_loss")])
            p["validation_wer"].append([ev.get("step"), ev.get("validation_wer")])
        elif kind == "done":
            p["phase"] = "done"
            p["best_epoch"], p["best_validation_wer"] = ev.get("best_epoch"), ev.get("best_validation_wer")
        elif kind == "failed":
            p["phase"], p["message"] = "failed", ev.get("message")
        elif kind == "stopped":
            p["phase"] = "stopped"
    return p


def earlier_runs(folder: Path) -> list[dict]:
    """The training runs in ``<work>/runs/train/``, newest first."""
    out = []
    for run in Path(folder).glob("*") if Path(folder).is_dir() else []:
        if not (run / "config.json").is_file():
            continue
        info = _json(run / "run.json") or {}
        best = _json(run / "best.json") or {}
        out.append({"name": run.name,
                    "date": datetime.fromtimestamp((run / "config.json").stat().st_mtime).astimezone()
                    .isoformat(timespec="seconds"),
                    "best_epoch": info.get("best_epoch", best.get("epoch")),
                    "best_validation_wer": info.get("best_validation_wer", best.get("validation_wer")),
                    "baseline_validation_wer": info.get("baseline_validation_wer"),
                    "finished": bool(info), "adapter": (run / "adapter" / "adapter_config.json").is_file()})
    return sorted(out, key=lambda r: r["date"], reverse=True)


def _json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


class Training:
    def __init__(self, places: StudioPaths, jobs: Jobs, *, caffeinate: list[str] | None = None):
        self.places = places
        self.jobs = jobs
        self.caffeinate = caffeinate if caffeinate is not None else caffeinate_command()
        self._lock = threading.Lock()

    def configs(self) -> list[dict]:
        from ..config import ConfigError, load_config

        out = []
        for path in sorted(Path(self.places.configs).glob("*.yaml")):
            row = {"name": path.stem, "file": f"configs/{path.name}", "settings": []}
            try:
                row["settings"] = settings(load_config(path))
            except ConfigError as e:
                row["error"] = str(e)
            out.append(row)
        return out

    def start(self, name) -> dict:
        name = str(name or "")
        path = Path(self.places.configs) / f"{name}.yaml"
        if not NAME.fullmatch(name) or not path.is_file():
            raise StudioError(404, "unknown", f"no config {name!r} in {self.places.configs}")
        with self._lock:
            if self.jobs.running("train"):
                raise StudioError(409, "busy", "a training is running already")
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            progress = self.places.own / f"train-{name}-{stamp}.jsonl"
            progress.parent.mkdir(parents=True, exist_ok=True)
            argv = step_argv("train", str(path.resolve()), "--progress", str(progress))
            if not self.places.default_recordings:
                argv += ["--recordings", str(Path(self.places.recordings).resolve())]
            job = self.jobs.start("train", f"{JOBS['train']}: {name}", argv,
                                  meta={"config": name, "progress": str(progress)})
            if self.caffeinate and job.pid:
                self.jobs.attach(job, [*self.caffeinate, "-i", "-w", str(job.pid)])
        return job.as_dict()

    def stop(self) -> dict:
        running = self.jobs.running("train")
        if not running:
            raise StudioError(409, "not-running", "no training is running")
        return self.jobs.stop(running[0].id).as_dict()

    def awake(self, job) -> bool:
        return job is not None and job.companion is not None and job.companion.poll() is None

    def state(self) -> dict:
        job = self.jobs.latest("train")
        progress = None
        if job is not None:
            progress = read_progress(Path(job.meta["progress"]))
            progress["config"] = job.meta.get("config")
            if not job.running and progress["phase"] not in ("done", "failed", "stopped"):
                progress["phase"] = {"stopped": "stopped", "failed": "failed"}.get(job.status, "done")
            progress["awake"] = self.awake(job)
        return {"job": job.as_dict() if job is not None else None, "progress": progress,
                "runs": earlier_runs(self.places.runs)}

    def summary(self) -> dict:
        running = self.jobs.running("train")
        return {"running": bool(running), "config": running[0].meta.get("config") if running else None}
