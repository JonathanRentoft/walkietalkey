#!/usr/bin/env bash
# Validate the converted Ekko v1 tiny the way transcribe.cpp validates its
# Parakeet models: scripts/validate.py all --family parakeet (reference: NeMo
# fp32 via scripts/dump_reference_parakeet_nemo.py; C++: the F32 GGUF on CPU,
# one thread; tolerances: tests/tolerances/parakeet.json; transcript must equal
# NeMo's exactly), on two Danish FLEURS clips. Then the same CLI output-validity
# smoke transcribe.cpp uses for quants, on the Q8_0 file.
#
# Usage: models/ekko-v1-tiny/validate.sh <work-dir> <fleurs-da_dk-dir>
#   Needs setup-transcribe-cpp.sh and convert.sh to have run.
set -uo pipefail

WORK="${1:?usage: $0 <work-dir> <fleurs-da_dk-dir>}"
FLEURS="${2:?usage: $0 <work-dir> <fleurs-da_dk-dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TCPP="$WORK/src/transcribe.cpp-0.4.0"
NEMO="$WORK/dl/ekko-v1-tiny/ekko-v1-tiny.nemo"
MODELS="$WORK/models-final/ekko-v1-tiny"
REF="$WORK/build/reference-gguf/ekko-v1-tiny"
OUT="$WORK/runs/ekko-validation"
mkdir -p "$OUT"

cp "$HERE/validation/ekko-v1-tiny.manifest.json" "$TCPP/tests/golden/parakeet/ekko-v1-tiny.manifest.json"
for id in 6263195548503774343 17924706686437869147; do
  cp "$FLEURS/test/$id.wav" "$TCPP/samples/fleurs-da-$id.wav"
done

cd "$TCPP"
uv run scripts/validate.py all --family parakeet --variant ekko-v1-tiny \
  --model "$NEMO" --gguf "$REF/ekko-v1-tiny-F32.gguf" --report > "$OUT/tensors.log" 2>&1
echo "tensors $?" | tee "$OUT/status.txt"

for gguf in "$REF/ekko-v1-tiny-F32.gguf" "$MODELS/ekko-v1-tiny-Q8_0.gguf"; do
  for id in 6263195548503774343 17924706686437869147; do
    out="$("$TCPP/build/bin/transcribe-cli" -q -l da -m "$gguf" "$TCPP/samples/fleurs-da-$id.wav" 2>/dev/null)"
    if printf '%s\n' "$out" | grep -q '^text: .\+'; then
      echo "smoke OK $(basename "$gguf") $id: $(printf '%s\n' "$out" | grep '^text: ')" | tee -a "$OUT/status.txt"
    else
      echo "smoke FAIL $(basename "$gguf") $id" | tee -a "$OUT/status.txt"
    fi
  done
done
grep -E "tensors within tolerance|Transcript|FAIL transcript|reference:|c\+\+:" "$OUT/tensors.log"
