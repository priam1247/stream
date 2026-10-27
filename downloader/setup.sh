#!/usr/bin/env bash
# Install the pinned Python dependencies and Chromium for the standalone panel.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
PY="${PYTHON_BIN:-python3}"
"$PY" -m pip install -r requirements.txt
"$PY" -m playwright install chromium
