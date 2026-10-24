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

Settings come from (in this order, first one wins):
    1. real environment variables, if the panel has a variable editor
    2. `.env` in this folder (upload it next to bot.py; see .env.example)
    3. defaults

    SCRIBD_WEB_USER / SCRIBD_WEB_PASS   login for the page (optional: a random
                                        password is printed on first start)
    SCRIBD_WEB_COOKIES                  cookies.txt path; if unset, ./cookies.txt
                                        next to bot.py is used automatically
    SCRIBD_WEB_DATA                     where PDFs/jobs live (default ./webdata)
    SCRIBD_WEB_AUTO_BROWSER=1           download Chromium on boot if missing
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_settings() -> None:
    """Read ./.env when the panel has no variable editor (a real env var wins)."""
    if str(ROOT) not in sys.path:
        return
    try:
        from scribd.dotenv import load_env
    except Exception:  # the repo is broken mid-update; let the real error show later
        return
    loaded = load_env(os.environ.get("SCRIBD_WEB_ENV_FILE", ""), ROOT / ".env", Path.cwd() / ".env")
    if loaded:
        print(f"settings: loaded {loaded}", flush=True)


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


def ensure_libraries() -> None:
    """Fetch Chromium's system libraries before the first job needs them."""
    try:
        from scribd.sysroot import preflight

        if preflight(log=print):
            return
        print("libraries: Chromium may still fail to start — see above", flush=True)
    except Exception as exc:  # never stop the server from booting
        print(f"libraries: check skipped ({type(exc).__name__}: {exc})", flush=True)


def run_diagnostics() -> None:
    """SCRIBD_DIAG=1 -> one-boot report: libc, ldd, egress, search, doc chain."""
    try:
        from diag import run_diag

        run_diag()  # no-op unless SCRIBD_DIAG is set
    except Exception as exc:  # never stop the server from booting
        print(f"diag skipped: {type(exc).__name__}: {exc}", flush=True)


def main() -> None:
    os.chdir(ROOT)  # so ./webdata and ./out land next to the code
    print(f"starting from {ROOT}", flush=True)
    load_settings()
    ensure_browser()
    ensure_libraries()          # sysroot first: diag's ldd must see the fix
    run_diagnostics()
    from scribd.webapp import main as web_main

    host = os.environ.get("SCRIBD_WEB_HOST", "0.0.0.0")  # the panel proxies to us
    web_main(host=host, port=None)                        # port: SERVER_PORT


if __name__ == "__main__":
    main()
