#!/usr/bin/env bash
# WalkieTalkey Danish accuracy harness (spec 15.1), one command:
#
#   models/eval/run.sh [--limit N] [--clips-dir DIR] [--backend metal|cpu|auto] [--out DIR] [--resume]
#
# Fetches and builds what is missing (transcribe.cpp 0.4.0, FLEURS da_dk test,
# Edda Q8_0 converted from the original, Handy's Whisper turbo Q8_0, Ekko v1
# tiny Q8_0), then scores every model on the same clips with language forced to
# Danish. --clips-dir points at a folder OUTSIDE the repository with <name>.wav +
# <name>.txt pairs (the owner's own dictations) and replaces FLEURS.
#
# Scratch space: $WT_WORK_DIR (default <repo>/_kit/work, which git ignores).
# Results: <out>/summary.md, summary.json and one <model>.jsonl per model.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${WT_WORK_DIR:-$REPO/_kit/work}"
TCPP="$WORK/src/transcribe.cpp-0.4.0"
LIMIT=""; CLIPS_DIR=""; BACKEND="auto"; OUT=""; RESUME=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --clips-dir) CLIPS_DIR="$2"; shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --resume) RESUME=(--resume); shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
OUT="${OUT:-$WORK/runs/harness-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$WORK"
export HF_HOME="${HF_HOME:-$WORK/hf}" HF_HUB_DISABLE_TELEMETRY=1

[[ -x "$TCPP/build-release/bin/transcribe-cli" ]] || "$REPO/models/tools/setup-transcribe-cpp.sh" "$WORK"
CLI="$TCPP/build-release/bin/transcribe-cli"

EDDA="$WORK/models-final/edda-v0.2/edda-v0.2-Q8_0.gguf"
[[ -f "$EDDA" ]] || "$REPO/models/edda/convert.sh" "$WORK"

# Handy's catalog baseline, verified against the SHA-256 in catalog.json.
TURBO_DIR="$WORK/dl/whisper-large-v3-turbo-gguf"
TURBO="$TURBO_DIR/whisper-large-v3-turbo-Q8_0.gguf"
if [[ ! -f "$TURBO" ]]; then
  uvx --from 'huggingface_hub[hf_xet]==0.36.0' hf download handy-computer/whisper-large-v3-turbo-gguf \
    --revision 5eaf945c7978e564bae5b28a5b1639dd93c2bfb1 --include whisper-large-v3-turbo-Q8_0.gguf \
    --local-dir "$TURBO_DIR"
fi
echo "b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183  $TURBO" | shasum -a 256 -c - >/dev/null

# Whisper models run both ways: timestamps off (<|notimestamps|>, how Edda was
# fine-tuned and how WalkieTalkey decodes) and the engine default "auto"
# (segment timestamps, stock Handy), so the difference is on record.
MODELS=(
  --model "edda-v0.2-q8_0=$EDDA@none"
  --model "edda-v0.2-q8_0-ts-auto=$EDDA@auto"
  --model "whisper-turbo-q8_0=$TURBO@none"
  --model "whisper-turbo-q8_0-ts-auto=$TURBO@auto"
)
EKKO="$WORK/models-final/ekko-v1-tiny/ekko-v1-tiny-Q8_0.gguf"
if [[ -f "$EKKO" || -x "$REPO/models/ekko-v1-tiny/convert.sh" ]]; then
  [[ -f "$EKKO" ]] || "$REPO/models/ekko-v1-tiny/convert.sh" "$WORK"
  MODELS+=(--model "ekko-v1-tiny-q8_0=$EKKO@auto")
fi

SOURCE=()
if [[ -n "$CLIPS_DIR" ]]; then
  SOURCE=(--clips-dir "$CLIPS_DIR")
else
  "$HERE/fetch_fleurs.sh" "$WORK/datasets"
  SOURCE=(--fleurs-dir "$WORK/datasets/fleurs-da_dk")
fi
[[ -n "$LIMIT" ]] && SOURCE+=(--limit "$LIMIT")

cd "$HERE"
UV_PROJECT_ENVIRONMENT="${UV_PROJECT_ENVIRONMENT:-$WORK/venvs/wt-harness}" \
  uv run --frozen python -m wt_eval run --cli "$CLI" --backend "$BACKEND" \
  "${MODELS[@]}" "${SOURCE[@]}" --out "$OUT" ${RESUME[@]+"${RESUME[@]}"}
echo "results: $OUT/summary.md"
