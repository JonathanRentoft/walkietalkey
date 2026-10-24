#!/usr/bin/env bash
# SEC-11 (run 5): the Mac app never calls the keychain, so no update can make macOS ask for the
# login password. Fails when a WalkieTalkey binary imports any SecItem* or SecKeychain* call.
#
#   scripts/walkietalkey/check-no-keychain.sh src-tauri/target/release/bundle/macos/WalkieTalkey.app
#   scripts/walkietalkey/check-no-keychain.sh src-tauri/target/debug/walkietalkey
#
# Accepts app bundles (every executable in Contents/MacOS is checked) and plain binaries. TLS
# certificate checks (SecTrust*, SecCertificate*, SecPolicy*) are fine: they never touch an item
# and never ask.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <WalkieTalkey.app | binary>..." >&2
  exit 2
fi

binaries=()
for target in "$@"; do
  if [ -d "$target" ]; then
    while IFS= read -r -d '' bin; do binaries+=("$bin"); done \
      < <(find "$target/Contents/MacOS" -type f -perm -u+x -print0)
  else
    binaries+=("$target")
  fi
done
if [ "${#binaries[@]}" -eq 0 ]; then
  echo "error: no executables found in $*" >&2
  exit 2
fi

failed=0
for bin in "${binaries[@]}"; do
  found="$(nm -u "$bin" 2>/dev/null | grep -E '^[[:space:]]*_Sec(Item|Keychain)' | sort -u || true)"
  if [ -n "$found" ]; then
    echo "error: $bin calls the keychain (SEC-11):" >&2
    echo "$found" >&2
    failed=1
  else
    echo "ok: $bin imports no keychain calls"
  fi
done
exit "$failed"
