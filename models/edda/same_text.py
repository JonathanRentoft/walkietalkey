"""DESK-29 "same text as the original" check.

Transcribes real Danish clips with the original Transformers model (through
transcribe.cpp's own reference code path: scripts/dump_reference_whisper_transformers.py,
fp32 CPU, greedy, language forced, <|notimestamps|> as Edda was trained) and with
our GGUF files through transcribe-cli (language forced), then reports exact and
normalised text equality per clip.

Both sides are also run with Whisper's segment timestamps on (Transformers
`return_timestamps=True`; transcribe-cli `--timestamps auto`, the engine's and
Handy's default), because Edda was fine-tuned without timestamp tokens and
drops words in that mode. Primary result: timestamps off on both sides.

Run inside transcribe.cpp's whisper reference env:
    uv run --project <tcpp>/scripts/envs/whisper python models/edda/same_text.py \
        --tcpp <tcpp> --model <edda snapshot> --gguf <a.gguf> [--gguf <b.gguf> ...] \
        --out <report.json> clip1.wav clip2.wav ...
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def load_reference_module(tcpp: Path):
    path = tcpp / "scripts" / "dump_reference_whisper_transformers.py"
    spec = importlib.util.spec_from_file_location("dump_reference_whisper", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["dump_reference_whisper"] = module
    spec.loader.exec_module(module)
    return module


def norm(text: str) -> str:
    """transcribe.cpp validate.py's normalized compare: lower case, punctuation to spaces."""
    return " ".join(re.sub(r"[^\w\s]+", " ", text.lower()).split())


def reference_texts(tcpp: Path, model_dir: str, clips: list[Path], language: str) -> tuple[list[str], list[str]]:
    """(timestamps off, timestamps on) reference transcripts."""
    import torch

    ref = load_reference_module(tcpp)
    args = argparse.Namespace(model=model_dir, device="cpu", torch_threads=0, max_new_tokens=440)
    processor, model = ref.load_reference(args)
    off, on = [], []
    for clip in clips:
        pcm, sr = ref.load_audio(clip)
        inputs = ref.frontend_inputs(processor, pcm, sr, "cpu")
        out = ref.generate_transcript(
            model=model, processor=processor, inputs=inputs, language=language,
            task="transcribe", source={}, args=args,
        )
        off.append(out["text"])
        with torch.inference_mode():
            ids = model.generate(
                input_features=inputs["input_features"], language=language, task="transcribe",
                return_timestamps=True, do_sample=False, num_beams=1, max_new_tokens=args.max_new_tokens,
            )
        text = processor.tokenizer.decode(ids[0], skip_special_tokens=True)
        on.append(re.sub(r"<\|\d+\.\d+\|>", "", text).strip())
        print(f"ref  {clip.name}\n  off: {off[-1]}\n  on:  {on[-1]}", flush=True)
    return off, on


def gguf_texts(cli: Path, gguf: Path, clips: list[Path], language: str, backend: str,
               timestamps: str) -> list[str]:
    with tempfile.TemporaryDirectory() as td:
        listing = Path(td) / "clips.list"
        listing.write_text("".join(f"{c}\n" for c in clips))
        cmd = [str(cli), "-q", "-m", str(gguf), "-l", language, "--timestamps", timestamps,
               "--backend", backend, "--batch", str(listing), "--batch-jsonl"]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
    rows = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
    by_name = {Path(r["file"]).name: r for r in rows if "file" in r}
    return [by_name[clip.name].get("text", "").strip() for clip in clips]


def compare(clips: list[Path], ref: list[str], hyp: list[str]) -> dict:
    exact = [h == r for h, r in zip(hyp, ref)]
    normalised = [norm(h) == norm(r) for h, r in zip(hyp, ref)]
    return {
        "exact_matches": sum(exact), "normalized_matches": sum(normalised), "n": len(ref),
        "mismatches": [{"clip": c.name, "reference": r, "gguf": h}
                       for c, r, h, e in zip(clips, ref, hyp, exact) if not e],
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tcpp", type=Path, required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--gguf", type=Path, action="append", required=True)
    p.add_argument("--cli", type=Path)
    p.add_argument("--backend", default="auto")
    p.add_argument("--language", default="da")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("clips", nargs="+", type=Path)
    a = p.parse_args()
    cli = a.cli or a.tcpp / "build" / "bin" / "transcribe-cli"

    t0 = time.time()
    ref_off, ref_on = reference_texts(a.tcpp, a.model, a.clips, a.language)
    report = {
        "language": a.language, "backend": a.backend,
        "reference": "transformers fp32 CPU, greedy; 'off' = <|notimestamps|>, 'on' = return_timestamps=True",
        "clips": [c.name for c in a.clips],
        "reference_off": ref_off, "reference_on": ref_on,
        "reference_on_equals_off": sum(x == y for x, y in zip(ref_on, ref_off)),
        "gguf": {},
    }
    ok = True
    for gguf in a.gguf:
        entry = {}
        for ts, ref in (("none", ref_off), ("auto", ref_on)):
            hyp = gguf_texts(cli, gguf, a.clips, a.language, a.backend, ts)
            entry[f"timestamps_{ts}"] = {"texts": hyp, **compare(a.clips, ref, hyp)}
            c = entry[f"timestamps_{ts}"]
            print(f"{gguf.name} [{a.backend}] timestamps {ts} vs reference "
                  f"{'off' if ts == 'none' else 'on'}: exact {c['exact_matches']}/{c['n']}, "
                  f"normalized {c['normalized_matches']}/{c['n']}")
        report["gguf"][gguf.name] = entry
        ok = ok and entry["timestamps_none"]["exact_matches"] == len(ref_off)
    report["seconds"] = round(time.time() - t0, 1)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
