"""Convert a merged fine-tune of Edda to an F16 GGUF with transcribe.cpp's own converter.

Runs inside transcribe.cpp's whisper environment, like models/edda/convert_edda.py,
and does what that wrapper does: transcribe.cpp's scripts/convert-whisper.py only
accepts variant slugs it knows (each maps to a display name), so this registers
the fine-tune's slug (the app model id, "edda-ft-<slug>") with the name the app
shows, then runs the upstream converter unchanged. The converter writes that name
as ``general.name`` and the slug as ``stt.variant``; ``--repo-id`` (the base
model's) gives ``general.author``/``organization``, and its licence metadata
(Apache-2.0) is Edda's licence. Nothing else in the converter is touched.

Only the standard library is used here: this file runs in transcribe.cpp's
environment, where the workbench package is not installed. Run it with
``python -I``, so its own folder (which holds wt_train/gguf.py) is not on
sys.path when the converter imports the gguf library.

Usage:
    uv run --project <tcpp>/scripts/envs/whisper python -I convert_gguf.py \\
        <tcpp>/scripts/convert-whisper.py <merged model dir> <out.gguf> \\
        --variant edda-ft-<slug> --name "<display name>" --repo-id danish-foundation-models/edda-v0.2
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("converter", type=Path)
    p.add_argument("model_dir", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--variant", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--repo-id", required=True)
    a = p.parse_args(argv)
    spec = importlib.util.spec_from_file_location("convert_whisper", a.converter)
    if spec is None or spec.loader is None:
        print(f"error: cannot load {a.converter}", file=sys.stderr)
        return 2
    module = importlib.util.module_from_spec(spec)
    sys.modules["convert_whisper"] = module
    spec.loader.exec_module(module)
    module.VARIANT_DISPLAY_NAMES[a.variant] = a.name
    a.out.parent.mkdir(parents=True, exist_ok=True)
    return int(module.main([str(a.converter), str(a.model_dir), str(a.out),
                            "--repo-id", a.repo_id, "--variant", a.variant]) or 0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
