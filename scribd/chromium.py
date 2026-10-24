"""Launch Chromium the way this machine can actually launch it.

Playwright 1.4x runs `chrome-headless-shell` for `headless=True`. On shared
containers that binary can die instantly (missing `libnss3`, no `/dev/shm`,
seccomp blocking the zygote …) while the full Chrome build next to it still
works. `TargetClosedError: BrowserType.launch: Target page, context or browser
has been closed` is what you get in that case — with the real reason buried in
the browser log.

So this module tries the known-good variants in order and remembers which one
worked:

    1. headless shell (playwright's default)          mode "shell"
    2. the full Chrome build, channel="chromium"      mode "chrome"
    3. the full Chrome build by explicit path          mode "path"

The winner is cached in `<repo>/webdata/browser.json` (override with
SCRIBD_BROWSER_CACHE), so later jobs start with the working one first.

Missing system libraries (`libnspr4.so`, `libnss3.so`, …) are handled too: if
`scribd.sysroot` has already unpacked them into `webdata/sysroot`, every launch
gets `LD_LIBRARY_PATH` pointing there. `python -m scribd.sysroot` fetches them
without root.

Environment knobs:

    SCRIBD_BROWSER_MODE=shell|chrome|path|auto   force one variant
    SCRIBD_BROWSER_ARGS="--foo --bar"            extra Chromium arguments
    SCRIBD_BROWSER_SANDBOX=1                     keep the sandbox (drops --no-sandbox)
    SCRIBD_BROWSER_CACHE=/path/browser.json      where the winner is remembered
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parent.parent

BASE_ARGS = [
    "--no-sandbox",            # containers rarely allow user namespaces
    "--disable-dev-shm-usage",  # /dev/shm is tiny in Docker
    "--disable-gpu",
    "--hide-scrollbars",
    "--disable-blink-features=AutomationControlled",
]

HINT_NO_LIBS = (
    "The browser log above names the missing library (libnspr4, libnss3, "
    "libatk-1.0, libgbm, libxkbcommon, …). No root is needed for these: they "
    "are files inside Debian packages,\n"
    "  - `python -m scribd.sysroot` fetches exactly the ones the loader asks "
    "for and unpacks them into webdata/sysroot\n"
    "  - the web page's *Install & test Chromium* button does that "
    "automatically, then relaunches\n"
    "  - ask the host to run `playwright install-deps chromium` once, or run "
    "the web UI on your own machine (python -m scribd.webapp)."
)


def apply_sysroot() -> str:
    """Make container-fetched libraries visible to Chromium (no-op when absent)."""
    try:
        from .sysroot import apply_env

        return apply_env()
    except Exception:  # never let this break a launch
        return os.environ.get("LD_LIBRARY_PATH", "")


def base_args(extra: list[str] | None = None) -> list[str]:
    args = list(BASE_ARGS)
    if os.environ.get("SCRIBD_BROWSER_SANDBOX", "").strip().lower() in ("1", "true", "yes"):
        args = [arg for arg in args if arg != "--no-sandbox"]
    env_args = os.environ.get("SCRIBD_BROWSER_ARGS", "").split()
    for arg in list(env_args) + list(extra or []):
        if arg and arg not in args:
            args.append(arg)
    return args


def cache_path() -> Path:
    configured = os.environ.get("SCRIBD_BROWSER_CACHE", "").strip()
    if configured:
        return Path(configured)
    return REPO_ROOT / "webdata" / "browser.json"


def _read_cache() -> dict[str, Any]:
    try:
        return json.loads(cache_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_winner(mode: str) -> None:
    path = cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"mode": mode}, indent=2), encoding="utf-8")
    except OSError:
        pass


def clear_cache() -> None:
    try:
        cache_path().unlink()
    except OSError:
        pass


# playwright changed its layout over the years: chrome-linux (old),
# chrome-linux64 (current "Chrome for Testing"), plus the headless shell.
CHROME_LAYOUTS = (
    "*/chrome-linux64/chrome",
    "*/chrome-linux/chrome",
    "*/chrome-linux64/headless_shell",
    "*/chrome-linux/headless_shell",
    "*/chrome-headless-shell-linux64/chrome-headless-shell",
)


def browser_dirs() -> list[Path]:
    bases: list[Path] = []
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "").strip()
    if root:
        bases.append(Path(root))
    data = Path(os.environ.get("SCRIBD_WEB_DATA", "./webdata")).expanduser()
    bases += [
        Path.home() / ".cache" / "ms-playwright",
        REPO_ROOT / ".cache" / "ms-playwright",
        data / "ms-playwright",
    ]
    seen: list[Path] = []
    for base in bases:
        if base.is_dir() and base not in seen:
            seen.append(base)
    return seen


def find_chromium() -> str:
    """Any Chromium binary playwright downloaded (shell or full build)."""
    for base in browser_dirs():
        for layout in CHROME_LAYOUTS:
            for match in base.glob(layout):
                if match.is_file():
                    return str(match)
    return ""


def chromium_binary() -> str:
    """Full Chrome build only — `executable_path` must not point at the shell."""
    found = find_chromium()
    return found if found.endswith("/chrome") else ""


def candidates(headless: bool = True, extra_args: list[str] | None = None) -> list[tuple[str, dict[str, Any]]]:
    """Ordered `(mode, kwargs)` launch attempts, cheapest/best first."""
    args = base_args(extra_args)
    apply_sysroot()
    tries: list[tuple[str, dict[str, Any]]] = [
        ("shell", {"headless": headless, "args": args}),
        ("chrome", {"headless": headless, "args": args, "channel": "chromium"}),
    ]
    binary = chromium_binary()
    if binary:
        tries.append(
            ("path", {"headless": headless, "args": args, "executable_path": binary})
        )

    forced = os.environ.get("SCRIBD_BROWSER_MODE", "").strip().lower()
    if forced and forced != "auto":
        tries = [item for item in tries if item[0] == forced] or tries
        return tries

    preferred = str(_read_cache().get("mode") or "").lower()
    if preferred:
        tries.sort(key=lambda item: 0 if item[0] == preferred else 1)
    return tries


def _describe(mode: str) -> str:
    return {
        "shell": "headless shell",
        "chrome": "full Chrome (channel=chromium)",
        "path": "full Chrome (explicit binary)",
    }.get(mode, mode)


def _collect(errors: list[tuple[str, str]], attempts: int, log: Callable[[str], None] | None) -> str:
    lines = [f"all {attempts} Chromium launch variant(s) failed:"]
    for mode, message in errors:
        first = message.strip().splitlines()
        lines.append(f"  - {_describe(mode)}: {first[0] if first else 'no message'}")
        for line in first[1:]:
            if "[pid]" in line or "shared librar" in line.lower() or "sandbox" in line.lower():
                lines.append(f"      {line.strip()}")
    if any("shared librar" in message.lower() or "cannot open shared object" in message.lower()
           for _, message in errors):
        lines.append(HINT_NO_LIBS)
    text = "\n".join(lines)
    if log:
        log(text)
    return text


class BrowserLaunchError(RuntimeError):
    pass


async def launch_async(
    playwright: Any,
    headless: bool = True,
    extra_args: list[str] | None = None,
    log: Callable[[str], None] | None = None,
) -> Any:
    errors: list[tuple[str, str]] = []
    tries = candidates(headless, extra_args)
    for mode, kwargs in tries:
        try:
            browser = await playwright.chromium.launch(**kwargs)
        except Exception as exc:  # noqa: BLE001 - every failure is retried once
            errors.append((mode, str(exc)))
            continue
        if mode != (tries[0][0]):
            if log:
                log(f"  browser: using {_describe(mode)}")
        save_winner(mode)
        return browser
    raise BrowserLaunchError(_collect(errors, len(tries), log))


def launch_sync(
    playwright: Any,
    headless: bool = True,
    extra_args: list[str] | None = None,
    log: Callable[[str], None] | None = None,
) -> tuple[Any, str]:
    """Returns `(browser, mode)` so callers can report what worked."""
    errors: list[tuple[str, str]] = []
    tries = candidates(headless, extra_args)
    for mode, kwargs in tries:
        try:
            browser = playwright.chromium.launch(**kwargs)
        except Exception as exc:  # noqa: BLE001
            errors.append((mode, str(exc)))
            continue
        save_winner(mode)
        return browser, mode
    raise BrowserLaunchError(_collect(errors, len(tries), log))
