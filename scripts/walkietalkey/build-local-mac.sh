#!/usr/bin/env bash
# Builds the Mac app locally and signs it with the stable self-signed identity
# "WalkieTalkey Local" from the login keychain, when it exists.
#
# Why: an ad-hoc signature (Tauri's default here) changes with every build, and
# macOS ties Accessibility and microphone grants to the signature, so every new
# ad-hoc build silently loses them. A signature from one certificate keeps the
# designated requirement the same (`certificate root = H"..."`) across builds.
#
#   scripts/walkietalkey/build-local-mac.sh [--install] [extra `tauri build` args]
#
# --install: after a build signed with the identity, quits WalkieTalkey,
# replaces /Applications/WalkieTalkey.app and opens it. An ad-hoc build is never
# installed (it would lose the permissions the signed one has).
#
# The first signing on a Mac may show "codesign wants to sign using key
# 'WalkieTalkey Local'": type the login password and click Always Allow (Allow
# alone asks again on every build).
#
# Creating the identity once (a self-signed code-signing certificate, trusted
# for code signing in the login keychain) is described in BUILD.md.
set -euo pipefail

IDENTITY="${WT_LOCAL_SIGNING_IDENTITY:-WalkieTalkey Local}"
INSTALL=0
if [[ "${1:-}" == "--install" ]]; then
  INSTALL=1
  shift
fi
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
REQUIREMENT="$(codesign -d -r- "$APP" 2>&1 | tail -1)"
echo "$REQUIREMENT"

if [[ $INSTALL -eq 1 ]]; then
  if [[ "$REQUIREMENT" != *"certificate root"* ]]; then
    echo "Not installing: the build is not signed with \"$IDENTITY\"" >&2
    exit 1
  fi
  osascript -e 'tell application id "com.walkietalkey.app" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    pgrep -f "WalkieTalkey.app/Contents/MacOS/walkietalkey" >/dev/null || break
    sleep 0.5
  done
  rm -rf /Applications/WalkieTalkey.app
  ditto "$APP" /Applications/WalkieTalkey.app
  open /Applications/WalkieTalkey.app
  echo "Installed /Applications/WalkieTalkey.app"
fi
