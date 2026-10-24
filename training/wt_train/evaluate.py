"""``wt-train eval``: score a model and append the result to ``training/results.csv``.

Backends
    ``hf``    the base model (pinned Edda, or ``--model <HF folder>``), Transformers.
    ``lora``  the base model with a run's adapter merged in (``--run``), float16,
              the same weights ``wt-train export`` converts.
    ``gguf``  a GGUF through the app's own pipeline (``app.py``): ``--model <app
              model id>``, a ``.gguf`` path inside the app's models folder, or
              ``--run`` for the model that run's export installed. The app reads
              16-bit PCM only; float WAVs (FLEURS) go through a 16-bit copy.
    ``hf`` and ``lora`` decode greedily, timestamps off, Danish forced, on the
    Apple GPU in float16 (``--device cpu``: float32); one clip per window.

Datasets (``--dataset``)
    ``fleurs-test``                  FLEURS da_dk test, all 930 clips or ``--limit N``
                                     (an evenly spread subset, the same clips
                                     models/eval picks for the same N);
    ``test``, ``validation``, ``train``  a split of ``--run`` (its own copy) or of
                                     ``--build <name or folder>``;
    ``exam``, ``exam:<condition>``    the long-form exam takes (``recordings/exam/``),
                                     never trained on; with ``--live`` (gguf) each
                                     paragraph goes through the app's live path;
    a ``.jsonl`` manifest, or a folder of ``<name>.wav`` + ``<name>.txt``.

Metrics: WER, CER and English-term accuracy (strict and lenient), defined in
``metrics.py`` with the accuracy job's normaliser (``models/eval/wt_eval/
normalize.py``). Unless the dataset is FLEURS test itself, FLEURS da_dk test is
scored too (``--fleurs-limit``, ``--no-fleurs``) as the plain-Danish regression
check. The owner's references are re-spelled with spelling.yaml, like the
training data; FLEURS references are scored as they are, exactly as the
accuracy job scores them, so its WER is comparable to models/eval's.

Per condition: clips that carry a recording condition (the owner's takes,
``conditions.py``) are also scored per condition, device x style, with term
accuracy (``per_condition.py``).

Every run appends one row to ``training/results.csv`` (``--results`` for
another file), and one more per condition, named ``<dataset>@<condition>``; the
header is fixed (``RESULT_COLUMNS``) and a file with another header is refused
rather than mixed. Per-clip rows and ``summary.json`` (with ``by_condition`` and
``metrics``, the flat numbers ``per_condition.for_logging`` makes for a tracker)
go to ``<work>/runs/eval/<timestamp>-<backend>-<model>/``; ``run()`` returns the
same report.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from . import audio, console, paths, per_condition
from .conditions import IDS
from .config import config_from_dict, config_hash, key_knobs
from .dataset import SPLITS, read_manifest
from .metrics import score_clip, summarize
from .spelling import Spelling, load_spelling

RESULT_COLUMNS = [
    "timestamp", "git_commit", "backend", "model", "dataset", "n",
    "wer_pct", "wer_ci95_pct", "cer_pct",
    "terms", "terms_strict", "terms_lenient", "term_accuracy_strict_pct", "term_accuracy_lenient_pct",
    "fleurs_n", "fleurs_wer_pct", "fleurs_wer_ci95_pct", "fleurs_cer_pct",
    "config", "config_hash", "lora", "notes",
]
FLEURS_TEST = "fleurs-da_dk-test"


@dataclass(frozen=True)
class EvalClip:
    id: str
    wav: Path
    reference: str
    condition: str = ""


# --- datasets ----------------------------------------------------------------------


def spread(items: list, limit: int | None) -> list:
    """Evenly spread subset, as models/eval's --limit: every (len/limit)-th item."""
    if not limit or limit >= len(items):
        return items
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def fleurs_test(limit: int | None = None) -> list[EvalClip]:
    from . import fleurs
    from .harness import load_fleurs

    root = paths.fleurs_dir()
    fleurs.ensure("test", root)
    return [EvalClip(c.id, c.wav, c.reference) for c in load_fleurs(root, limit)]


def _condition_of(wav: Path) -> str:
    try:
        meta = json.loads(wav.with_suffix(".json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return ""
    cid = meta.get("condition") if isinstance(meta, dict) else None
    return cid if cid in IDS else ""


def clips_from_folder(folder: Path, suffix: str = "") -> list[EvalClip]:
    """``<name>.wav`` + ``<name>.txt`` pairs; a ``<name>.json`` beside them names the condition."""
    clips = []
    for wav in sorted(Path(folder).glob("*.wav")):
        txt = wav.with_suffix(".txt")
        if txt.is_file():
            clips.append(EvalClip(wav.stem + suffix, wav.resolve(), txt.read_text(encoding="utf-8").strip(),
                                  _condition_of(wav)))
    return clips


def exam_clips(recordings: Path, only: str | None = None) -> list[EvalClip]:
    """The exam takes, condition by condition (``recordings/exam/<condition>/``)."""
    from .exam import EXAM_FOLDER

    clips = []
    for cid in IDS:
        if only and cid != only:
            continue
        clips += [EvalClip(c.id, c.wav, c.reference, cid)
                  for c in clips_from_folder(Path(recordings) / EXAM_FOLDER / cid, f".{cid}")]
    return clips


def load_dataset(spec: str, *, run: Path | None = None, build: str | None = None,
                 limit: int | None = None, recordings: Path | None = None) -> tuple[str, list[EvalClip]]:
    """(dataset label, clips) for a ``--dataset`` value."""
    if spec in ("fleurs-test", FLEURS_TEST):
        return FLEURS_TEST, fleurs_test(limit)
    if spec == "exam" or spec.startswith("exam:"):
        only = spec.partition(":")[2] or None
        if only and only not in IDS:
            raise ValueError(f"unknown condition {only!r} in {spec!r}; one of {', '.join(IDS)}")
        clips = exam_clips(recordings if recordings is not None else paths.RECORDINGS, only)
        if not clips:
            raise ValueError("no exam takes yet; record them with: wt-train record --condition <c> --exam")
        return ("exam@" + only if only else "exam"), spread(clips, limit)
    if spec in SPLITS:
        if run is not None:
            manifest, label = run / "dataset" / f"{spec}.jsonl", f"{run.name}:{spec}"
        elif build is not None:
            folder = Path(build) if Path(build).is_dir() else paths.builds_dir() / build
            manifest, label = folder / f"{spec}.jsonl", f"{folder.name}:{spec}"
        else:
            raise ValueError(f"--dataset {spec} needs --run or --build to say whose {spec} split")
        items = read_manifest(manifest)
        return label, spread([EvalClip(i.id, Path(i.audio), i.text, i.condition) for i in items], limit)
    path = Path(spec)
    if path.suffix == ".jsonl" and path.is_file():
        items = read_manifest(path)
        return path.stem, spread([EvalClip(i.id, Path(i.audio), i.text, i.condition) for i in items], limit)
    if path.is_dir():
        clips = clips_from_folder(path)
        if not clips:
            raise ValueError(f"no <name>.wav + <name>.txt pairs in {path}")
        return path.name, spread(clips, limit)
    raise ValueError(f"unknown dataset {spec!r}: use fleurs-test, test, validation, train, exam, a .jsonl "
                     "or a folder")


# --- transcribers --------------------------------------------------------------------


class HFTranscriber:
    """Greedy Transformers decoding of a loaded Whisper model, one clip per window."""

    def __init__(self, model, base, device: str, batch_size: int = 8, max_new_tokens: int = 440):
        self.model, self.base, self.device = model, base, device
        self.batch_size, self.max_new_tokens = batch_size, max_new_tokens

    def transcribe(self, wavs: list[Path], progress=None) -> list[tuple[str, str | None]]:
        import torch

        from . import whisper

        dtype = next(self.model.parameters()).dtype
        out = []
        for start in range(0, len(wavs), self.batch_size):
            batch = wavs[start:start + self.batch_size]
            feats = whisper.features(self.base.feature_extractor, [audio.read_16k_mono(w) for w in batch])
            x = torch.from_numpy(feats).to(self.device, dtype)
            texts = whisper.generate(self.model, self.base.tokens, input_features=x,
                                     max_new_tokens=self.max_new_tokens)
            out += [(t, None) for t in texts]
            if progress:
                progress(len(out), len(wavs))
        return out


class AppTranscriber:
    """The app's batch pipeline. It reads 16 kHz mono 16-bit PCM WAV only, so other
    clips (FLEURS ships 32-bit float) are converted once into ``<work>/cache/pcm16``."""

    def __init__(self, app, model_id: str, cache: Path | None = None, live: bool = False):
        self.app, self.model_id, self.live = app, model_id, live
        self.cache = cache if cache is not None else paths.pcm16_cache_dir()

    def transcribe(self, wavs: list[Path], progress=None) -> list[tuple[str, str | None]]:
        readable = [audio.pcm16_copy(w, self.cache) for w in wavs]
        how = self.app.transcribe_live if self.live else self.app.transcribe
        return [(r.text, r.error) for r in how(readable, self.model_id, progress=progress)]


def merged_lora_model(run: Path, base, dtype, device: str):
    """The base model with the run's adapter merged in (merged in float32, then cast)."""
    import torch
    from peft import PeftModel

    model = base.load(torch.float32, "cpu")
    model = PeftModel.from_pretrained(model, run / "adapter").merge_and_unload()
    return model.to(dtype).to(device).eval()


# --- scoring and results ----------------------------------------------------------------


def score(transcriber, clips: list[EvalClip], spelling: Spelling | None, label: str, log=console.log,
          respell_references: bool = True):
    started = time.time()
    next_report = [0.0]

    def progress(done: int, total: int) -> None:
        if done == total or done >= next_report[0]:
            log(f"  {label}: {done}/{total} clips, {time.time() - started:.0f} s")
            next_report[0] = done + max(1, total / 10)

    log(f"{label}: {len(clips)} clips ...")
    results = transcriber.transcribe([c.wav for c in clips], progress=progress)
    if spelling is not None and respell_references:
        def reference(text: str) -> str:
            return spelling.apply(text)
    else:
        def reference(text: str) -> str:
            return text
    rows = [{**score_clip(c.id, reference(c.reference), text, spelling, error), "wav": str(c.wav),
             "condition": c.condition} for c, (text, error) in zip(clips, results)]
    summary = summarize(rows)
    summary["seconds"] = round(time.time() - started, 1)
    return rows, summary


def git_commit() -> str:
    def git(*args):
        return subprocess.run(["git", "-C", str(paths.REPO), *args], capture_output=True, text=True)

    head = git("rev-parse", "--short=12", "HEAD")
    if head.returncode != 0:
        return ""
    dirty = git("status", "--porcelain", "--untracked-files=no", "--", ".", ":!training/results.csv").stdout.strip()
    return head.stdout.strip() + ("+dirty" if dirty else "")


def _pct(v) -> str:
    return "" if v is None else f"{v * 100:.2f}"


def _ci(s: dict) -> str:
    lo, hi = s["wer_ci95"]
    return f"{lo * 100:.2f} to {hi * 100:.2f}"


def result_row(*, backend: str, model: str, dataset: str, main: dict, fleurs: dict | None,
               run_config: dict | None, notes: str) -> dict:
    row = {
        "timestamp": datetime.now().astimezone().isoformat(timespec="seconds"),
        "git_commit": git_commit(), "backend": backend, "model": model, "dataset": dataset,
        "n": main["n"], "wer_pct": _pct(main["wer"]), "wer_ci95_pct": _ci(main), "cer_pct": _pct(main["cer"]),
        "terms": main["terms"], "terms_strict": main["terms_strict"], "terms_lenient": main["terms_lenient"],
        "term_accuracy_strict_pct": _pct(main["term_accuracy_strict"]),
        "term_accuracy_lenient_pct": _pct(main["term_accuracy_lenient"]),
        "fleurs_n": "", "fleurs_wer_pct": "", "fleurs_wer_ci95_pct": "", "fleurs_cer_pct": "",
        "config": "", "config_hash": "", "lora": "", "notes": notes,
    }
    if fleurs is not None:
        row.update(fleurs_n=fleurs["n"], fleurs_wer_pct=_pct(fleurs["wer"]), fleurs_wer_ci95_pct=_ci(fleurs),
                   fleurs_cer_pct=_pct(fleurs["cer"]))
    if run_config is not None:
        cfg = config_from_dict(run_config["config"])
        source = run_config.get("source") or ""
        if source and Path(source).is_relative_to(paths.REPO):
            source = str(Path(source).relative_to(paths.REPO))
        row.update(config=source, config_hash=config_hash(cfg), lora=json.dumps(key_knobs(cfg), sort_keys=True))
    return row


def append_result(path: Path, row: dict) -> None:
    path = Path(path)
    if path.is_file() and path.stat().st_size > 0:
        with path.open(encoding="utf-8", newline="") as f:
            header = next(csv.reader(f), [])
        if header != RESULT_COLUMNS:
            raise ValueError(f"{path} has another header; move it aside (expected {','.join(RESULT_COLUMNS)})")
        new = False
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        new = True
    with path.open("a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=RESULT_COLUMNS, lineterminator="\n")
        if new:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in RESULT_COLUMNS})


def format_table(entries: list[tuple[str, dict]]) -> str:
    lines = [f"{'dataset':<34} {'clips':>5} {'WER %':>6} {'95 % CI':>15} {'CER %':>6} {'terms strict':>16} "
             f"{'terms lenient':>16}"]
    for name, s in entries:
        def terms(key: str) -> str:
            if not s["terms"]:
                return "-"
            return f"{s[key]}/{s['terms']} ({s[key] / s['terms'] * 100:.1f} %)"

        lines.append(f"{name[:34]:<34} {s['n']:>5} {s['wer'] * 100:>6.2f} {_ci(s):>15} {s['cer'] * 100:>6.2f} "
                     f"{terms('terms_strict'):>16} {terms('terms_lenient'):>16}")
        if s.get("failed"):
            lines.append(f"  {s['failed']} clip(s) failed (empty transcript counted)")
    return "\n".join(lines)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "model"


# --- command line -------------------------------------------------------------------


def _load_run_config(run: Path) -> dict:
    return json.loads((run / "config.json").read_text(encoding="utf-8"))


def gguf_model_id(model: str | None, run: Path | None) -> str:
    if model:
        # Catalog ids end in .gguf too ("walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf"),
        # so only an existing file or an absolute path counts as a path.
        p = Path(model)
        if p.suffix == ".gguf" and (p.is_file() or p.is_absolute()):
            if p.resolve().parent != paths.app_models_dir().resolve():
                raise ValueError(f"{p} is not in the app's models folder ({paths.app_models_dir()}); "
                                 "install it with wt-train export, or pass an app model id")
            return p.stem
        return model
    if run is not None:
        export = run / "export.json"
        if not export.is_file():
            raise ValueError(f"{run.name} has not been exported yet: wt-train export {run.name}")
        return json.loads(export.read_text())["model_id"]
    raise ValueError("--backend gguf needs --model <app model id> or --run")


def main(argv: list[str], log=console.log) -> int:
    return run(argv, log)["exit_code"]


def run(argv: list[str], log=console.log) -> dict:
    """Runs one evaluation; returns its report: ``exit_code``, ``results`` (dataset ->
    summary), ``by_condition`` (the dataset's conditions), ``metrics`` (flat numbers for a
    tracker) and ``out`` (the run folder)."""
    p = argparse.ArgumentParser(prog="wt-train eval", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--backend", choices=["hf", "lora", "gguf"], required=True)
    p.add_argument("--run", help="training run: a folder, its name, or latest (lora; gguf: its export)")
    p.add_argument("--model", help="hf: an HF model folder (default: the pinned Edda); gguf: an app model id")
    p.add_argument("--dataset", default="fleurs-test",
                   help="fleurs-test (default), test, validation, train, exam, exam:<condition>, a .jsonl "
                        "manifest or a wav+txt folder")
    p.add_argument("--recordings", type=Path, default=paths.RECORDINGS, help="the takes folder (for exam)")
    p.add_argument("--live", action="store_true",
                   help="gguf: each clip through the app's live path at real-time speed (the exam)")
    p.add_argument("--build", help="a dataset build (name or folder) for --dataset test/validation/train")
    p.add_argument("--limit", type=int, help="evenly spread subset of N clips of the dataset")
    p.add_argument("--fleurs-limit", type=int, help="FLEURS test clips for the regression check (default all 930)")
    p.add_argument("--no-fleurs", action="store_true", help="skip the FLEURS test regression check")
    p.add_argument("--spelling", type=Path, default=paths.SPELLING_YAML, help="spelling.yaml for term accuracy")
    p.add_argument("--device", choices=["auto", "mps", "cpu"], default="auto", help="hf and lora backends")
    p.add_argument("--batch-size", type=int, default=8, help="hf and lora backends")
    p.add_argument("--app-bin", type=Path, help="WalkieTalkey binary for the gguf backend")
    p.add_argument("--results", type=Path, default=paths.RESULTS_CSV, help="CSV to append to")
    p.add_argument("--notes", default="", help="free text stored with the result")
    a = p.parse_args(argv)

    from .train import resolve_run

    run = resolve_run(a.run) if a.run else None
    if a.backend == "lora" and run is None:
        p.error("--backend lora needs --run")
    if a.live and a.backend != "gguf":
        p.error("--live goes through the app: --backend gguf")
    spelling = load_spelling(a.spelling) if a.spelling and Path(a.spelling).is_file() else None
    run_config = _load_run_config(run) if run is not None else None

    if a.backend == "gguf":
        from .app import find_app

        model_id = gguf_model_id(a.model, run)
        app = find_app(a.app_bin)
        app.check_model(model_id)
        log(f"gguf through the app: {app.bin} ({'batch' if app.supports_batch else 'one call per file'}), "
            f"model {model_id}")
        transcriber, label = AppTranscriber(app, model_id, live=a.live), model_id
    else:
        from . import whisper

        device = whisper.pick_device(a.device)
        dtype = whisper.inference_dtype(device)
        if run_config is not None:
            b = run_config["config"]["base_model"]
            base = whisper.load_base(b["repo"], b["revision"])
        elif a.model:
            base = whisper.load_base(f"local/{Path(a.model).name}", "0" * 40, path=Path(a.model))
        else:
            base = whisper.load_base(paths.EDDA_REPO, paths.EDDA_REVISION)
        if a.backend == "lora":
            model, label = merged_lora_model(run, base, dtype, device), run.name
        else:
            model = base.load(dtype, device)
            label = Path(a.model).name if a.model else f"{base.repo}@{base.revision[:12]}"
        log(f"{a.backend} on {device} ({str(dtype).replace('torch.', '')}): {label}")
        transcriber = HFTranscriber(model, base, device, batch_size=a.batch_size)

    out = paths.eval_runs_dir() / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{a.backend}-{_slug(label)}"
    out.mkdir(parents=True, exist_ok=True)
    name, clips = load_dataset(a.dataset, run=run, build=a.build, limit=a.limit, recordings=a.recordings)
    rows, main_summary = score(transcriber, clips, spelling, name, log, respell_references=name != FLEURS_TEST)
    by_condition = per_condition.summaries(rows)
    entries = [(name, main_summary)]
    _write_rows(out / f"{_slug(name)}.jsonl", rows)
    fleurs_summary = None
    if name == FLEURS_TEST:
        fleurs_summary = main_summary
    elif not a.no_fleurs:
        frows, fleurs_summary = score(transcriber, fleurs_test(a.fleurs_limit), spelling, FLEURS_TEST, log,
                                      respell_references=False)
        entries.append((FLEURS_TEST, fleurs_summary))
        _write_rows(out / f"{FLEURS_TEST}.jsonl", frows)
    metrics = per_condition.for_logging(main_summary, by_condition, name)
    if fleurs_summary is not None and name != FLEURS_TEST:
        metrics.update(per_condition.for_logging(fleurs_summary, {}, FLEURS_TEST))
    (out / "summary.json").write_text(json.dumps(
        {"backend": a.backend, "model": label, "results": dict(entries), "by_condition": by_condition,
         "metrics": metrics}, indent=2, ensure_ascii=False) + "\n")

    row = result_row(backend=a.backend, model=label, dataset=name, main=main_summary, fleurs=fleurs_summary,
                     run_config=run_config, notes=a.notes)
    append_result(a.results, row)
    for cid, summary in by_condition.items():
        append_result(a.results, result_row(backend=a.backend, model=label, dataset=f"{name}@{cid}", main=summary,
                                            fleurs=None, run_config=run_config, notes=a.notes))
    log("")
    log(format_table(entries + [(f"{name}@{cid}", s) for cid, s in by_condition.items()]))
    log(f"per-clip rows: {out}")
    log(f"appended to {a.results}")
    code = 0 if all(s["failed"] == 0 for _, s in entries) else 1
    return {"exit_code": code, "results": dict(entries), "by_condition": by_condition, "metrics": metrics,
            "out": out}


def _write_rows(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
