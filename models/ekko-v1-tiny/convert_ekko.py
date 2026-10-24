"""Convert Ekko v1 tiny (RyeAI, a FastConformer RNN-T fine-tuned from
nvidia/parakeet-rnnt-110m-da-dk) to a reference-dtype (F32) GGUF with
transcribe.cpp's own Parakeet converter.

transcribe.cpp's scripts/convert-parakeet.py picks a variant profile by the
output folder name, and 0.4.0 has no profile for a 110M RNN-T. The
architecture is one the converter and engine already handle (the FastConformer
encoder of parakeet-tdt_ctc-110m with the plain RNN-T head of
parakeet-rnnt-0.6b), so this wrapper only registers an "ekko-v1-tiny" profile
(identity, Danish only, the model's own licence) and runs the converter
unchanged. The converter cross-checks the vocabulary size (44) against the
checkpoint.

Usage (inside transcribe.cpp's parakeet reference env):
    uv run --project <tcpp>/scripts/envs/parakeet python models/ekko-v1-tiny/convert_ekko.py \
        <tcpp>/scripts/convert-parakeet.py <ekko-v1-tiny.nemo> <out-dir>/ekko-v1-tiny/ekko-v1-tiny-F32.gguf
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SLUG = "ekko-v1-tiny"
PROFILE = {
    "variant": "rnnt-110m-da-ekko-v1-tiny",
    "display_name": "Ekko v1 Tiny",
    "version": "v1",
    "size_label": "110M",
    "basename": "parakeet-rnnt",
    "head_kind": "rnnt",
    "expected_vocab_size": 44,
    "languages": ["da"],
    "lang_detect": False,
    "author": "RyeAI",
    "organization": "RyeAI",
    "license": "other",
    "license_name": "NVIDIA Open Model License (base model); CC BY 4.0 (RyeAI modifications); CoRal use restrictions",
    "license_link": "https://huggingface.co/RyeAI/ekko-v1-tiny/blob/main/MODEL_LICENSE.md",
}


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    converter_path, nemo_path, out_path = Path(argv[1]), argv[2], Path(argv[3])
    if out_path.parent.name != SLUG:
        print(f"error: the output folder must be named {SLUG}/ (the converter keys on it)", file=sys.stderr)
        return 2
    spec = importlib.util.spec_from_file_location("convert_parakeet", converter_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["convert_parakeet"] = module
    spec.loader.exec_module(module)
    module.VARIANT_PROFILES[SLUG] = PROFILE
    out_path.parent.mkdir(parents=True, exist_ok=True)
    return module.main([str(converter_path), nemo_path, str(out_path), "--repo-id", "RyeAI/ekko-v1-tiny"])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
