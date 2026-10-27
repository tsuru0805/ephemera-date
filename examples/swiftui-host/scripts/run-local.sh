#!/usr/bin/env bash
# Start an engine and the web package on this Mac for the example host (simulator or a device on the same Wi-Fi).
#
#   engine      ephemera-date serve on 127.0.0.1:$ENGINE_PORT, data in $EPHEMERA_DATA_DIR
#   web package web/dist served at http://127.0.0.1:$WEB_PORT/app/ by web/scripts/serve.mjs,
#               which also proxies /api and /mcp to the engine (same origin → no CORS setting needed)
#
# Needs: the engine installed (pip install -e . at the repo root) and the web package built (cd web && npm ci && npm run build).
# Stop with Ctrl-C (both processes stop).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
: "${EPHEMERA_BIN:=ephemera-date}"
: "${ENGINE_PORT:=18871}"
: "${WEB_PORT:=18870}"
: "${EPHEMERA_DATA_DIR:=/tmp/ephemera-host-data}"
: "${EPHEMERA_HER_TOKEN:=her-host-token}"
: "${EPHEMERA_AI_TOKEN:=ai-host-token}"
: "${EPHEMERA_PLACES_PROVIDER:=none}"          # no place search: nothing leaves this machine
export EPHEMERA_DATA_DIR EPHEMERA_HER_TOKEN EPHEMERA_AI_TOKEN EPHEMERA_PLACES_PROVIDER
mkdir -p "$EPHEMERA_DATA_DIR"

[ -f "$repo/web/dist/index.html" ] || { echo "web/dist is missing: cd web && npm ci && npm run build" >&2; exit 1; }

"$EPHEMERA_BIN" serve --port "$ENGINE_PORT" &
engine=$!
node "$repo/web/scripts/serve.mjs" "$repo/web/dist" --port "$WEB_PORT" --base /app --engine "http://127.0.0.1:$ENGINE_PORT" &
web=$!
trap 'kill $engine $web 2>/dev/null || true' EXIT INT TERM

echo "page:       http://127.0.0.1:$WEB_PORT/app/"
echo "credential: $EPHEMERA_HER_TOKEN"
echo "AI (MCP):   http://127.0.0.1:$WEB_PORT/mcp  token $EPHEMERA_AI_TOKEN"
wait
