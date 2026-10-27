#!/usr/bin/env bash
# Deployment wrapper for the standalone downloader panel (see Procfile).
# Works whether downloader/ is the app root or a subfolder of the repo.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
if [ -f .env ]; then set -a; . .env; set +a; fi
PY="${PYTHON_BIN:-python3}"
if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ]; then
  "$PY" -m playwright install chromium >/dev/null 2>&1 || true
fi
exec "$PY" app.py "$@"
