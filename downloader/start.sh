#!/usr/bin/env bash
# Zero-config start for the Scribd screenshot panel.
#
# This is the ONLY thing the bot's launcher runs. Everything is hardcoded:
#   * Python deps are installed on first boot (cached after that).
#   * Chromium comes from the bundled @sparticuz/chromium npm package (no
#     Playwright CDN download, no apt, no system libraries needed).
#   * Ports are 25811 + the host's SERVER_PORT/PORT, bound automatically.
# The operator just adds files and presses Restart — no shell, no env vars.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

if [ -f .env ]; then set -a; . .env; set +a; fi
if [ -f "$HERE/.env" ]; then set -a; . "$HERE/.env"; set +a; fi

PY="${PYTHON_BIN:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then PY=python; fi

# Hardcode a writable browser cache so Playwright never needs $HOME.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null || true
export PYTHONDONTWRITEBYTECODE=1
export AWS_EXECUTION_ENV="${AWS_EXECUTION_ENV:-AWS_Lambda_nodejs22.x}"

# --- Chromium ---------------------------------------------------------------
# chromium.mjs inflates the bundled binary into /tmp and prints `export` lines
# for PLAYWRIGHT_CHROMIUM_EXECUTABLE / LD_LIBRARY_PATH / FONTCONFIG_PATH.
CHROME_ENV=""
if command -v node >/dev/null 2>&1 && [ -f "$HERE/chromium.mjs" ]; then
  CHROME_ENV="$(node "$HERE/chromium.mjs" 2>>"$PLAYWRIGHT_BROWSERS_PATH/chromium.log")" || CHROME_ENV=""
fi
if [ -n "$CHROME_ENV" ]; then
  eval "$CHROME_ENV"
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE LD_LIBRARY_PATH FONTCONFIG_PATH 2>/dev/null || true
fi

# --- Python dependencies ----------------------------------------------------
if ! "$PY" -c 'import playwright, PIL, img2pdf, pypdf' >/dev/null 2>&1; then
  echo "[panel] installing Python dependencies (first boot only)…" >&2
  "$PY" -m pip install --disable-pip-version-check -q -r "$HERE/requirements.txt" >/dev/null 2>&1 \
    || "$PY" -m pip install --disable-pip-version-check -q --break-system-packages -r "$HERE/requirements.txt" >/dev/null 2>&1 \
    || "$PY" -m pip install --disable-pip-version-check -q --user -r "$HERE/requirements.txt" >/dev/null 2>&1 \
    || echo "[panel] WARNING: pip could not install requirements.txt" >&2
fi

# Last resort if the bundled binary is unavailable (e.g. no npm at boot).
if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ]; then
  "$PY" -m playwright install chromium >/dev/null 2>&1 || true
fi

exec "$PY" -m downloader.app "$@"
