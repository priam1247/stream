#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if [ -f .env ]; then set -a; . .env; set +a; fi
PY="${PYTHON_BIN:-python3}"
"$PY" -m playwright install chromium >/dev/null 2>&1 || true
node --expose-gc index.js &
NODE_PID=$!
"$PY" -m downloader.app &
DL_PID=$!
trap 'kill "$NODE_PID" "$DL_PID" 2>/dev/null || true' INT TERM EXIT
wait -n "$NODE_PID" "$DL_PID"
