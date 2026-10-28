#!/usr/bin/env python3
"""Python entry point for the Scribd panel — XS Systems side.

That panel is a *Python* egg. Its startup command is `python app.py`
(`PY_FILE=app.py`, `REQUIREMENTS_FILE=requirements.txt`), and the box has no
Node, no npm and no `package.json`. So nothing here calls `node`: this file
uses the Python packages from `requirements.txt` and nothing else.

    python app.py              # serve the panel
    python app.py --selftest   # offline checks, no browser or network
    python app.py --health     # print health JSON and exit

Deploy = put `app.py`, `requirements.txt` and `downloader/` in the server
folder and press Restart. The panel binds 0.0.0.0:25811 and the host's
SERVER_PORT/PORT straight away; Playwright's Chromium is prepared in the
background on first boot so a slow download never blocks the port.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

MARKER = Path(os.environ.get("SCRIBD_BROWSER_MARKER", "/tmp/.scribd-chromium-ready"))


def _log(message: str) -> None:
    print(f"[panel] {message}", flush=True)


def _short_error(output: str) -> str:
    """One readable line from pip/playwright stderr instead of a stack dump."""
    lines = [line.strip() for line in (output or "").splitlines() if line.strip()]
    for line in reversed(lines):
        lowered = line.lower()
        if "error" in lowered or "failed" in lowered or "denied" in lowered:
            return line[:300]
    return lines[-1][:300] if lines else "no output"


def _install_chromium_once() -> None:
    """Download Playwright's Chromium with Python only (background thread)."""
    try:
        from downloader import config

        if config.chrome_executable():
            _log(f"Chromium ready: {config.chrome_executable()}")
            return
    except Exception:  # noqa: BLE001 - never block the panel on this
        pass

    if MARKER.exists():
        return

    _log("Preparing Chromium (first boot only, can take a few minutes)…")
    try:
        result = subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            capture_output=True,
            text=True,
            timeout=int(os.environ.get("SCRIBD_BROWSER_INSTALL_TIMEOUT", "900")),
        )
        if result.returncode == 0:
            MARKER.parent.mkdir(parents=True, exist_ok=True)
            MARKER.touch()
            _log("Chromium installed — screenshots are ready.")
        else:
            _log("Chromium download failed: " + _short_error(result.stderr or result.stdout))
            _log("Search and downloads still work; screenshot jobs will say why.")
    except (OSError, subprocess.SubprocessError) as exc:
        _log(f"Chromium download failed: {exc}")
        _log("Search and downloads still work; screenshot jobs will say why.")


def prepare_browser_in_background() -> None:
    """Never delay the listening port for a browser download."""
    threading.Thread(target=_install_chromium_once, name="scribd-chromium", daemon=True).start()


def main() -> int:
    if not (HERE / "downloader" / "app.py").is_file():
        print("[panel] downloader/ is missing next to app.py.", flush=True)
        print("[panel] Upload app.py, requirements.txt and the downloader/ folder.", flush=True)
        return 1

    # `--selftest` is offline and must not touch the network or the browser.
    if "--selftest" not in sys.argv and "--health" not in sys.argv:
        prepare_browser_in_background()

    from downloader.app import main as panel_main

    return panel_main()


if __name__ == "__main__":
    raise SystemExit(main())
