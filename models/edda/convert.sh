#!/usr/bin/env bash
# Reproduce edda-v0.2-F16.gguf (reference dtype) and edda-v0.2-Q8_0.gguf from
# the original Hugging Face checkpoint (DESK-29).
#
# Usage: models/edda/convert.sh <work-dir>
#   Requires models/tools/setup-transcribe-cpp.sh <work-dir> to have run.
#   Writes <work-dir>/models-final/edda-v0.2/edda-v0.2-{F16,Q8_0}.gguf and
#   prints their SHA-256. HF downloads go to <work-dir>/hf (HF_HOME).
set -euo pipefail

WORK="${1:?usage: $0 <work-dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TCPP="$WORK/src/transcribe.cpp-0.4.0"
REVISION="698f8d04b5970f963d31c4079c05a76fa7f4f5bb"   # danish-foundation-models/edda-v0.2
SNAPSHOT="$WORK/dl/edda-v0.2"
OUT="$WORK/models-final/edda-v0.2"
export HF_HOME="$WORK/hf" HF_HUB_DISABLE_TELEMETRY=1

[[ -x "$TCPP/build/bin/transcribe-quantize" ]] || {
  echo "error: run models/tools/setup-transcribe-cpp.sh $WORK first" >&2; exit 1; }

uvx --from 'huggingface_hub[hf_xet]==0.36.0' hf download \
  danish-foundation-models/edda-v0.2 --revision "$REVISION" --local-dir "$SNAPSHOT"

# The original weights must be the ones we validated against.
echo "84f31719f0a26ea774a9d4470f0a54fecf807afef6ac6fb04291cd2dabe40e4c  $SNAPSHOT/model.safetensors" \
  | shasum -a 256 -c -

mkdir -p "$OUT"
uv run --project "$TCPP/scripts/envs/whisper" python "$HERE/convert_edda.py" \
  "$TCPP/scripts/convert-whisper.py" "$SNAPSHOT" "$OUT/edda-v0.2-F16.gguf"

"$TCPP/build/bin/transcribe-quantize" \
  "$OUT/edda-v0.2-F16.gguf" "$OUT/edda-v0.2-Q8_0.gguf" --quant Q8_0

shasum -a 256 "$OUT"/edda-v0.2-*.gguf
