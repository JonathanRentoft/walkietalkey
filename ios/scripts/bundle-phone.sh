#!/usr/bin/env bash
# Builds the phone web app and copies it into the iOS app's bundled web folder, ios/Web/, which the
# Xcode project adds as a folder reference (PHONE-03: the app runs these files, nothing from the web).
#
#   bash ios/scripts/bundle-phone.sh                    build phone/ with bun, then copy phone/dist
#   PHONE_DIST=<dir> bash ios/scripts/bundle-phone.sh   copy an existing build instead (no bun needed)
#
# Works from any directory. Fails loudly when the build fails or the build output looks wrong.
set -euo pipefail

fail() {
  echo "bundle-phone: error: $*" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ios_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$ios_dir/.." && pwd)"
web_dir="$ios_dir/Web"

[[ -f "$ios_dir/project.yml" ]] || fail "expected ios/project.yml next to this script ($ios_dir)"

if [[ -n "${PHONE_DIST:-}" ]]; then
  [[ -d "$PHONE_DIST" ]] || fail "PHONE_DIST=$PHONE_DIST is not a directory"
  dist="$(cd "$PHONE_DIST" && pwd)"
  echo "bundle-phone: copying the existing build in $dist"
else
  [[ -f "$repo_root/phone/package.json" ]] || fail "no phone/package.json in $repo_root"
  command -v bun > /dev/null 2>&1 || fail "bun is not installed (or set PHONE_DIST to an existing build)"
  dist="$repo_root/phone/dist"
  echo "bundle-phone: building the phone app (bun run --cwd phone build)"
  (cd "$repo_root" && bun run --cwd phone build) || fail "the phone build failed"
fi

[[ -f "$dist/index.html" ]] || fail "$dist/index.html is missing; is this a phone build?"
first_script="$(find "$dist" -name '*.js' -print -quit)"
[[ -n "$first_script" ]] || fail "$dist has no JavaScript files; is this a phone build?"

# Empty ios/Web/ (only that folder, and never its .gitkeep), then copy the build into it.
mkdir -p "$web_dir"
find "$web_dir" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} +
cp -R "$dist"/. "$web_dir"/
# Hosting files for Cloudflare Pages; the app serves the files itself.
rm -rf "$web_dir/_headers" "$web_dir/_redirects" "$web_dir/.well-known"
touch "$web_dir/.gitkeep"

[[ -f "$web_dir/index.html" ]] || fail "copy failed: $web_dir/index.html is missing"
count="$(find "$web_dir" -type f ! -name .gitkeep | wc -l | tr -d ' ')"
size="$(du -sh "$web_dir" | cut -f1)"
echo "bundle-phone: $count files ($size) in ios/Web/"
