#!/usr/bin/env bash
# Runs the wt-relay-client integration tests against a local relay (`wrangler dev`).
# Needs bun and the relay's dependencies (`cd relay && bun install`). Extra arguments go to
# the test binary, for example a test name.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
port="${WT_TEST_PORT:-8799}"
log="${TMPDIR:-/tmp}/wt-relay-dev-$$.log"

(cd "$repo/relay" && WRANGLER_SEND_METRICS=false exec bunx wrangler dev --env integration --ip 127.0.0.1 --port "$port" >"$log" 2>&1) &
relay_pid=$!

cleanup() {
  pkill -TERM -P "$relay_pid" 2>/dev/null || true
  kill -TERM "$relay_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:$port/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -sf "http://127.0.0.1:$port/v1/health" >/dev/null || { echo "local relay did not start; see $log"; exit 1; }

cd "$here"
WT_TEST_RELAY_URL="ws://127.0.0.1:$port" cargo test --test integration -- --ignored "$@"
