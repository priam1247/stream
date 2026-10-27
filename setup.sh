#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
python3 -m pip install -r downloader/requirements.txt
python3 -m playwright install chromium
