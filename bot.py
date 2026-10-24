"""Entry point for panels that run a single file.

Pterodactyl-based hosts (including panel.xsystemshosting.com) start the server
with

    python /home/container/bot.py

i.e. **one file**, no arguments, no shell. So the web UI is started from here and
takes its port from the panel's own `SERVER_PORT` variable.

Nothing here is required on a normal machine: `python -m scribd.webapp` still
works the same way. This file only exists so the panel has something to run.

Panel settings that matter:

    PY_FILE            bot.py                     (the default)
    PY_PACKAGES        (empty if playwright is in requirements.txt)
    Git Branch         main
    Startup variables  SCRIBD_WEB_USER, SCRIBD_WEB_PASS,
                       SCRIBD_WEB_COOKIES=/home/container/cookies.txt

Optional:

    SCRIBD_WEB_AUTO_BROWSER=1   download Chromium on boot if it is missing
    SCRIBD_WEB_DATA=/home/container/webdata
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def ensure_browser() -> None:
    """Download Chromium once, if the panel asked for it (there is no shell)."""
    if os.environ.get("SCRIBD_WEB_AUTO_BROWSER", "").strip().lower() not in ("1", "true", "yes"):
        return
    from scribd.webapp import browser_status

    if browser_status()["chromium"]:
        return
    print("browser: downloading Chromium (first boot only, ~150 MB)…", flush=True)
    result = subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium"],
        cwd=str(ROOT),
    )
    if result.returncode != 0:
        print(
            "browser: download failed. If the web UI still says Chromium is missing,\n"
            "         add `playwright` to requirements.txt and restart, or press\n"
            "         'Install Chromium' on the page.",
            flush=True,
        )


def main() -> None:
    os.chdir(ROOT)  # so ./webdata and ./out land next to the code
    print(f"starting from {ROOT}", flush=True)
    ensure_browser()
    from scribd.webapp import main as web_main

    host = os.environ.get("SCRIBD_WEB_HOST", "0.0.0.0")  # the panel proxies to us
    web_main(host=host, port=None)                        # port: SERVER_PORT


if __name__ == "__main__":
    main()
