"""Værkstedet's evaluation, versions and pilot screens, and what it knows about the app.

The app: the binary ``wt-train use`` would switch (``use._app``: ``--app-bin`` /
``WT_APP_BIN``, else the installed app first), whether it has the batch interface and
``--use-model``, and its version (the bundle's ``Info.plist``). The model it uses is
``selected_model`` in its settings (``settings_store.json`` beside its models folder),
else the registry alias ``app`` (``versions.mark_in_app``).

Evaluations are the tracked MLflow runs of kind ``eval`` and the imported baselines
(``results.csv`` rows), newest first, with their key numbers: a tracked eval names them
``<dataset>/wer``, ``<dataset>/cer``, ``<dataset>/n`` and ``<dataset>/wer_ci95_low|high``
(fractions); an imported row ``wer_pct``, ``cer_pct``, ``n``, ``wer_ci95_low_pct`` (percent).
Their pages are ``wt-train report`` (``--vs`` for two), written as a job into
``<work>/reports/`` without a browser and reused when they exist (in today's format,
``htmlpage.FORMAT``: an English page from before run 11 is written again). MLflow loads slowly, so
it is only imported here, never on the recording screen's polls.

Run 11: each evaluation also has a readable Danish ``title`` (``labels.eval_title``; a day, then a
time, tells two apart that would share one), the ``normaliser`` that counted its WER
(``wt_train.normaliser``: its tag, else the day it was measured), and its ``date`` is when it
was measured (an imported row's own time, not the import's); the list is newest first by it.

The pilot comparison is ``wt-train pilot report --json-out <work>/studio/pilot-comparison.json``
as a job; the page reads the numbers per setup from that file.
"""

from __future__ import annotations

import json
import plistlib
import threading
import time
from datetime import datetime
from pathlib import Path

from .. import normaliser, paths
from . import labels
from .labels import eval_title, unique_titles
from .jobs import Jobs, step_argv
from .places import StudioPaths
from .recording import StudioError

REPORT_TIMEOUT_S = 600.0
APP_RECHECK_S = 60.0
COMPARISON = "pilot-comparison.json"


def _json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


class AppInfo:
    """The app's facts, found once (``--help`` runs the binary) and again after a miss."""

    def __init__(self, app_bin: Path | None = None, find=None):
        self.app_bin = app_bin
        self._find = find
        self._lock = threading.Lock()
        self._found = None
        self._at = 0.0

    def app(self):
        with self._lock:
            stale = self._at == 0.0 or (self._found is None and time.monotonic() - self._at > APP_RECHECK_S)
            if stale:
                if self._find is not None:
                    self._found = self._find()
                else:
                    from ..use import _app

                    self._found = _app(str(self.app_bin) if self.app_bin else None)
                self._at = time.monotonic()
            return self._found

    def facts(self) -> dict:
        app = self.app()
        if app is None:
            return {"found": False, "path": None, "version": None, "batch": False, "use": False}
        return {"found": True, "path": str(app.bin), "version": bundle_version(app.bin),
                "batch": bool(app.supports_batch), "use": bool(app.supports_use)}


def bundle_version(binary: Path) -> str | None:
    """``CFBundleShortVersionString`` of the ``.app`` the binary is in, if it is in one."""
    plist = Path(binary).parent.parent / "Info.plist"
    try:
        with plist.open("rb") as f:
            return str(plistlib.load(f).get("CFBundleShortVersionString") or "") or None
    except (OSError, plistlib.InvalidFileException, ValueError):
        return None


def _measured(run) -> datetime | None:
    """When a run was measured: an imported results.csv row's own time, else when it started."""
    stamp = run.data.params.get("timestamp")
    if stamp:
        try:
            when = datetime.fromisoformat(stamp)
            return when if when.tzinfo else when.astimezone()
        except ValueError:
            pass
    ms = run.info.start_time
    return datetime.fromtimestamp(ms / 1000).astimezone() if ms else None


def model_label(backend: str, model: str, train_run: str | None) -> str:
    if backend == "gguf":
        name = "edda-v0.2" if model == paths.SHIPPED_EDDA_ID else model.rsplit("/", 1)[-1].removesuffix(".gguf")
        return f"{name} (app)"
    if backend == "lora":
        return f"{train_run or model} (LoRA)"
    if backend == "hf":
        return f"{model.rsplit('/', 1)[-1]} (Transformers)"
    return model


class Runs:
    def __init__(self, places: StudioPaths, jobs: Jobs, app: AppInfo):
        self.places = places
        self.jobs = jobs
        self.app_info = app
        self._lock = threading.Lock()

    # --- evaluations --------------------------------------------------------------------

    def _folder(self, run) -> Path | None:
        tagged = run.data.tags.get("wt.eval_dir")
        for candidate in ([Path(tagged)] if tagged else []) + [Path(self.places.eval_runs) / run.info.run_name]:
            if (candidate / "summary.json").is_file():
                return candidate
        return None

    def _page(self, name: str) -> str | None:
        """A page that exists in today's format (an English page from before run 11 is written again)."""
        from ..htmlpage import is_current

        return f"/reports/{name}" if is_current(Path(self.places.reports) / name) else None

    def eval_row(self, run) -> dict:
        tags, params, m = run.data.tags, run.data.params, run.data.metrics
        dataset = params.get("dataset") or ""
        if f"{dataset}/wer" in m:
            wer, cer, clips = m.get(f"{dataset}/wer"), m.get(f"{dataset}/cer"), m.get(f"{dataset}/n")
            low, high = m.get(f"{dataset}/wer_ci95_low"), m.get(f"{dataset}/wer_ci95_high")
        else:
            pct = lambda k: m[k] / 100 if k in m else None  # noqa: E731
            wer, cer, clips = pct("wer_pct"), pct("cer_pct"), m.get("n")
            low, high = pct("wer_ci95_low_pct"), pct("wer_ci95_high_pct")
        folder = self._folder(run)
        when = _measured(run)
        return {"id": run.info.run_id, "name": run.info.run_name,
                "title": eval_title(params.get("backend") or "", params.get("model") or "", dataset,
                                    params.get("train_run")),
                "normaliser": normaliser.of_run(tags, when), "kind": tags.get("wt.kind"),
                "date": when.isoformat(timespec="seconds") if when else None, "dataset": dataset,
                "model": model_label(params.get("backend") or "", params.get("model") or "", params.get("train_run")),
                "backend": params.get("backend") or None, "clips": int(clips) if clips is not None else None,
                "wer": round(wer, 6) if wer is not None else None,
                "wer_ci": [round(low, 6), round(high, 6)] if low is not None and high is not None else None,
                "cer": round(cer, 6) if cer is not None else None, "change": tags.get("wt.change"),
                "report": self._page(f"{folder.name}.html") if folder is not None else None}

    def eval_runs(self) -> list[dict]:
        from .. import tracking

        if not tracking.enabled():
            return []
        found = [r for r in tracking.find_runs() if r.data.tags.get("wt.kind") in ("eval", "baseline")]
        rows = sorted(((self.eval_row(r), _measured(r)) for r in found),
                      key=lambda rw: rw[1].timestamp() if rw[1] else 0.0, reverse=True)
        titles = unique_titles([{"title": row["title"], "when": when} for row, when in rows])
        return [{**row, "title": title} for (row, _), title in zip(rows, titles)]

    def _eval_folder(self, run_id) -> Path:
        from .. import tracking

        if not tracking.enabled():
            raise StudioError(409, "tracking-off", "tracking is off (WT_TRACKING=0)")
        c, _ = tracking.client()
        try:
            run = c.get_run(str(run_id or ""))
        except Exception:  # noqa: BLE001 - mlflow raises its own types for an unknown id
            raise StudioError(404, "unknown", f"no tracked run {run_id!r}") from None
        folder = self._folder(run)
        if folder is None:
            raise StudioError(404, "no-folder", f"run {run.info.run_name} names no eval folder with its clips")
        return folder

    def _report_job(self, title: str, target: Path, args: list[str]) -> dict:
        from ..htmlpage import is_current

        if is_current(target):
            return {"url": f"/reports/{target.name}"}
        job = self.jobs.start("report", f"{labels.JOBS['report']}: {title}",
                              step_argv("report", *args, "--no-open", "--out", str(target)))
        if not job.done.wait(REPORT_TIMEOUT_S) or not is_current(target):
            raise StudioError(500, "report-failed", f"wt-train report did not write {target.name} (job {job.id})")
        return {"url": f"/reports/{target.name}", "job": job.id}

    def report(self, run_id) -> dict:
        folder = self._eval_folder(run_id)
        target = Path(self.places.reports) / f"{folder.name}.html"
        return self._report_job(folder.name, target, [str(folder)])

    def compare(self, a, b) -> dict:
        from ..report import ReportError, load, page_name

        fa, fb = self._eval_folder(a), self._eval_folder(b)
        try:
            first = load(fa)
            target = Path(self.places.reports) / page_name(first, load(fb, first.dataset))
        except ReportError as e:
            raise StudioError(409, "not-comparable", str(e)) from None
        return self._report_job(f"{fa.name} / {fb.name}", target, [str(fa), "--vs", str(fb)])

    # --- versions -----------------------------------------------------------------------

    def in_app(self) -> str | None:
        """The model the app uses: its settings, else the registry alias ``app``."""
        settings = _json(self.places.app_settings)
        chosen = settings.get("settings", {}).get("selected_model") if isinstance(settings, dict) else None
        if isinstance(chosen, str) and chosen:
            return chosen
        from .. import versions

        c, _ = versions._client()
        if c is None:
            return None
        try:
            v = c.get_model_version_by_alias(versions.REGISTERED_MODEL, versions.APP_ALIAS)
        except Exception:  # noqa: BLE001 - no registered model or no alias yet
            return None
        return v.tags.get("wt.model_id") or None

    def exportable(self) -> list[dict]:
        from .training import earlier_runs

        return [{"run": r["name"], "date": r["date"], "best_validation_wer": r["best_validation_wer"]}
                for r in earlier_runs(self.places.runs) if r["adapter"]]

    def versions(self) -> dict:
        from .. import versions

        app = self.app_info.facts()
        using = self.in_app()
        rows = versions.listing()
        base = rows[0]
        return {
            "app": {"found": app["found"], "version": app["version"], "use": app["use"]},
            "in_app": using,
            "base": {"id": base["model_id"], "name": "Edda",
                     "installed": (Path(self.places.app_models) / paths.SHIPPED_EDDA_FILE).is_file()},
            "versions": [{"version": r.get("version"), "id": r["model_id"], "name": r.get("name") or r["model_id"],
                          "run": r.get("run"), "date": r.get("created"), "validation_wer": r.get("validation_wer"),
                          "installed": bool(r.get("installed")), "in_app": r["model_id"] == using}
                         for r in rows[1:]],
            "exportable": self.exportable(),
        }

    def use(self, spec) -> dict:
        from ..use import UseError, switch

        if spec is None or str(spec).strip() == "":
            raise StudioError(400, "version", "name a version number or edda")
        try:
            mid, message = switch(str(spec), app=self.app_info.app())
        except UseError as e:
            raise StudioError(409, "use-failed", str(e)) from None
        return {"ok": True, "in_app": mid, "message": message}

    def export(self, run) -> dict:
        name = str(run or "")
        folder = Path(self.places.runs) / name
        if "/" in name or name.startswith(".") or not (folder / "adapter" / "adapter_config.json").is_file():
            raise StudioError(404, "unknown", f"no training run {name!r} with an adapter in {self.places.runs}")
        with self._lock:
            if self.jobs.running("export"):
                raise StudioError(409, "busy", "an export is running already")
            argv = step_argv("export", name)
            return self.jobs.start("export", f"{labels.JOBS['export']}: {name}", argv, meta={"run": name}).as_dict()

    # --- the pilot ----------------------------------------------------------------------

    def comparison(self) -> dict | None:
        raw = _json(Path(self.places.own) / COMPARISON)
        if not isinstance(raw, dict):
            return None
        from ..htmlpage import is_current

        page = Path(str(raw.get("page") or ""))
        # A page from before run 11 (English) is not shown; the next comparison writes a new one.
        inside = page.name and page.parent.resolve() == Path(self.places.reports).resolve() and is_current(page)
        setups = []
        for name, s in (raw.get("setups") or {}).items():
            scores, audio = s.get("scores") or {}, s.get("audio") or {}
            clips = audio.get("clips") or scores.get("n") or 0
            setups.append({"name": name, "label": labels.setup_label(name, s.get("style") or "normal"),
                           "clips": scores.get("n", clips), "wer": scores.get("wer"), "cer": scores.get("cer"),
                           "terms": scores.get("term_accuracy_strict"), "level_dbfs": audio.get("level_dbfs"),
                           "peak_dbfs": audio.get("peak_dbfs"), "noise_dbfs": audio.get("noise_dbfs"),
                           "snr_db": audio.get("snr_db"), "clipped": audio.get("clipped_clips"),
                           "seconds": round(audio["seconds"] / clips, 2) if clips and "seconds" in audio else None,
                           "notes": list(s.get("notes") or [])})
        return {"generated_at": raw.get("generated_at"), "report": f"/reports/{page.name}" if inside else None,
                "model": raw.get("model"), "setups": setups, "left_out": list(raw.get("left_out") or [])}

    def compare_pilot(self) -> dict:
        p = self.places
        with self._lock:
            if self.jobs.running("pilot"):
                raise StudioError(409, "busy", "the pilot comparison is running already")
            argv = step_argv("pilot", "report", "--no-open", "--json-out", str(Path(p.own) / COMPARISON),
                             "--pilot-dir", str(p.pilot), "--sentences", str(p.pilot_sentences),
                             "--spelling", str(p.spelling))
            if p.app_bin:
                argv += ["--app-bin", str(p.app_bin)]
            Path(p.own).mkdir(parents=True, exist_ok=True)
            return self.jobs.start("pilot", labels.JOBS["pilot"], argv, on_exit=lambda job: self.comparison()).as_dict()
