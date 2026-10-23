#!/usr/bin/env bash
# Reproduce ekko-v1-tiny-F32.gguf (reference dtype) and ekko-v1-tiny-Q8_0.gguf
# from RyeAI's original .nemo checkpoint (DESK-35).
#
# Usage: models/ekko-v1-tiny/convert.sh <work-dir>
#   Requires models/tools/setup-transcribe-cpp.sh <work-dir> first.
#   Writes <work-dir>/models-final/ekko-v1-tiny/ekko-v1-tiny-{F32,Q8_0}.gguf
#   and copies the model's licence bundle next to them.
set -euo pipefail

WORK="${1:?usage: $0 <work-dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TCPP="$WORK/src/transcribe.cpp-0.4.0"
REVISION="3658535e7b2fa98d5d9aad8114573c0fab1e6203"   # RyeAI/ekko-v1-tiny
SNAPSHOT="$WORK/dl/ekko-v1-tiny"
OUT="$WORK/models-final/ekko-v1-tiny"
export HF_HOME="$WORK/hf" HF_HUB_DISABLE_TELEMETRY=1

[[ -x "$TCPP/build/bin/transcribe-quantize" ]] || {
  echo "error: run models/tools/setup-transcribe-cpp.sh $WORK first" >&2; exit 1; }

uvx --from 'huggingface_hub[hf_xet]==0.36.0' hf download RyeAI/ekko-v1-tiny --revision "$REVISION" \
  --include "ekko-v1-tiny.nemo" "*.md" "NOTICE" "LICENSES/*" --local-dir "$SNAPSHOT"
echo "c48614a2118bb634dc97a1497e3702940153e6db4d16b72f175a3ab94a06cece  $SNAPSHOT/ekko-v1-tiny.nemo" \
  | shasum -a 256 -c -

mkdir -p "$OUT"
uv run --project "$TCPP/scripts/envs/parakeet" python "$HERE/convert_ekko.py" \
  "$TCPP/scripts/convert-parakeet.py" "$SNAPSHOT/ekko-v1-tiny.nemo" "$OUT/ekko-v1-tiny-F32.gguf"

"$TCPP/build/bin/transcribe-quantize" "$OUT/ekko-v1-tiny-F32.gguf" "$OUT/ekko-v1-tiny-Q8_0.gguf" --quant Q8_0

# The licence bundle travels with the model (NVIDIA OML 3.1, CoRal 3(b)).
mkdir -p "$OUT/LICENSES"
cp "$SNAPSHOT/MODEL_LICENSE.md" "$SNAPSHOT/NOTICE" "$OUT/"
cp "$SNAPSHOT"/LICENSES/* "$OUT/LICENSES/"
shasum -a 256 "$OUT"/ekko-v1-tiny-*.gguf
