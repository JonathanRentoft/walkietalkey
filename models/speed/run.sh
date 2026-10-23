#!/usr/bin/env bash
# Raw speed (DESK-31, DESK-43): wall time of one transcription with a warm
# model, through transcribe-cpp 0.4.0 (the crate the app links), with the app's
# run options (language da; timestamps off for Whisper-family models). Clips:
# 10, 11, 30 and 35 s of Danish (models/clips/make_clips.sh). 1 warm-up and
# 5 timed runs per clip; backends: Metal (GPU), CPU (strict, no BLAS/AMX) and
# CPU+Accelerate on macOS.
#
# Usage: models/speed/run.sh <work-dir> [model-file ...]
#   Default models: Edda Q8_0, Whisper turbo Q8_0 (Handy's), Ekko v1 tiny Q8_0.
#   Output: <work-dir>/runs/speed-<timestamp>/{results.jsonl,summary.md}.
#   Run on an otherwise idle machine; GPU work from other processes skews it.
set -euo pipefail

WORK="${1:?usage: $0 <work-dir> [model-file ...]}"; shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
OUT="$WORK/runs/speed-$(date +%Y%m%d-%H%M%S)"
CLIPS="$WORK/runs/speed-clips"
mkdir -p "$OUT"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$WORK/build/wt-speed-target}"
if [[ "$(uname -s)" == "Darwin" ]]; then
  export SDKROOT="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk}"
  BACKENDS=(metal cpu cpu_accel)
else
  BACKENDS=(auto cpu)
fi
cargo build --release --manifest-path "$HERE/Cargo.toml"
BENCH="$CARGO_TARGET_DIR/release/wt-speed"

[[ -f "$CLIPS/da-fleurs-35s.wav" ]] || "$REPO/models/clips/make_clips.sh" "$WORK/datasets/fleurs-da_dk" "$CLIPS"
CLIP_FILES=("$CLIPS"/da-fleurs-10s.wav "$CLIPS"/da-fleurs-11s.wav "$CLIPS"/da-fleurs-30s.wav "$CLIPS"/da-fleurs-35s.wav)

MODELS=("$@")
if [[ ${#MODELS[@]} -eq 0 ]]; then
  MODELS=(
    "$WORK/models-final/edda-v0.2/edda-v0.2-Q8_0.gguf"
    "$WORK/dl/whisper-large-v3-turbo-gguf/whisper-large-v3-turbo-Q8_0.gguf"
    "$WORK/models-final/ekko-v1-tiny/ekko-v1-tiny-Q8_0.gguf"
  )
fi

echo "start $(date '+%Y-%m-%d %H:%M:%S')" | tee "$OUT/times.txt"
for model in "${MODELS[@]}"; do
  [[ -f "$model" ]] || { echo "skip missing $model" >&2; continue; }
  for backend in "${BACKENDS[@]}"; do
    "$BENCH" --model "$model" --backend "$backend" --language da --timestamps none \
      --warmup 1 --iters 5 "${CLIP_FILES[@]}" | tee -a "$OUT/results.jsonl"
  done
done
echo "end $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$OUT/times.txt"

python3 - "$OUT/results.jsonl" > "$OUT/summary.md" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print("| model | backend | clip | mean | min | max | x realtime |")
print("|---|---|---|---:|---:|---:|---:|")
for r in rows:
    print(f"| {r['model']} | {r['backend_requested']} ({r['backend']}) | {r['seconds']:.0f} s | "
          f"{r['mean_ms']/1000:.2f} s | {r['min_ms']/1000:.2f} s | {r['max_ms']/1000:.2f} s | {r['realtime_x']} |")
PY
cat "$OUT/summary.md"
echo "results: $OUT"
