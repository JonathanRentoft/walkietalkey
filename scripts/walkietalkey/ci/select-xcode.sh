#!/usr/bin/env bash
# Pin a macOS CI job to one released Xcode and that Xcode's own macOS SDK.
#
#   scripts/walkietalkey/ci/select-xcode.sh [version]     (default: $WT_XCODE_VERSION, else 26.6)
#
# Why: GitHub's macos-26 image also carries the Command Line Tools 27 beta, so
# /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk is the MacOSX27.0 beta SDK there, which the
# default Xcode's linker cannot read ("ld: tapi error: malformed file ... unknown architecture").
# The job then uses Xcode <version> (DEVELOPER_DIR) and its SDK (SDKROOT) for xcrun, clang, cc-rs,
# CMake and Swift alike. The version must be one the image lists under "Xcode" in its readme
# (macos-26-arm64 20261013.0424: 26.6 default, build 17F113, macOS SDK 26.5). When GitHub drops
# it, the job fails here with the list of Xcodes it has; bump the default below.
#
# Exports DEVELOPER_DIR and SDKROOT through $GITHUB_ENV when that is set, and prints them.
# WT_XCODE_ROOT (default /Applications) exists for the tests.
set -euo pipefail

VERSION="${1:-${WT_XCODE_VERSION:-26.6}}"
ROOT="${WT_XCODE_ROOT:-/Applications}"
APP="$ROOT/Xcode_${VERSION}.app"
DEV="$APP/Contents/Developer"

fail() {
  echo "::error::$*"
  exit 1
}

if [[ ! -d "$DEV" ]]; then
  installed="$(find "$ROOT" -maxdepth 1 -name 'Xcode_*.app' -exec basename {} \; 2>/dev/null | sort | tr '\n' ' ' || true)"
  fail "Xcode $VERSION is not on this runner ($APP). Installed: ${installed:-none}"
fi
export DEVELOPER_DIR="$DEV"

# Release builds are digits after the letter (17F113); betas end in a lower-case letter (17A5241e).
BUILD="$(xcodebuild -version | awk '/^Build version/ {print $3}')"
if [[ -z "$BUILD" || "$BUILD" =~ [a-z]$ ]]; then
  fail "Xcode $VERSION ($APP) is a beta or unreadable (build '${BUILD}'); pin a released Xcode"
fi

SDK="$(xcrun --sdk macosx --show-sdk-path)"
SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"
real_dev="$(cd "$DEV" && pwd -P)"
real_sdk="$(cd "$SDK" 2>/dev/null && pwd -P || true)"
if [[ "$SDK" != "$DEV"/* && "$real_sdk" != "$real_dev"/* ]]; then
  fail "xcrun gave $SDK, which is not the SDK of Xcode $VERSION ($DEV)"
fi

echo "Xcode $VERSION ($BUILD), macOS SDK $SDK_VERSION"
echo "DEVELOPER_DIR=$DEV"
echo "SDKROOT=$SDK"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'DEVELOPER_DIR=%s\nSDKROOT=%s\n' "$DEV" "$SDK" >>"$GITHUB_ENV"
fi
