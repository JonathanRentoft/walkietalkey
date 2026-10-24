#!/usr/bin/env bash
# Download the Ekko PnC runtime files (and their licence bundle) into a folder,
# verified against SHA-256. For CI and local tests of crates/ekko-pnc:
#
#   models/ekko-pnc/download.sh <dir>
#   WT_EKKO_PNC_DIR=<dir> cargo test -p ekko-pnc --manifest-path crates/ekko-pnc/Cargo.toml
#
# Source: huggingface.co/RyeAI/ekko-pnc at the revision the reference tool
# (ekko-stt 0.1.2) pins. Set EKKO_PNC_BASE_URL to use a mirror with the same
# file layout (e.g. our own Hugging Face repo once it exists).
set -euo pipefail

DIR="${1:?usage: $0 <dir>}"
REVISION="d3129544e4e0155093e192cac58a9e69a4dea1ff"
BASE="${EKKO_PNC_BASE_URL:-https://huggingface.co/RyeAI/ekko-pnc/resolve/$REVISION}"

FILES=(
  "pnc.int8.onnx 46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527"
  "tokenizer.json a1e0d43ee307ad7a1ccc23e6e5398d877a68ca7f576067ac507625a0d50e9502"
  "config.json dc655c46f69eeb15dd43786ad58fb5862cc794b36cc9d2c426ab5bc4b01f23ca"
  "MODEL_LICENSE.md 590f820521961c89e7795bd3f46575794f4cbdcb02cc9db682e825c0afc874aa"
  "NOTICE bc86a9b47ff32a3ab29bb0ff8f414ae8b2ef1932ccf8bae2e4dacb5a6812ba8d"
  "LICENSES/CC-BY-4.0.txt 9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411"
  "LICENSES/CC0-1.0.txt a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499"
  "LICENSES/CORAL-LICENSE ee93c98df9a894464d1c042b66c6039543776c463d06d1a6e93f176e08ca67bd"
  "LICENSES/FTSPEECH-LICENSE.md 39708f5d77ae217b3a540363cb1b37fe079478e4ed1d3464f38d05d5a1c58b9a"
)

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

mkdir -p "$DIR/LICENSES"
for entry in "${FILES[@]}"; do
  name="${entry%% *}"; want="${entry##* }"; dest="$DIR/$name"
  if [[ -f "$dest" && "$(sha256 "$dest")" == "$want" ]]; then continue; fi
  curl -fsSL --retry 3 -o "$dest.part" "$BASE/$name"
  got="$(sha256 "$dest.part")"
  if [[ "$got" != "$want" ]]; then
    rm -f "$dest.part"
    echo "error: $name: SHA-256 $got, expected $want" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
done
echo "Ekko PnC files ready in $DIR"
