#!/usr/bin/env bash
# Upload the converted models, each with its model card and licence files, to
# the WalkieTalkey Hugging Face organisation (OSS-24). Prepared, not run: the
# organisation does not exist yet, and uploading waits on the owner's decision
# about the FT Speech terms (spec section 11, decision 18.7).
#
#   models/upload.sh --dry-run [--dir <models-final>]
#       verify every file against models/manifest.json and stage the repos
#       locally; needs no token and uploads nothing
#   HF_TOKEN=... models/upload.sh --yes-upload [--org walkietalkey] [--dir <models-final>] [--only <id>]
#       the real upload; refuses to run without BOTH --yes-upload and HF_TOKEN
#
# <models-final> (default <repo>/_kit/work/models-final) holds one folder per
# model id, as models/edda/convert.sh, models/ekko-v1-tiny/convert.sh and
# models/ekko-pnc/download.sh write them. Repos: <org>/edda-v0.2-gguf,
# <org>/ekko-v1-tiny-gguf, <org>/ekko-pnc. After an upload, put the printed
# commit into models/manifest.json (replace resolve/main) and commit it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/.." && pwd -P)"
DIR="$REPO/_kit/work/models-final"
ORG="walkietalkey"
YES=0; DRY=0; ONLY=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes-upload) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --org) ORG="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --only) ONLY+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ $DRY -eq 0 ]]; then
  if [[ $YES -ne 1 ]]; then
    echo "refusing to upload: pass --yes-upload (or --dry-run to only verify and stage)" >&2; exit 2
  fi
  if [[ -z "${HF_TOKEN:-}" ]]; then
    echo "refusing to upload: HF_TOKEN is not set" >&2; exit 2
  fi
fi

# repo id | model id | card | licence layout | files
MODELS=(
  "edda-v0.2-gguf|edda-v0.2|$HERE/edda/README.md|edda|edda-v0.2-Q8_0.gguf"
  "ekko-v1-tiny-gguf|ekko-v1-tiny|$HERE/ekko-v1-tiny/README.md|ekko|ekko-v1-tiny-Q8_0.gguf"
  "ekko-pnc|ekko-pnc|$HERE/ekko-pnc/README.md|ekko|pnc.int8.onnx tokenizer.json config.json"
)

selected() { [[ ${#ONLY[@]} -eq 0 ]] || [[ " ${ONLY[*]} " == *" $1 "* ]]; }

CHECK_ARGS=(--dir "$DIR")
for entry in "${MODELS[@]}"; do
  IFS='|' read -r _ id _ _ _ <<<"$entry"
  selected "$id" && CHECK_ARGS+=(--model "$id")
done
python3 "$HERE/tools/check_manifest.py" "${CHECK_ARGS[@]}"

# Stage next to the model files so they can be hard-linked (no copy, and
# `hf upload` reads them as plain files).
STAGE="$DIR/.upload-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
for entry in "${MODELS[@]}"; do
  IFS='|' read -r repo id card layout files <<<"$entry"
  selected "$id" || continue
  dest="$STAGE/$repo"
  mkdir -p "$dest/LICENSES"
  cp "$card" "$dest/README.md"
  licenses="$(dirname "$card")/licenses"
  if [[ "$layout" == "edda" ]]; then
    cp "$licenses/Apache-2.0.txt" "$dest/LICENSE"
    cp "$licenses/Whisper-MIT.txt" "$licenses/CORAL-LICENSE" "$licenses/FTSPEECH-LICENSE.md" "$dest/LICENSES/"
  else
    cp "$licenses/MODEL_LICENSE.md" "$licenses/NOTICE" "$dest/"
    for f in "$licenses"/*; do
      case "$(basename "$f")" in MODEL_LICENSE.md|NOTICE) ;; *) cp "$f" "$dest/LICENSES/" ;; esac
    done
  fi
  for f in $files; do
    ln "$DIR/$id/$f" "$dest/$f" 2>/dev/null || cp "$DIR/$id/$f" "$dest/$f"
  done
  echo "staged $ORG/$repo:"; (cd "$dest" && find . -mindepth 1 | sort | sed 's/^/  /')
done

if [[ $DRY -eq 1 ]]; then
  echo "dry run: verified and staged, nothing uploaded"; exit 0
fi

HF=(uvx --from 'huggingface_hub[hf_xet]==0.36.0' hf)
for entry in "${MODELS[@]}"; do
  IFS='|' read -r repo id _ _ _ <<<"$entry"
  selected "$id" || continue
  "${HF[@]}" repo create "$ORG/$repo" --repo-type model --exist-ok
  "${HF[@]}" upload "$ORG/$repo" "$STAGE/$repo" . --repo-type model \
    --commit-message "Upload $id (WalkieTalkey $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown))"
  sha="$(curl -fsS -H "Authorization: Bearer $HF_TOKEN" "https://huggingface.co/api/models/$ORG/$repo" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["sha"])')"
  echo "uploaded $ORG/$repo at commit $sha: replace resolve/main with resolve/$sha for $id in models/manifest.json"
done
