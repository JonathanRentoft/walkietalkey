"""wt_eval command line.

  python -m wt_eval run --cli <transcribe-cli> --model NAME=PATH[@TIMESTAMPS] ...
                        (--fleurs-dir DIR | --clips-dir DIR) [--limit N] --out DIR
  python -m wt_eval score OUT_DIR

TIMESTAMPS is "auto" (the app's default, no flag) or "none".
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

from .datasets import Clip, load_clips_dir, load_fleurs, prepare_audio
from .engine import Result, TranscribeCli
from .vadsplit import cut_segments, vad_segments
from .normalize import normalize_pair
from .punctuation import count_marks, needs_pnc, word_count
from .wer import Counts, bootstrap_ci, corpus_wer, word_errors


@dataclass(frozen=True)
class ModelSpec:
    name: str
    path: Path
    timestamps: str = "auto"

    @staticmethod
    def parse(spec: str) -> "ModelSpec":
        if "=" not in spec:
            raise argparse.ArgumentTypeError(f"--model wants NAME=PATH[@auto|@none], got {spec!r}")
        name, rest = spec.split("=", 1)
        timestamps = "auto"
        if "@" in rest:
            rest, timestamps = rest.rsplit("@", 1)
            if timestamps not in ("auto", "none"):
                raise argparse.ArgumentTypeError(f"timestamps must be auto or none, got {timestamps!r}")
        return ModelSpec(name=name, path=Path(rest), timestamps=timestamps)


def score_row(clip: Clip, hypothesis: str, compute_ms: float, error: str | None) -> dict:
    ref_norm, hyp_norm = normalize_pair(clip.reference, hypothesis)
    c = word_errors(ref_norm.split(), hyp_norm.split())
    marks, words = count_marks(hypothesis), word_count(hypothesis)
    return {
        "id": clip.id, "wav": str(clip.wav), "seconds": clip.seconds,
        "reference": clip.reference, "hypothesis": hypothesis,
        "ref_norm": ref_norm, "hyp_norm": hyp_norm,
        "sub": c.sub, "del": c.dele, "ins": c.ins, "ref_words": c.ref, "errors": c.errors,
        "marks": marks, "words": words, "pnc_trigger": needs_pnc(hypothesis),
        "ref_marks": count_marks(clip.reference), "ref_words_raw": word_count(clip.reference),
        "compute_ms": compute_ms, "error": error,
    }


def summarize(rows: list[dict]) -> dict:
    counts = [Counts(sub=r["sub"], dele=r["del"], ins=r["ins"], ref=r["ref_words"]) for r in rows]
    marks = sum(r["marks"] for r in rows)
    words = sum(r["words"] for r in rows)
    ref_marks = sum(r["ref_marks"] for r in rows)
    ref_words = sum(r["ref_words_raw"] for r in rows)
    trig = sum(1 for r in rows if r["pnc_trigger"])
    n = len(rows)
    return {
        "clips": n,
        "wer": corpus_wer(counts),
        "wer_ci95": list(bootstrap_ci(counts)),
        "substitutions": sum(c.sub for c in counts),
        "deletions": sum(c.dele for c in counts),
        "insertions": sum(c.ins for c in counts),
        "reference_words": sum(c.ref for c in counts),
        "marks_per_25_words": marks / words * 25 if words else 0.0,
        "pnc_trigger_clips": trig,
        "pnc_trigger_rate": trig / n if n else 0.0,
        "reference_marks_per_25_words": ref_marks / ref_words * 25 if ref_words else 0.0,
        "empty_outputs": sum(1 for r in rows if not r["hypothesis"]),
        "failed_clips": sum(1 for r in rows if r["error"]),
        "audio_seconds": round(sum(r["seconds"] for r in rows), 2),
        "compute_seconds": round(sum(r["compute_ms"] for r in rows) / 1000, 2),
    }


def write_summary(out: Path) -> dict:
    meta = json.loads((out / "run.json").read_text())
    models = {}
    for spec in meta["models"]:
        rows = [json.loads(l) for l in (out / f"{spec['name']}.jsonl").read_text(encoding="utf-8").splitlines() if l]
        models[spec["name"]] = {**summarize(rows), "path": spec["path"], "timestamps": spec["timestamps"]}
    summary = {"dataset": meta["dataset"], "engine": meta["engine"], "models": models}
    (out / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    lines = [
        f"Dataset: {meta['dataset']['name']} ({meta['dataset']['clips']} clips). "
        f"Engine: {meta['engine']['cli']} backend={meta['engine']['backend']}, language={meta['engine']['language']}.",
        "",
        "| model | timestamps | clips | WER % | 95 % CI | S | D | I | marks per 25 words | clips < 1 mark/25 words (DESK-41) |",
        "|---|---|---:|---:|---|---:|---:|---:|---:|---:|",
    ]
    for name, s in models.items():
        lo, hi = s["wer_ci95"]
        lines.append(
            f"| {name} | {s['timestamps']} | {s['clips']} | {s['wer'] * 100:.2f} | {lo * 100:.2f} to {hi * 100:.2f} | {s['substitutions']} | "
            f"{s['deletions']} | {s['insertions']} | {s['marks_per_25_words']:.2f} | "
            f"{s['pnc_trigger_clips']} ({s['pnc_trigger_rate'] * 100:.1f} %) |"
        )
    if models:
        ref = next(iter(models.values()))["reference_marks_per_25_words"]
        lines += ["", f"References: {ref:.2f} marks per 25 words."]
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    return summary


def cmd_run(a: argparse.Namespace) -> int:
    if a.clips_dir:
        clips = prepare_audio(load_clips_dir(a.clips_dir, a.limit), Path(a.out) / "audio-16k")
        dataset = {"name": "clips-dir", "path": str(a.clips_dir)}
    else:
        clips = load_fleurs(a.fleurs_dir, a.limit)
        dataset = {"name": "fleurs-da_dk-test", "path": str(a.fleurs_dir), "revision": "70bb2e84b976b7e960aa89f1c648e09c59f894dd"}
    if not clips:
        print("error: no clips found", file=sys.stderr)
        return 2
    dataset.update(clips=len(clips), limit=a.limit)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    plan: dict[str, list[Path]] = {}
    if a.split_vad:
        dataset["split_vad"] = str(a.split_vad)
        clips = prepare_audio(clips, out / "audio-16k", pcm16_only=True)
        for clip in clips:
            segments = vad_segments(Path(a.cli), a.split_vad, clip.wav)
            plan[clip.id] = cut_segments(clip.wav, segments, out / "segments")
    meta = {
        "dataset": dataset,
        "engine": {"cli": str(a.cli), "backend": a.backend, "language": a.language, "threads": a.threads},
        "models": [{"name": m.name, "path": str(m.path), "timestamps": m.timestamps} for m in a.model],
    }
    (out / "run.json").write_text(json.dumps(meta, indent=2) + "\n")
    for m in a.model:
        done = out / f"{m.name}.jsonl"
        if a.resume and done.is_file() and len(done.read_text(encoding="utf-8").splitlines()) == len(clips):
            print(f"{m.name}: kept ({len(clips)} rows from an earlier run)", file=sys.stderr, flush=True)
            continue
        engine = TranscribeCli(cli=Path(a.cli), backend=a.backend, timestamps=m.timestamps, threads=a.threads)
        print(f"{m.name}: {len(clips)} clips ...", file=sys.stderr, flush=True)
        if plan:
            flat = [p for clip in clips for p in plan[clip.id]]
            by_path = dict(zip(flat, engine.transcribe(m.path, flat, language=a.language)))
            results = []
            for clip in clips:
                parts = [by_path[p] for p in plan[clip.id]]
                results.append(Result(
                    file=str(clip.wav), text=" ".join(r.text for r in parts if r.text),
                    compute_ms=sum(r.compute_ms for r in parts),
                    error=next((r.error for r in parts if r.error), None)))
        else:
            results = engine.transcribe(m.path, [c.wav for c in clips], language=a.language)
        with (out / f"{m.name}.jsonl").open("w", encoding="utf-8") as f:
            for clip, r in zip(clips, results):
                f.write(json.dumps(score_row(clip, r.text, r.compute_ms, r.error), ensure_ascii=False) + "\n")
    summary = write_summary(out)
    print((out / "summary.md").read_text())
    return 0 if all(s["failed_clips"] == 0 for s in summary["models"].values()) else 1


def cmd_score(a: argparse.Namespace) -> int:
    write_summary(Path(a.out))
    print((Path(a.out) / "summary.md").read_text())
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="wt_eval", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="transcribe clips with each model and score them")
    r.add_argument("--cli", required=True, type=Path, help="transcribe.cpp transcribe-cli binary")
    r.add_argument("--model", required=True, action="append", type=ModelSpec.parse,
                   help="NAME=PATH[@auto|@none], repeatable")
    src = r.add_mutually_exclusive_group(required=True)
    src.add_argument("--fleurs-dir", type=Path, help="fleurs-da_dk folder from fetch_fleurs.sh")
    src.add_argument("--clips-dir", type=Path, help="folder outside the repo with <name>.wav + <name>.txt")
    r.add_argument("--limit", type=int, help="evenly spread subset of N clips")
    r.add_argument("--language", default="da")
    r.add_argument("--backend", default="auto")
    r.add_argument("--threads", type=int)
    r.add_argument("--out", required=True, type=Path)
    r.add_argument("--resume", action="store_true",
                   help="keep <out>/<model>.jsonl files that already have a row for every clip")
    r.add_argument("--split-vad", type=Path, metavar="VAD.gguf",
                   help="split each clip at its pauses with this Silero VAD GGUF and decode every "
                        "speech segment as its own window")
    r.set_defaults(func=cmd_run)
    s = sub.add_parser("score", help="recompute summary.json/summary.md from the per-clip rows")
    s.add_argument("out", type=Path)
    s.set_defaults(func=cmd_score)
    a = p.parse_args(argv)
    return a.func(a)
