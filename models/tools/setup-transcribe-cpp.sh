#!/usr/bin/env bash
# Fetch and build transcribe.cpp at the exact release Handy links (crate
# transcribe-cpp 0.4.0), so every GGUF we convert and every number we measure
# comes from the engine the app ships.
#
# Usage: models/tools/setup-transcribe-cpp.sh <work-dir>
#
# Produces:
#   <work-dir>/src/transcribe.cpp-0.4.0/                 source (release tarball, SHA-256 pinned)
#   <work-dir>/src/transcribe.cpp-0.4.0/build/bin/       validation build (hooks on): transcribe-cli,
#                                                        transcribe-quantize, transcribe-bench
#   <work-dir>/src/transcribe.cpp-0.4.0/build-release/bin/  release build used for timing
set -euo pipefail

WORK="${1:?usage: $0 <work-dir>}"
VERSION="0.4.0"
TARBALL_SHA256="51b4b08bcdaa083849b626c3028a8bbc35d66e2dd992cd4f075b15f9733058d1"
URL="https://github.com/handy-computer/transcribe.cpp/archive/refs/tags/v${VERSION}.tar.gz"
SRC="$WORK/src/transcribe.cpp-${VERSION}"

mkdir -p "$WORK/dl" "$WORK/src"
TAR="$WORK/dl/transcribe.cpp-v${VERSION}.tar.gz"
if [[ ! -f "$TAR" ]]; then
  curl -fL --retry 3 -o "$TAR" "$URL"
fi
echo "${TARBALL_SHA256}  ${TAR}" | shasum -a 256 -c -
if [[ ! -d "$SRC" ]]; then
  tar -xzf "$TAR" -C "$WORK/src"
fi

CMAKE_ARGS=(-DCMAKE_BUILD_TYPE=Release -DTRANSCRIBE_BUILD_TOOLS=ON -DTRANSCRIBE_BUILD_TESTS=OFF)
if [[ "$(uname -s)" == "Darwin" ]]; then
  # SDKROOT wins (CI sets it to the pinned Xcode's own SDK with
  # scripts/walkietalkey/ci/select-xcode.sh). With a full Xcode selected, use
  # that Xcode's SDK: its linker reads it, while the Command Line Tools beside
  # it may be a beta (GitHub's macos-26 image: CLT 27 beta, so CLT's MacOSX.sdk
  # is MacOSX27.0, "ld: tapi error ... unknown architecture"). With only the
  # Command Line Tools, their default SDK may be newer than their linker can
  # read, and their stable MacOSX.sdk symlink works. Without full Xcode there
  # is no `metal` compiler, so the shader library is embedded at build time.
  if [[ -z "${SDKROOT:-}" ]]; then
    if [[ "${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}" == *CommandLineTools* ]]; then
      SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
    else
      SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
    fi
  fi
  export SDKROOT
  echo "macOS SDK: $SDKROOT"
  CMAKE_ARGS+=(-DCMAKE_OSX_SYSROOT="$SDKROOT" -DGGML_METAL_EMBED_LIBRARY=ON)
fi
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# Validation build: scripts/validate.py runs build/bin/transcribe-cli and
# needs the validation hooks compiled in.
cmake -S "$SRC" -B "$SRC/build" "${CMAKE_ARGS[@]}" -DTRANSCRIBE_ENABLE_VALIDATION_HOOKS=ON
cmake --build "$SRC/build" -j "$JOBS"

# Release build (hooks off, as shipped) for speed measurements.
cmake -S "$SRC" -B "$SRC/build-release" "${CMAKE_ARGS[@]}"
cmake --build "$SRC/build-release" -j "$JOBS"

echo "transcribe.cpp ${VERSION} ready in $SRC"
