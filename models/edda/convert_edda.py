"""Convert Edda v0.2 to a reference-dtype (F16) GGUF with transcribe.cpp's own
Whisper converter.

transcribe.cpp's scripts/convert-whisper.py only accepts variant slugs it knows
(it maps each to a display name). Edda is an unmodified Whisper large-v3-turbo
architecture, so the converter handles it as-is; this wrapper only registers
the slug "edda-v0.2" with the display name "Edda v0.2" (Handy shows
general.name for models it finds in its custom models folder) and then runs the
upstream converter unchanged. Nothing else in the converter is touched: the
licence metadata it writes (Apache-2.0) is already Edda's licence, and
general.author/organization are derived from the repo id.

Usage (inside transcribe.cpp's whisper reference env):
    uv run --project <tcpp>/scripts/envs/whisper python models/edda/convert_edda.py \
        <tcpp>/scripts/convert-whisper.py <edda snapshot dir> <out.gguf>
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO_ID = "danish-foundation-models/edda-v0.2"
VARIANT = "edda-v0.2"
DISPLAY_NAME = "Edda v0.2"


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    converter_path, model_dir, out_path = (Path(a) for a in argv[1:])
    spec = importlib.util.spec_from_file_location("convert_whisper", converter_path)
    if spec is None or spec.loader is None:
        print(f"error: cannot load {converter_path}", file=sys.stderr)
        return 2
    module = importlib.util.module_from_spec(spec)
    sys.modules["convert_whisper"] = module
    spec.loader.exec_module(module)
    module.VARIANT_DISPLAY_NAMES[VARIANT] = DISPLAY_NAME
    out_path.parent.mkdir(parents=True, exist_ok=True)
    return module.main(
        [
            str(converter_path),
            str(model_dir),
            str(out_path),
            "--repo-id",
            REPO_ID,
            "--variant",
            VARIANT,
        ]
    )


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
