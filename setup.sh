#!/usr/bin/env bash
# OPTIONAL manual helper. Normal deploy needs none of this: index.js auto-runs
# downloader/start.sh, which installs Python deps and prepares the bundled
# Chromium on every boot (cached). Run this only to pre-warm a server.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PY="${PYTHON_BIN:-python3}"
"$PY" -m pip install --disable-pip-version-check -r downloader/requirements.txt
if command -v node >/dev/null 2>&1; then
  node downloader/chromium.mjs || true
fi
echo "Ready. Start with: node index.js   (the Scribd panel auto-starts)."
