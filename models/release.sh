#!/usr/bin/env bash
# Publish the converted models, their model cards and licence files as the
# assets of a GitHub release (OSS-24, DESK-32, DESK-33). This is how
# `models-v1` was made.
#
#   models/release.sh --dry-run [--dir <models-final>] [--tag models-v1]
#       verify every file against models/manifest.json and stage the flat
#       asset folder plus SHA256SUMS; uploads nothing
#   models/release.sh --yes-publish [--dir <models-final>] [--tag models-v1]
#       stage, then `gh release create` (not marked latest, so the app's
#       `releases/latest` stays the newest app release)
#
# <models-final> (default <repo>/_kit/work/models-final) holds one folder per
# model id, as models/edda/convert.sh, models/ekko-v1-tiny/convert.sh and
# models/ekko-pnc/download.sh write them. A release cannot hold folders, so
# licence files are published flat with a "<model id>-" prefix
# (`licenseAssets` in the manifest); the app puts them back in LICENSES/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/.." && pwd -P)"
DIR="$REPO/_kit/work/models-final"
TAG="models-v1"
GH_REPO="JonathanRentoft/walkietalkey"
YES=0; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes-publish) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --dir) DIR="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ $DRY -eq 0 && $YES -ne 1 ]]; then
  echo "refusing to publish: pass --yes-publish (or --dry-run to only verify and stage)" >&2; exit 2
fi

python3 -I "$REPO/models/tools/check_manifest.py" --dir "$DIR" \
  --model edda-v0.2 --model ekko-v1-tiny --model ekko-pnc

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
python3 -I - "$REPO" "$DIR" "$STAGE" <<'PY'
import hashlib, json, os, pathlib, shutil, sys
repo, src, stage = (pathlib.Path(p) for p in sys.argv[1:4])
manifest = json.loads((repo / "models/manifest.json").read_text())
cards = {"edda-v0.2": "models/edda", "ekko-v1-tiny": "models/ekko-v1-tiny", "ekko-pnc": "models/ekko-pnc"}
for m in manifest["models"]:
    mid = m["id"]
    if mid not in cards:
        continue
    for f in m["files"]:
        os.link(src / mid / f["name"], stage / f["path"])
    shutil.copyfile(repo / cards[mid] / "README.md", stage / f"{mid}-README.md")
    for name, la in m.get("licenseAssets", {}).items():
        # The repository keeps each model's licence texts in models/<model>/licenses/.
        lic = repo / cards[mid] / "licenses" / ("Apache-2.0.txt" if name == "LICENSE" else pathlib.Path(name).name)
        data = lic.read_bytes()
        if hashlib.sha256(data).hexdigest() != la["sha256"]:
            sys.exit(f"{mid}/{name}: {lic} does not match the manifest")
        (stage / la["asset"]).write_bytes(data)
PY
(cd "$STAGE" && shasum -a 256 $(ls | sort) > SHA256SUMS)
echo "staged $(ls "$STAGE" | wc -l | tr -d ' ') assets in $STAGE"
if [[ $DRY -eq 1 ]]; then
  ls -l "$STAGE"
  exit 0
fi
(cd "$STAGE" && gh release create "$TAG" --repo "$GH_REPO" --target main --title "Models ${TAG#models-}" \
  --notes "Speech models for WalkieTalkey; see the model cards (*-README.md) and SHA256SUMS." \
  --latest=false $(ls | sort))
