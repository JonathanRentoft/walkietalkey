"""DESK-29 "same text as the original" check.

Transcribes real Danish clips with the original Transformers model (through
transcribe.cpp's own reference code path: scripts/dump_reference_whisper_transformers.py,
fp32 CPU, greedy, language forced, no timestamps) and with our GGUF files
through transcribe-cli (language forced, --timestamps none), then reports exact
and normalised text equality per clip.

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


def reference_texts(tcpp: Path, model_dir: str, clips: list[Path], language: str) -> list[str]:
    ref = load_reference_module(tcpp)
    args = argparse.Namespace(model=model_dir, device="cpu", torch_threads=0, max_new_tokens=440)
    processor, model = ref.load_reference(args)
    texts = []
    for clip in clips:
        pcm, sr = ref.load_audio(clip)
        inputs = ref.frontend_inputs(processor, pcm, sr, "cpu")
        out = ref.generate_transcript(
            model=model, processor=processor, inputs=inputs, language=language,
            task="transcribe", source={}, args=args,
        )
        texts.append(out["text"])
        print(f"ref  {clip.name}: {out['text']}", flush=True)
    return texts


def gguf_texts(cli: Path, gguf: Path, clips: list[Path], language: str, backend: str) -> list[str]:
    with tempfile.TemporaryDirectory() as td:
        listing = Path(td) / "clips.list"
        listing.write_text("".join(f"{c}\n" for c in clips))
        cmd = [str(cli), "-q", "-m", str(gguf), "-l", language, "--timestamps", "none",
               "--backend", backend, "--batch", str(listing), "--batch-jsonl"]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
    rows = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
    by_path = {Path(r["file"]).name if "file" in r else Path(r["path"]).name: r for r in rows}
    texts = []
    for clip in clips:
        row = by_path[clip.name]
        texts.append(row["text"].strip())
    return texts


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
    ref = reference_texts(a.tcpp, a.model, a.clips, a.language)
    report = {"language": a.language, "reference": "transformers fp32 CPU, greedy, no timestamps",
              "clips": [c.name for c in a.clips], "reference_texts": ref, "gguf": {}}
    ok = True
    for gguf in a.gguf:
        hyp = gguf_texts(cli, gguf, a.clips, a.language, a.backend)
        exact = [h == r for h, r in zip(hyp, ref)]
        normalised = [norm(h) == norm(r) for h, r in zip(hyp, ref)]
        report["gguf"][gguf.name] = {
            "backend": a.backend, "texts": hyp,
            "exact_matches": sum(exact), "normalized_matches": sum(normalised), "n": len(ref),
            "mismatches": [{"clip": c.name, "reference": r, "gguf": h}
                           for c, r, h, e in zip(a.clips, ref, hyp, exact) if not e],
        }
        print(f"{gguf.name}: exact {sum(exact)}/{len(ref)}, normalized {sum(normalised)}/{len(ref)}")
        ok = ok and all(exact)
    report["seconds"] = round(time.time() - t0, 1)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
