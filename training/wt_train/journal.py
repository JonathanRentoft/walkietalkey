"""``wt-train card <run>``: a page of the lab journal from a tracked run.

Writes ``training/journal/<date>-<run>.md`` (``--out`` for another folder):
- the run's numbers: its own metrics, then every eval and export under it
  (overall, per condition and the FLEURS regression, as tracked);
- its plots, copied into ``<date>-<run>/`` next to the page;
- the config diff against the previous run of the same kind;
- four empty headings for the owner: Hypothesis, What I changed, What
  happened, What I learned.

A page that exists is never overwritten (``--force`` replaces it), so the
owner's notes are never lost. ``<run>`` is a run name as the workbench prints
it, an MLflow run id, or ``latest`` (the newest training run).
"""

from __future__ import annotations

import argparse
import re
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

from . import paths, tracking
from .console import log

JOURNAL = paths.TRAINING / "journal"
HEADINGS = ("Hypothesis", "What I changed", "What happened", "What I learned")


class CardError(Exception):
    pass


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "run"


def run_date(run) -> str:
    return datetime.fromtimestamp(run.info.start_time / 1000).strftime("%Y-%m-%d")


def resolve(arg: str):
    """The run ``arg`` names: ``latest``, a run name (the newest with it) or a run id."""
    if arg == "latest":
        runs = tracking.find_runs(kind="train") or tracking.find_runs()
        if not runs:
            raise CardError("no tracked runs yet")
        return runs[0]
    runs = tracking.find_runs(name=arg)
    if runs:
        return runs[0]
    c, _ = tracking.client()
    try:
        return c.get_run(arg)
    except Exception as e:  # mlflow raises its own exception types for unknown ids
        raise CardError(f"no tracked run named or with id {arg!r}") from e


def children(run) -> list:
    c, experiment = tracking.client()
    return c.search_runs([experiment], filter_string=f"tags.`mlflow.parentRunId` = '{run.info.run_id}'",
                         order_by=["attributes.start_time ASC"])


def previous(run):
    """The newest run of the same kind that started before ``run``, or None."""
    kind = run.data.tags.get("wt.kind")
    for other in tracking.find_runs(kind=kind):
        if other.info.start_time < run.info.start_time and other.info.run_id != run.info.run_id:
            return other
    return None


def config_diff(before: dict, after: dict) -> list[tuple[str, str, str]]:
    keys = sorted(set(before) | set(after))
    return [(k, before.get(k, ""), after.get(k, "")) for k in keys if before.get(k, "") != after.get(k, "")]


def _value(key: str, value: float) -> str:
    if float(value).is_integer() and not key.endswith("_pct"):
        return str(int(value))
    return f"{value:.2f}" if key.endswith("_pct") else f"{value:.4g}"


def metrics_table(metrics: dict) -> list[str]:
    if not metrics:
        return ["No metrics."]
    lines = ["| metric | value |", "|---|---:|"]
    lines += [f"| {k} | {_value(k, v)} |" for k, v in sorted(metrics.items())]
    return lines


def copy_plots(run, folder: Path) -> list[Path]:
    """Every PNG artifact of ``run`` copied into ``folder``; returns the copies."""
    c, _ = tracking.client()
    found: list[str] = []

    def walk(path: str | None) -> None:
        for entry in c.list_artifacts(run.info.run_id, path):
            if entry.is_dir:
                walk(entry.path)
            elif entry.path.lower().endswith(".png"):
                found.append(entry.path)

    walk(None)
    copies = []
    with tempfile.TemporaryDirectory() as tmp:
        for artifact in found:
            local = Path(c.download_artifacts(run.info.run_id, artifact, tmp))
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / f"{slug(run.info.run_name)}-{Path(artifact).name}"
            shutil.copyfile(local, target)
            copies.append(target)
    return copies


def render(run, kids: list, before, plots: list[Path], page: Path) -> str:
    tags, params = run.data.tags, run.data.params
    lines = [f"# {run.info.run_name} ({run_date(run)})", ""]
    facts = [f"kind {tags.get('wt.kind', '?')}", f"commit {tags.get('wt.git_commit', '?')}"]
    if params.get("config_hash"):
        facts.append(f"config hash {params['config_hash']}")
    if params.get("dataset.fingerprint"):
        facts.append(f"dataset {params['dataset.fingerprint']}")
    lines += [", ".join(facts) + ".", "", "## Numbers", ""]
    lines += metrics_table(run.data.metrics)
    for kid in kids:
        lines += ["", f"### {kid.data.tags.get('wt.kind', 'run')}: {kid.info.run_name}", ""]
        lines += metrics_table(kid.data.metrics)
    if plots:
        lines += ["", "## Plots", ""]
        lines += [f"![{p.stem}]({p.relative_to(page.parent).as_posix()})" for p in plots]
    lines += ["", "## Config"]
    if before is None:
        lines += ["", "No earlier run of this kind."]
    else:
        diff = config_diff(before.data.params, params)
        lines += ["", f"Against {before.info.run_name} ({run_date(before)}):", ""]
        if diff:
            lines += [f"| key | {before.info.run_name} | this run |", "|---|---|---|"]
            lines += [f"| {k} | {a} | {b} |" for k, a, b in diff]
        else:
            lines += ["The same config."]
    for heading in HEADINGS:
        lines += ["", f"## {heading}", ""]
    return "\n".join(lines) + "\n"


def write_card(arg: str, out: Path = JOURNAL, force: bool = False) -> Path:
    run = resolve(arg)
    name = f"{run_date(run)}-{slug(run.info.run_name)}"
    page = out / f"{name}.md"
    if page.exists() and not force:
        raise CardError(f"{page} exists (it may hold your notes); --force replaces it")
    out.mkdir(parents=True, exist_ok=True)
    kids = children(run)
    plots = copy_plots(run, out / name)
    for kid in kids:
        plots += copy_plots(kid, out / name)
    page.write_text(render(run, kids, previous(run), plots, page), encoding="utf-8")
    return page


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train card", description=__doc__.split("\n\n")[0])
    p.add_argument("run", help="run name, MLflow run id, or latest")
    p.add_argument("--out", type=Path, default=JOURNAL, help="folder for the page (default: training/journal)")
    p.add_argument("--force", action="store_true", help="replace an existing page")
    args = p.parse_args(argv)
    if not tracking.enabled():
        log("tracking is off (WT_TRACKING=0); there are no runs to describe")
        return 1
    tracking.import_results()
    try:
        page = write_card(args.run, args.out, args.force)
    except CardError as e:
        log(f"card: {e}")
        return 1
    log(f"wrote {page}")
    return 0
