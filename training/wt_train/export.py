"""``wt-train export <run>``: the run's adapter as a model the app can select.

Steps, each in ``<work>/exports/edda-ft-<slug>/``:

1. **Merge** the LoRA weights into the base model (in float32, saved as
   float16 like Edda itself) as a Hugging Face folder, with the base model's
   tokenizer, front-end and generation files copied unchanged.
2. **Convert** it to an F16 GGUF with transcribe.cpp 0.4.0's
   ``scripts/convert-whisper.py`` (wrapped by ``convert_gguf.py`` to set
   ``general.name`` and ``stt.variant``), as models/edda/convert.sh did for
   the shipped Edda.
3. **Quantise** to Q8_0 with ``transcribe-quantize``.
4. **Verify** that the GGUF gives the merged model's text: ``export.verify_clips``
   validation clips (the owner's takes first) through the merged model
   (Transformers, float32 on the CPU, greedy, timestamps off, the reference
   models/edda/same_text.py used) and through transcribe-cli (``-l da
   --timestamps none``). Exact and normalised matches are reported. Tolerance:
   at most ``export.max_differing_clips`` clips may differ after the accuracy
   job's normalisation, otherwise the export fails and nothing is installed.
   Q8_0 rounding can flip a word now and then (the shipped Edda matched 10 of
   10); more than that means the conversion went wrong.
5. **Install** the Q8_0 file as ``<app models folder>/edda-ft-<slug>.gguf``: the
   app lists any GGUF there under its file stem as id and its ``general.name``
   as name, and decodes ``edda-`` ids like Edda. Next to it goes
   ``edda-ft-<slug>.README.md``, the model card from
   ``training/model-card/TEMPLATE.md``.

Refusals: a slug that is not ``[a-z0-9-]+``; the shipped Edda file; an existing
file unless ``--force``, and even then only a file an earlier export wrote
(its ``stt.variant`` is the same id). The merged folder and the F16 GGUF are
deleted after a successful install unless ``--keep-intermediate``. Nothing is
ever uploaded.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import console, paths
from .audio import file_sha256
from .config import SLUG_RE, config_from_dict, key_knobs
from .dataset import SOURCE_RECORDING, read_manifest
from .gguf import Tools, read_metadata, transcribe_cpp
from .harness import normalize

MODEL_PREFIX = "edda-ft-"
# Files of the base snapshot the converter and the processor read, copied unchanged.
BASE_FILES = ("generation_config.json", "preprocessor_config.json", "processor_config.json", "tokenizer.json",
              "tokenizer_config.json", "vocab.json", "merges.txt", "added_tokens.json", "normalizer.json",
              "special_tokens_map.json")


class ExportError(RuntimeError):
    pass


def model_id(slug: str) -> str:
    if not SLUG_RE.fullmatch(slug or ""):
        raise ExportError(f"slug {slug!r} must be lower-case letters, digits and -")
    return MODEL_PREFIX + slug


def install_paths(mid: str, models_dir: Path) -> tuple[Path, Path]:
    return models_dir / f"{mid}.gguf", models_dir / f"{mid}.README.md"


def check_install_target(target: Path, mid: str, force: bool) -> None:
    if target.name == paths.SHIPPED_EDDA_FILE or not target.name.startswith(MODEL_PREFIX):
        raise ExportError(f"refusing to write {target.name}: exports are named {MODEL_PREFIX}<slug>.gguf "
                          f"and never replace the shipped {paths.SHIPPED_EDDA_FILE}")
    if not target.exists():
        return
    if not force:
        raise ExportError(f"{target} exists; pass --force to replace your own earlier export")
    try:
        variant = read_metadata(target, {"stt.variant"}).get("stt.variant")
    except (OSError, ValueError):
        variant = None
    if variant != mid:
        raise ExportError(f"refusing to replace {target}: it was not written by an export of {mid} "
                          f"(stt.variant {variant!r})")


# --- steps -------------------------------------------------------------------------


def merge(run: Path, base, out_dir: Path) -> Path:
    """Base + adapter, merged in float32 and saved as float16, with the base's tokenizer files."""
    import torch
    from peft import PeftModel

    model = base.load(torch.float32, "cpu")
    model = PeftModel.from_pretrained(model, run / "adapter").merge_and_unload()
    model = model.to(torch.float16)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    model.save_pretrained(out_dir)
    del model
    for name in BASE_FILES:
        src = Path(base.path) / name
        if src.is_file():
            shutil.copyfile(src, out_dir / name)
    return out_dir


def convert(tools: Tools, hf_dir: Path, out: Path, mid: str, name: str, repo_id: str, run_cmd=subprocess.run) -> Path:
    script = Path(__file__).with_name("convert_gguf.py")
    # -I keeps this package's folder off sys.path, so the converter's own
    # "import gguf" finds the gguf library, not wt_train/gguf.py. The workbench's
    # virtualenv is not the converter's; uv would only warn about it.
    env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
    run_cmd([*tools.python(), "-I", str(script), str(tools.converter), str(hf_dir), str(out),
             "--variant", mid, "--name", name, "--repo-id", repo_id], check=True, env=env)
    return out


def quantize(tools: Tools, f16: Path, q8: Path, run_cmd=subprocess.run) -> Path:
    run_cmd([str(tools.quantize), str(f16), str(q8), "--quant", "Q8_0"], check=True)
    return q8


def verify_clips(run: Path, n: int) -> list:
    """The first n validation clips, the owner's takes before rehearsal clips."""
    items = read_manifest(run / "dataset" / "validation.jsonl")
    items.sort(key=lambda i: (i.source != SOURCE_RECORDING, i.id))
    return items[:n]


def compare(reference: list[str], gguf: list[str], max_differing: int) -> dict:
    exact = [a.strip() == b.strip() for a, b in zip(reference, gguf)]
    normalised = [normalize(a) == normalize(b) for a, b in zip(reference, gguf)]
    differing = len(reference) - sum(normalised)
    return {
        "n": len(reference), "exact_matches": sum(exact), "normalized_matches": sum(normalised),
        "differing": differing, "max_differing_clips": max_differing, "passed": differing <= max_differing,
        "mismatches": [{"index": i, "merged": a, "gguf": b}
                       for i, (a, b, e) in enumerate(zip(reference, gguf, exact)) if not e],
    }


def render_card(template: str, fields: dict) -> str:
    text = template
    for key, value in fields.items():
        text = text.replace("{{" + key + "}}", str(value))
    if "{{" in text:
        start = text.index("{{")
        raise ExportError(f"model card template has an unknown field {text[start:text.index('}}', start) + 2]}")
    return text


# --- the whole export --------------------------------------------------------------


def _reference_texts(merged_dir: Path, base, wavs: list[Path], device: str) -> list[str]:
    import torch

    from .evaluate import HFTranscriber
    from .whisper import Base

    merged = Base(path=merged_dir, repo=base.repo, revision=base.revision,
                  feature_extractor=base.feature_extractor, tokens=base.tokens)
    dtype = torch.float32 if device == "cpu" else torch.float16
    model = merged.load(dtype, device)
    texts = [t for t, _ in HFTranscriber(model, merged, device, batch_size=4).transcribe(wavs)]
    del model
    return texts


def _gguf_texts(tools: Tools, gguf: Path, wavs: list[Path]) -> list[str]:
    from .harness import TranscribeCli

    results = TranscribeCli(cli=tools.cli, timestamps="none").transcribe(gguf, wavs, language="da")
    failed = [r for r in results if r.error]
    if failed:
        raise ExportError(f"transcribe-cli failed on {failed[0].file}: {failed[0].error}")
    return [r.text for r in results]


def export_run(run: Path, *, slug: str | None = None, name: str | None = None, force: bool = False,
               keep_intermediate: bool = False, n_verify: int | None = None, max_differing: int | None = None,
               reference_device: str = "cpu", tools: Tools | None = None, base=None, run_cmd=subprocess.run,
               reference_texts: Callable | None = None, gguf_texts: Callable | None = None, log=console.log) -> dict:
    run = Path(run)
    saved = json.loads((run / "config.json").read_text(encoding="utf-8"))
    cfg = config_from_dict(saved["config"])
    slug = slug or cfg.export.slug
    name = name or cfg.export.name
    n_verify = n_verify or cfg.export.verify_clips
    max_differing = cfg.export.max_differing_clips if max_differing is None else max_differing
    if not (run / "adapter" / "adapter_config.json").is_file():
        raise ExportError(f"{run} has no adapter/ (the run did not finish)")
    mid = model_id(slug)
    models_dir = paths.app_models_dir()
    target, card_path = install_paths(mid, models_dir)
    check_install_target(target, mid, force)
    clips = verify_clips(run, n_verify)
    if not clips:
        raise ExportError(f"{run} has no validation clips to verify the export with")

    if base is None:
        from .whisper import load_base

        base = load_base(cfg.base_model.repo, cfg.base_model.revision)
    tools = tools or transcribe_cpp(log=log)
    work = paths.exports_dir() / mid
    work.mkdir(parents=True, exist_ok=True)
    timings: dict[str, float] = {}

    def step(label: str, fn):
        started = time.time()
        log(f"{label} ...")
        out = fn()
        timings[label] = round(time.time() - started, 1)
        return out

    hf_dir = step("merge", lambda: merge(run, base, work / "hf"))
    f16 = step("convert", lambda: convert(tools, hf_dir, work / f"{mid}-F16.gguf", mid, name, cfg.base_model.repo,
                                          run_cmd))
    q8 = step("quantise", lambda: quantize(tools, f16, work / f"{mid}-Q8_0.gguf", run_cmd))
    meta = read_metadata(q8, {"general.name", "stt.variant"})
    if meta.get("general.name") != name or meta.get("stt.variant") != mid:
        raise ExportError(f"{q8} has general.name {meta.get('general.name')!r} and stt.variant "
                          f"{meta.get('stt.variant')!r}, expected {name!r} and {mid!r}")

    wavs = [Path(c.audio) for c in clips]
    if reference_texts is None:
        def reference_texts(w):
            return _reference_texts(hf_dir, base, w, reference_device)
    if gguf_texts is None:
        def gguf_texts(w):
            return _gguf_texts(tools, q8, w)
    ref = step("verify (merged model)", lambda: reference_texts(wavs))
    hyp = step("verify (GGUF)", lambda: gguf_texts(wavs))
    report = compare(ref, hyp, max_differing)
    report["clips"] = [c.id for c in clips]
    (work / "verify.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    log(f"same text: exact {report['exact_matches']}/{report['n']}, "
        f"normalised {report['normalized_matches']}/{report['n']}")
    if not report["passed"]:
        raise ExportError(f"the GGUF differs from the merged model on {report['differing']} of {report['n']} "
                          f"clips (allowed {max_differing}); see {work / 'verify.json'}. Nothing was installed.")

    def install() -> None:
        models_dir.mkdir(parents=True, exist_ok=True)
        partial = models_dir / f".{target.name}.partial"
        shutil.copyfile(q8, partial)
        os.replace(partial, target)

    step("install", install)
    sha, size = file_sha256(target), target.stat().st_size
    best = json.loads((run / "best.json").read_text())
    info = json.loads((run / "run.json").read_text()) if (run / "run.json").is_file() else {}
    summary = json.loads((run / "dataset.json").read_text())["summary"]
    train_split = summary["splits"]["train"]
    baseline = info.get("baseline_validation_wer")
    fields = {
        "display_name": name, "model_id": mid, "file_name": target.name, "size_bytes": f"{size:,}",
        "sha256": sha, "transcribe_cpp_version": paths.TRANSCRIBE_CPP_VERSION,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base_repo": cfg.base_model.repo, "base_revision": cfg.base_model.revision, "run_name": run.name,
        "config_source": saved.get("source") or "", "config_hash": saved["hash"],
        "lora_knobs": json.dumps(key_knobs(cfg), sort_keys=True),
        "takes_train": train_split["by_source"].get(SOURCE_RECORDING, 0),
        "rehearsal_train": train_split["by_source"].get("fleurs-train", 0),
        "validation_clips": summary["splits"]["validation"]["clips"],
        "best_epoch": best["epoch"], "validation_wer": f"{best['validation_wer'] * 100:.2f}",
        "baseline_validation_wer": f"{baseline * 100:.2f}" if baseline is not None else "not measured",
        "verify_n": report["n"], "verify_exact": report["exact_matches"],
        "verify_normalized": report["normalized_matches"],
    }
    card_path.write_text(render_card(paths.MODEL_CARD_TEMPLATE.read_text(encoding="utf-8"), fields),
                         encoding="utf-8")

    result = {
        "model_id": mid, "name": name, "path": str(target), "card": str(card_path), "sha256": sha,
        "size_bytes": size, "run": run.name, "verify": {k: report[k] for k in
                                                        ("n", "exact_matches", "normalized_matches", "passed")},
        "seconds": timings, "intermediate_kept": keep_intermediate, "work": str(work),
    }
    if not keep_intermediate:
        shutil.rmtree(hf_dir, ignore_errors=True)
        f16.unlink(missing_ok=True)
    q8.unlink(missing_ok=True)  # the installed copy is the one that counts
    for where in (run / "export.json", work / "export.json"):
        where.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    log(f"installed {mid} ({name}) at {target}")
    return result


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train export", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("run", help="training run: a folder, its name, or latest")
    p.add_argument("--slug", help="instead of the config's export.slug (the id becomes edda-ft-<slug>)")
    p.add_argument("--name", help="instead of the config's export.name (shown in the app)")
    p.add_argument("--verify-clips", type=int, help="instead of the config's export.verify_clips")
    p.add_argument("--reference-device", choices=["cpu", "mps"], default="cpu",
                   help="where the merged model runs for the same-text check (cpu: float32, the reference)")
    p.add_argument("--force", action="store_true", help="replace an earlier export of the same id")
    p.add_argument("--keep-intermediate", action="store_true", help="keep the merged folder and the F16 GGUF")
    a = p.parse_args(argv)
    from .train import resolve_run

    try:
        result = export_run(resolve_run(a.run), slug=a.slug, name=a.name, force=a.force,
                            keep_intermediate=a.keep_intermediate, n_verify=a.verify_clips,
                            reference_device=a.reference_device)
    except ExportError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"select \"{result['name']}\" in WalkieTalkey, or: wt-train eval --backend gguf --model {result['model_id']}"
          " --dataset test --run " + result["run"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
