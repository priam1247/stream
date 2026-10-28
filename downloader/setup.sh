#!/usr/bin/env bash
# OPTIONAL manual helper for a standalone downloader/ deploy. Normal deploy
# needs none of this: start.sh installs the Python deps and prepares the
# bundled Chromium automatically (cached after the first boot).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
PY="${PYTHON_BIN:-python3}"
"$PY" -m pip install --disable-pip-version-check -r requirements.txt
if command -v node >/dev/null 2>&1; then
  node chromium.mjs || true
fi
echo "Ready. Start with: sh start.sh"
