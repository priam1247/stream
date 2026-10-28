#!/usr/bin/env python3
"""
chromium_launch.py — one place that decides which Chromium to start.

Python's Playwright normally wants `python -m playwright install chromium`, which
downloads into ~/.cache/ms-playwright.  On a shared panel that fails (no root, a
tiny or noexec /tmp, a disk quota).  So this module looks for a browser in this
order and launches whatever it finds:

  1. an explicit path (--chromium-path) or $SCRIBD_CHROMIUM
  2. $PLAYWRIGHT_CHROMIUM_EXECUTABLE / $CHROME_PATH / $CHROMIUM_PATH
  3. ./.chromium/chromium            <- what chromium_setup.py unpacks
  4. Playwright's own download       <- the normal case on a workstation
  5. a system chromium / chrome      <- apt, snap, /usr/bin/google-chrome

When the browser comes from @sparticuz/chromium it also needs its private
libraries, fonts and a writable HOME, so those are passed through the `env`
parameter instead of being global state.

Usage
-----
    import chromium_launch as cl
    browser = cl.launch(pw, args=["--no-sandbox", "--disable-dev-shm-usage"])

Every failure is raised as BrowserLaunchError with the full Playwright message,
the executable that was tried and the fix that matches the error text.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

EXE_ENV = "SCRIBD_CHROMIUM"
_OVERRIDE: str | None = None

# names tried in step 5
SYSTEM_NAMES = (
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
)


class BrowserLaunchError(RuntimeError):
    """Launch failed.  str() is short enough for a log line; .detail is full."""

    def __init__(self, summary: str, detail: str | None = None) -> None:
        super().__init__(summary)
        self.detail = detail or summary


def set_override(path: str | None) -> None:
    """Force a specific executable (from --chromium-path)."""
    global _OVERRIDE
    _OVERRIDE = str(path) if path else None


def _from_bundle(directory: Path) -> tuple[str, dict] | None:
    exe = directory / "chromium"
    if not exe.exists():
        return None
    return str(exe), _sibling_env(directory)


def bundle_dirs() -> tuple[Path, ...]:
    """Where a self-contained browser may have been unpacked."""
    here = Path(__file__).resolve().parent
    return (Path.cwd() / ".chromium", here / ".chromium")


def _playwright_browser() -> str | None:
    """Return Playwright's own chromium if it is really there."""
    try:
        cache = Path(
            os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
            or Path.home() / ".cache" / "ms-playwright"
        )
    except Exception:
        return None
    for pattern in (
        "chromium-*/chrome-linux/chrome",
        "chromium-*/chrome-linux64/chrome",
        "chromium_headless_shell-*/chrome-linux/chrome-headless-shell",
        "chromium_headless_shell-*/chrome-linux64/chrome-headless-shell",
    ):
        hits = sorted(cache.glob(pattern))
        if hits:
            return str(hits[-1])
    return None


def status() -> dict:
    """What would launch, and will it work? Used for startup banners."""
    try:
        path, _env = resolve()
    except BrowserLaunchError as exc:
        return {"ok": False, "path": None, "source": "invalid path", "hint": str(exc)}
    if path:
        return {"ok": True, "path": path, "source": "explicit or bundled", "hint": ""}
    found = _playwright_browser()
    if found:
        return {
            "ok": True,
            "path": found,
            "source": "playwright's own download",
            "hint": "",
        }
    return {
        "ok": False,
        "path": None,
        "source": "none",
        "hint": "no browser installed - run: python chromium_setup.py",
    }


def resolve(explicit: str | None = None) -> tuple[str | None, dict[str, str]]:
    """Return (executable or None, extra environment)."""
    for path in (_OVERRIDE, explicit, os.environ.get(EXE_ENV)):
        if path:
            p = Path(path).expanduser()
            if p.is_file():
                return str(p), _sibling_env(p.parent)
            raise BrowserLaunchError(
                f"{path} was given as the Chromium path but does not exist.\n"
                "  fix: python chromium_setup.py     (unpacks it into ./.chromium)"
            )

    for var in ("PLAYWRIGHT_CHROMIUM_EXECUTABLE", "CHROME_PATH", "CHROMIUM_PATH"):
        val = os.environ.get(var)
        if val and Path(val).is_file():
            return val, _sibling_env(Path(val).parent)

    for directory in bundle_dirs():
        found = _from_bundle(directory)
        if found:
            return found

    # let Playwright use its own download if it has one
    if _playwright_browser():
        return None, {}

    for name in SYSTEM_NAMES:
        path = shutil.which(name)
        if path:
            return path, {}
    return None, {}


def _sibling_env(directory: Path) -> dict[str, str]:
    """Environment a @sparticuz bundle needs; nothing for a normal system chrome.

    LD_LIBRARY_PATH  the private userland libraries it ships (al2023/lib)
    FONTCONFIG_FILE  a fontconfig pointing at *these* fonts.  The file shipped in
                     the tarball lists Lambda paths (/var/task/.fonts), which makes
                     Skia abort the renderer with SIGTRAP as soon as a page draws
                     text - "Target closed" on the first real navigation.
    HOME             a writable profile directory
    TMPDIR           must not be a noexec/small /tmp
    """
    env: dict[str, str] = {}
    lib = directory / "al2023" / "lib"
    if lib.is_dir():
        env["LD_LIBRARY_PATH"] = (
            f"{lib}:{os.environ.get('LD_LIBRARY_PATH', '')}".rstrip(":")
        )
        env["HOME"] = str(directory)

    fonts_root = directory / "fonts"
    conf = fonts_root / "fonts.conf"
    if conf.is_file():
        text = conf.read_text(encoding="utf-8", errors="replace")
        if str(fonts_root) not in text:
            # the shipped Lambda config - rewrite it for this host
            try:
                import chromium_setup

                conf = chromium_setup.write_fonts_conf(fonts_root / "fonts", fonts_root)
            except Exception:
                conf = None
        if conf is not None:
            env["FONTCONFIG_FILE"] = str(conf)
            env.pop("FONTCONFIG_PATH", None)
            (fonts_root / "fonts-cache").mkdir(exist_ok=True)
    return env


def diagnose(exc: Exception, exe: str | None) -> str:
    """Map the Playwright error text onto the known causes."""
    text = f"{type(exc).__name__}: {exc}"
    low = text.lower()
    where = exe or "playwright's own download"
    head = f"could not launch Chromium ({where})\n  {text.splitlines()[0]}"

    if "executable doesn't exist" in low or "playwright install" in low:
        return (
            f"{head}\n\nno browser is installed. Any host, no root needed:\n"
            "  python chromium_setup.py\n"
            "or, if you can install system packages:\n"
            "  python -m playwright install chromium"
        )
    if "eacces" in low or "permission denied" in low:
        return (
            f"{head}\n\nEACCES: the filesystem holding the browser does not allow "
            "execution (a noexec mount).\n"
            "  fix: put it on an exec-allowed volume, e.g.\n"
            "    python chromium_setup.py --dir ~/chromium && "
            "export SCRIBD_CHROMIUM=~/chromium/chromium\n"
            "    (and run with TMPDIR=~/tmp so the profile lands there too)"
        )
    if "error while loading shared libraries" in low:
        line = next(
            (ln for ln in text.splitlines() if "shared libraries" in ln), text
        ).strip()
        return (
            f"{head}\n\n{line}\n"
            "a system library is missing. If you used @sparticuz/chromium, make sure "
            "the al2023 libraries are exported:\n"
            "  export LD_LIBRARY_PATH=<dir>/al2023/lib:$LD_LIBRARY_PATH"
        )
    if "enoent" in low or "no such file" in low:
        return (
            f"{head}\n\nthe executable path does not exist - "
            "check --chromium-path / $SCRIBD_CHROMIUM."
        )
    if (
        "target closed" in low
        or "target page, context or browser has been closed" in low
    ):
        return (
            f"{head}\n\n'Target closed' at launch is almost always a bad argument. "
            "Bisect:\n"
            "  launch with args=['--no-sandbox'] only, then add flags back.\n"
            "  Usual suspects: --single-process, --in-process-gpu, --no-zygote."
        )
    if "enospc" in low or "no space left" in low:
        return (
            f"{head}\n\nthe disk filled up. Point TMPDIR at a volume with ~300 MB "
            "free before extracting the browser."
        )
    return f"{head}\n\nunrecognised failure - full error:\n{text}"


def launch(pw, args: list[str] | None = None, **kwargs):
    """Launch Chromium, choosing the executable and env automatically."""
    exe, extra_env = resolve(kwargs.pop("chromium_path", None))
    env = {**os.environ, **extra_env} if extra_env else None
    try:
        return pw.chromium.launch(
            executable_path=exe,
            args=args or ["--no-sandbox", "--disable-dev-shm-usage"],
            env=env,
            **kwargs,
        )
    except Exception as exc:
        full = diagnose(exc, exe)
        first = full.splitlines()[0] if full else "launch failed"
        # the fix paragraph, without the chained Playwright stack
        rest = [ln for ln in full.splitlines()[1:] if ln.strip()][:6]
        raise BrowserLaunchError("\n".join([first, *rest]), full) from None


def describe() -> str:
    """One-line summary for startup banners, honest about a missing browser."""
    st = status()
    if not st["ok"]:
        return f"chromium: MISSING - {st['hint']}"
    if st["path"]:
        return f"chromium: {st['path']}"
    return f"chromium: {st['source']}"
