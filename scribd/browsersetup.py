"""Install Chromium and prove that it launches — one job, from the web page.

Shared hosting is where this matters: `playwright install chromium` can succeed
and the browser still refuses to start because the container image has no
`libnss3`, `libatk-1.0`, `libgbm`, … A download without a smoke test would leave
you with a page that accepts jobs and fails them all, with nothing saying why.

    python -m scribd.browsersetup
    python -m scribd.browsersetup --check     # only test, do not download

Exit code 0 only when Chromium really launched.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

MISSING_LIB_HINT = """\
Chromium was downloaded but cannot start. The lines above name the missing
shared libraries (libnspr4, libnss3, libatk-1.0, libgbm, …).

No root is needed for those: they are ordinary files inside Debian packages.
`_fix_missing_libraries` above already tries to fetch them; if that failed:
  1. retry the button (the download resumes);
  2. `python -m scribd.sysroot` from a shell shows every soname and package;
  3. ask your host for an image with Chromium's dependencies;
  4. or run the web UI on your own PC — python -m scribd.webapp
"""


def _say(message: str = "") -> None:
    print(message, flush=True)


def free_mb(path: Path) -> int:
    try:
        return shutil.disk_usage(path).free // (1024 * 1024)
    except OSError:
        return -1


def chromium_path() -> str:
    """Same lookup the web UI uses (kept import-light for the CLI import cost)."""
    from scribd.chromium import find_chromium

    return find_chromium()


def install() -> int:
    _say("downloading Chromium (~150 MB, once)…")
    try:
        result = subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"])
    except OSError as exc:
        _say(f"could not start playwright: {exc}")
        return 1
    if result.returncode != 0:
        _say(
            "\nThe download failed. If this said 'Client network socket "
            "disconnected', the host blocked cdn.playwright.dev — retry, or "
            "ask the host, or run the UI on your own machine."
        )
        return result.returncode
    return 0


def check() -> int:
    """Actually launch headless Chromium — the only honest test.

    Tries every launch variant (headless shell, full Chrome, explicit binary).
    When the browser dies because a library is missing, it is fetched into
    `webdata/sysroot` and the launch is retried once — no root required.
    """
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # pragma: no cover - depends on install state
        _say(f"FAILED: playwright is not importable: {exc}")
        _say("add `playwright` to requirements.txt (or PY_PACKAGES) and restart")
        return 1

    from scribd.chromium import BrowserLaunchError, launch_sync

    _say("launching headless Chromium…")
    try:
        with sync_playwright() as pw:
            try:
                browser, mode = launch_sync(pw, headless=True, log=_say)
            except BrowserLaunchError as exc:
                if not _fix_missing_libraries(str(exc)):
                    _say("FAILED: Chromium cannot start on this machine (reasons above)")
                    return 1
                _say("retrying the launch with the fetched libraries…")
                try:
                    browser, mode = launch_sync(pw, headless=True, log=_say)
                except BrowserLaunchError:
                    _say("FAILED: Chromium still cannot start (reasons above)")
                    return 1
                return _verify(browser, mode)

            return _verify(browser, mode)
    except Exception as exc:  # pragma: no cover - defensive
        _say(f"FAILED: {type(exc).__name__}: {exc}")
        return 1


def _verify(browser, mode: str) -> int:
    """Prove the browser renders and prints, not just that it started."""
    version = browser.version
    try:
        page = browser.new_page(viewport={"width": 800, "height": 600})
        page.set_content("<h1 id=x>ok</h1>")
        page.inner_text("#x")
        page.pdf(prefer_css_page_size=True)
    finally:
        browser.close()
    _say(f"OK: Chromium {version} launches, renders and prints PDFs")
    _say(f"    mode: {mode}  (remembered for later jobs)")
    path = chromium_path()
    if path:
        _say(f"    binary: {path}")
    return 0


def _fix_missing_libraries(message: str) -> bool:
    """Fetch the shared libraries Chromium lacks — no root needed."""
    lowered = message.lower()
    if "shared librar" not in lowered and "cannot open shared object" not in lowered:
        return False
    if os.environ.get("SCRIBD_SYSROOT_AUTO", "1").strip().lower() in ("0", "false", "no"):
        _say("library auto-install disabled (SCRIBD_SYSROOT_AUTO=0)")
        return False
    from scribd.chromium import find_chromium
    from scribd.sysroot import ensure

    binary = find_chromium()  # the shell works for ldd too
    if not binary:
        return False
    _say("")
    _say("fetching the missing libraries into the app folder (no root needed)…")
    try:
        ok, packages = ensure(binary, log=_say)
    except Exception as exc:  # network, mirror, zstd … report, do not crash
        _say(f"could not fetch libraries: {type(exc).__name__}: {exc}")
        return False
    if not ok:
        return False
    _say(f"fetched {len(packages)} package(s): " + ", ".join(packages))
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Install and verify Chromium")
    parser.add_argument("--check", action="store_true", help="only test the browser")
    parser.add_argument("--force", action="store_true", help="re-download even if present")
    args = parser.parse_args(argv)

    os.environ.setdefault("PYTHONUNBUFFERED", "1")

    if not args.check:
        have = chromium_path()
        free = free_mb(Path.cwd())
        if free >= 0:
            _say(f"disk free: {free} MB")
            if free < 300:
                _say("WARNING: less than 300 MB free — the download may not fit.")
        if have and not args.force:
            _say(f"chromium already downloaded: {have}")
        else:
            code = install()
            if code != 0:
                return code

    return check()


if __name__ == "__main__":
    raise SystemExit(main())
