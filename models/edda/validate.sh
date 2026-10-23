#!/usr/bin/env bash
# DESK-29 validation of the converted Edda files, the way transcribe.cpp
# validates its own Whisper models, plus our real-clip text check.
#
#  tensors    scripts/validate.py all --family whisper --variant edda-v0.2
#             (reference: transformers 5.6.1 WhisperForConditionalGeneration, fp32 CPU,
#             via scripts/dump_reference_whisper_transformers.py; C++: the reference-dtype
#             F16 GGUF on CPU; budget: transcribe.cpp's whisper-large-v3-turbo tolerances;
#             transcript must equal the reference exactly). Cases: two Danish FLEURS
#             clips (language da) and samples/jfk.wav (language en).
#  control    the identical pipeline and cases on stock openai/whisper-large-v3-turbo
#             (Handy's F16 GGUF), to tell conversion errors from clip- and
#             weight-dependent F16 noise. Runs when the turbo files are present.
#  quant      scripts/quant_accuracy.py: Q8_0 drift against the F16 baseline (diagnostic).
#  same-text  10 real Danish clips: Transformers greedy vs edda-v0.2-Q8_0.gguf on Metal
#             and on CPU, and vs edda-v0.2-F16.gguf on CPU (same_text.py).
#
# Usage: models/edda/validate.sh <work-dir> <fleurs-da_dk-dir>
#   Needs setup-transcribe-cpp.sh and convert.sh to have run, and
#   models/eval/fetch_fleurs.sh for the FLEURS clips. For the control step:
#   <work-dir>/dl/whisper-large-v3-turbo-hf (openai/whisper-large-v3-turbo @ 41f01f3)
#   and <work-dir>/dl/whisper-large-v3-turbo-gguf/whisper-large-v3-turbo-F16.gguf.
#   Every step logs to <work-dir>/runs/edda-validation/ and appends its exit
#   status to status.txt; the script carries on after a failed step.
#   STEPS="quant same-text" models/edda/validate.sh ... reruns selected steps
#   (tensors, control, quant, same-text).
set -uo pipefail

WORK="${1:?usage: $0 <work-dir> <fleurs-da_dk-dir>}"
FLEURS="${2:?usage: $0 <work-dir> <fleurs-da_dk-dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TCPP="$WORK/src/transcribe.cpp-0.4.0"
SNAPSHOT="$WORK/dl/edda-v0.2"
MODELS="$WORK/models-final/edda-v0.2"
REF="$WORK/build/reference-gguf"
TURBO_HF="$WORK/dl/whisper-large-v3-turbo-hf"
TURBO_F16="$WORK/dl/whisper-large-v3-turbo-gguf/whisper-large-v3-turbo-F16.gguf"
OUT="$WORK/runs/edda-validation"
mkdir -p "$OUT"
touch "$OUT/status.txt"

step() {  # step <name> <command...>
  local name="$1"; shift
  ( "$@" ) > "$OUT/$name.log" 2>&1
  local rc=$?
  echo "$name $rc" | tee -a "$OUT/status.txt"
}

# The 10 real clips: every 93rd file of the FLEURS da_dk test split in name order.
CLIPS=()
while IFS= read -r f; do CLIPS+=("$FLEURS/test/$f"); done < <(
  ls "$FLEURS/test" | LC_ALL=C sort | awk 'NR % 93 == 1' | head -10)

# Install our manifests, tolerance budget and Danish case audio into the tree.
cp "$HERE/validation/edda-v0.2.manifest.json" "$TCPP/tests/golden/whisper/edda-v0.2.manifest.json"
cp "$HERE/validation/edda-v0.2.tolerances.json" "$TCPP/tests/tolerances/edda-v0.2.json"
cp "$HERE/validation/whisper-large-v3-turbo-da.manifest.json" \
   "$TCPP/tests/golden/whisper/whisper-large-v3-turbo-da.manifest.json"
for id in 6263195548503774343 17924706686437869147; do
  cp "$FLEURS/test/$id.wav" "$TCPP/samples/fleurs-da-$id.wav"
done

STEPS="${STEPS:-tensors control quant same-text}"
want() { [[ " $STEPS " == *" $1 "* ]]; }

cd "$TCPP"
want tensors && step tensors uv run scripts/validate.py all --family whisper --variant edda-v0.2 \
  --model "$SNAPSHOT" --gguf "$REF/edda-v0.2-F16.gguf" --report

if want control && [[ -d "$TURBO_HF" && -f "$TURBO_F16" ]]; then
  step control uv run scripts/validate.py all --family whisper --variant whisper-large-v3-turbo-da \
    --model "$TURBO_HF" --gguf "$TURBO_F16" --report
fi

if want quant; then
  # quant_accuracy.py runs transcribe-cli with its defaults (timestamps auto,
  # language detection); Edda drops words in that mode, which would make the
  # F16 and Q8_0 decodes diverge for reasons unrelated to quantisation. A tiny
  # wrapper pins the app's settings: timestamps off, Danish.
  WRAP="$OUT/transcribe-cli-da-notimestamps"
  printf '#!/bin/sh\nexec "%s" --timestamps none -l da "$@"\n' "$TCPP/build/bin/transcribe-cli" > "$WRAP"
  chmod +x "$WRAP"
  step quant uv run scripts/quant_accuracy.py --cli "$WRAP" --baseline "$REF/edda-v0.2-F16.gguf" \
    --audio "$TCPP/samples/fleurs-da-6263195548503774343.wav" \
    --dump-root "$OUT/quant-dumps" "$MODELS/edda-v0.2-Q8_0.gguf"
fi

if want same-text; then
  step same-text-metal uv run --project "$TCPP/scripts/envs/whisper" python "$HERE/same_text.py" \
    --tcpp "$TCPP" --model "$SNAPSHOT" --backend metal \
    --gguf "$MODELS/edda-v0.2-Q8_0.gguf" --out "$OUT/same_text.metal.json" "${CLIPS[@]}"
  step same-text-cpu uv run --project "$TCPP/scripts/envs/whisper" python "$HERE/same_text.py" \
    --tcpp "$TCPP" --model "$SNAPSHOT" --backend cpu \
    --gguf "$MODELS/edda-v0.2-Q8_0.gguf" --gguf "$REF/edda-v0.2-F16.gguf" \
    --out "$OUT/same_text.cpu.json" "${CLIPS[@]}"
fi

python3 "$HERE/compare_control.py" "$OUT" > "$OUT/control-summary.md" 2>/dev/null || true
echo "logs and reports in $OUT"
