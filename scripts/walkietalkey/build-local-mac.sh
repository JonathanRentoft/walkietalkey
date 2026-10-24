#!/usr/bin/env bash
# Builds the Mac app locally and signs it with the stable self-signed identity
# "WalkieTalkey Local" from the login keychain, when it exists.
#
# Why: an ad-hoc signature (Tauri's default here) changes with every build, and
# macOS ties Accessibility and microphone grants to the signature, so every new
# ad-hoc build silently loses them. A signature from one certificate keeps the
# designated requirement the same (`certificate root = H"..."`) across builds.
#
#   scripts/walkietalkey/build-local-mac.sh [extra `tauri build` args]
#
# Creating the identity once (a self-signed code-signing certificate, trusted
# for code signing in the login keychain) is described in BUILD.md.
set -euo pipefail

IDENTITY="${WT_LOCAL_SIGNING_IDENTITY:-WalkieTalkey Local}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
cd "$REPO"

if [[ -d /opt/homebrew/opt/rustup/bin ]]; then
  export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
fi
export SDKROOT="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk}"

if security find-identity -v -p codesigning | grep -q "\"$IDENTITY\""; then
  export APPLE_SIGNING_IDENTITY="$IDENTITY"
  echo "Signing with \"$IDENTITY\""
else
  echo "No valid code-signing identity \"$IDENTITY\"; the build stays ad-hoc signed" >&2
fi

# Local builds need no updater archive (its signing key lives in CI).
bun run tauri build --bundles app,dmg \
  --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@"

APP="src-tauri/target/release/bundle/macos/WalkieTalkey.app"
codesign --verify --deep --strict "$APP"
codesign -d -r- "$APP" 2>&1 | tail -1
