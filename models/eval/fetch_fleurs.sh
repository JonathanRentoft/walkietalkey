#!/usr/bin/env bash
# Download the FLEURS Danish test split (google/fleurs, config da_dk, CC BY 4.0)
# at a pinned revision and unpack it into <data-dir>/fleurs-da_dk/:
#   test.tsv            FLEURS metadata (id, file, raw transcription, normalised transcription, ...)
#   test/<file>.wav     16 kHz mono audio
#
# Usage: models/eval/fetch_fleurs.sh <data-dir>
set -euo pipefail

DATA="${1:?usage: $0 <data-dir>}"
REVISION="70bb2e84b976b7e960aa89f1c648e09c59f894dd"   # google/fleurs
DEST="$DATA/fleurs-da_dk"
RAW="$DATA/fleurs-raw"
export HF_HOME="${HF_HOME:-$DATA/hf}" HF_HUB_DISABLE_TELEMETRY=1

if [[ -f "$DEST/.complete" ]]; then
  echo "FLEURS da_dk test already at $DEST"; exit 0
fi

uvx --from 'huggingface_hub[hf_xet]==0.36.0' hf download google/fleurs \
  --repo-type dataset --revision "$REVISION" \
  --include "data/da_dk/test.tsv" "data/da_dk/audio/test.tar.gz" \
  --local-dir "$RAW"

mkdir -p "$DEST"
cp "$RAW/data/da_dk/test.tsv" "$DEST/test.tsv"
tar -xzf "$RAW/data/da_dk/audio/test.tar.gz" -C "$DEST"
touch "$DEST/.complete"
echo "FLEURS da_dk test ready at $DEST ($(ls "$DEST/test" | wc -l | tr -d ' ') files)"
