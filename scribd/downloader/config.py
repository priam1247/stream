"""Hardcoded settings for the screenshot-only Scribd panel.

No feature flags, page-source switches, shooter discovery, scan ladders or
retry budgets live here. A few deployment values (port, panel key, CORS
origin, cookie file, output folder and an optional Chromium executable) can be
overridden with environment variables; every runtime default is fixed below.
"""

from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
VERSION = "3.1.0"
HOST = "0.0.0.0"

# Fixed browser and Scribd settings.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
FIND_URL = "https://www.scribd.com/search/query"
FIND_REFERER = "https://www.scribd.com/search"
FIND_PER_PAGE = 40
FIND_MAX_PAGE = 40
DOCUMENT_URL = "https://www.scribd.com/document/{id}"
EMBED_URL = "https://www.scribd.com/embeds/{id}/content"
VIEWPORT = {"width": 1280, "height": 1800}
DEVICE_SCALE = 1
NAV_TIMEOUT_MS = 30_000
RENDER_TIMEOUT_MS = 12_000
SHOT_TIMEOUT_MS = 15_000
SEARCH_TIMEOUT_S = 15
JPEG_QUALITY = 90
MAX_PAGES = 5_000
MAX_DOCUMENTS = 100
MAX_BODY_BYTES = 1_000_000
BLANK_RETRIES = 2
MAX_FILES = 40
MAX_LOG_LINES = 120
PANEL_COOKIE = "scribd_panel_key"
CHROME_ARGS = (
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--force-color-profile=srgb",
)
BLOCKED_HOST_PARTS = (
    "osano.com",
    "googletagmanager.com",
    "google-analytics.com",
    "doubleclick.net",
    "facebook.net",
    "connect.facebook.net",
    "hotjar.com",
    "newrelic.com",
    "nr-data.net",
    "segment.com",
    "scorecardresearch.com",
    "quantserve.com",
    "adservice.google.com",
    "googlesyndication.com",
    "amazon-adsystem.com",
)


def ports() -> list[int]:
    """Every port the panel listens on — hardcoded, zero configuration.

    Pterodactyl/Botkeep expose ONE allocated port (SERVER_PORT / PORT) and the
    dashboard is hardcoded to http://195.123.189.187:25811. Binding all of them
    at once means the same files work on either server without setting a single
    environment variable. Duplicates are removed; 25811 is always first.
    """
    found: list[int] = [25811]
    for name in ("SCRIBD_PANEL_PORT", "SERVER_PORT", "PORT"):
        raw = (os.environ.get(name) or "").strip()
        if raw.isdigit() and 1 <= int(raw) <= 65535 and int(raw) not in found:
            found.append(int(raw))
    return found


def port() -> int:
    """Primary port (kept for callers that want a single number)."""
    return ports()[0]


def panel_key() -> str:
    """Secret shared with the dashboard. Empty means an open panel."""
    return (
        os.environ.get("PANEL_KEY")
        or os.environ.get("SCRIBD_PANEL_KEY")
        or ""
    ).strip()


def panel_origins() -> list[str]:
    """Explicit CORS origins. A wildcard is never used."""
    raw = os.environ.get("PANEL_ORIGIN") or ""
    return [
        part.strip().rstrip("/")
        for part in raw.split(",")
        if part.strip() and part.strip() != "*"
    ]


def out_dir() -> Path:
    raw = os.environ.get("SCRIBD_OUT")
    return Path(raw).expanduser() if raw else ROOT / "downloads"


def tmp_dir() -> Path:
    raw = os.environ.get("SCRIBD_TMP")
    return Path(raw).expanduser() if raw else ROOT / "tmp"


def cookie_file() -> Path:
    """Fixed cookie locations. No directory walk or service discovery."""
    override = (
        os.environ.get("COOKIES_FILE")
        or os.environ.get("COOKIE_FILE")
        or os.environ.get("SCRIBD_COOKIES_FILE")
    )
    if override:
        return Path(override).expanduser()
    for candidate in (
        ROOT / "cookies.txt",
        REPO_ROOT / "cookies.txt",
        Path("/home/container/cookies.txt"),
    ):
        if candidate.is_file():
            return candidate
    return ROOT / "cookies.txt"


def raw_cookies() -> str:
    return (
        os.environ.get("SCRIBD_COOKIES")
        or os.environ.get("COOKIE")
        or ""
    ).strip()


def chrome_executable() -> str:
    """Path to Chromium, hardcoded to the bundled binary when present.

    @sparticuz/chromium inflates its Chromium to <tmpdir>/chromium and its
    shared libraries to <tmpdir>/al2023/lib (with fonts in <tmpdir>/fonts).
    Playwright's own browser download is blocked on these panels, so this is
    the reliable path. LD_LIBRARY_PATH / FONTCONFIG_PATH are set here too, as
    a fallback in case the launcher's exports did not reach this process —
    setting them before launch() is enough for the Chromium child to inherit.
    """
    explicit = (
        os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
        or os.environ.get("CHROME_PATH")
        or ""
    ).strip()
    if explicit:
        return explicit
    import tempfile

    tmp = Path(tempfile.gettempdir())
    bundled = tmp / "chromium"
    lib_dir = tmp / "al2023" / "lib"
    font_dir = tmp / "fonts"
    if bundled.is_file():
        if lib_dir.is_dir():
            previous = os.environ.get("LD_LIBRARY_PATH", "")
            if str(lib_dir) not in previous:
                os.environ["LD_LIBRARY_PATH"] = (
                    f"{lib_dir}:{previous}" if previous else str(lib_dir)
                )
        if font_dir.is_dir():
            os.environ.setdefault("FONTCONFIG_PATH", str(font_dir))
        return str(bundled)
    return ""


def browsers_path() -> Path:
    """Where Playwright keeps its browsers (default: $HOME/.cache/ms-playwright)."""
    raw = (os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "").strip()
    if raw and raw != "0":
        return Path(raw).expanduser()
    home = os.environ.get("HOME") or str(Path.home())
    return Path(home) / ".cache" / "ms-playwright"


def browser_ready() -> bool:
    """True when a Chromium is actually available to take screenshots.

    Either the bundled binary is unpacked (the JS/bootstrap path) or
    Playwright has downloaded its own build. Used by /diag so a half-deployed
    panel is visible instead of looking healthy until the first download.
    """
    if chrome_executable():
        return True
    base = browsers_path()
    try:
        for pattern in ("chromium-*", "chromium_headless_shell-*"):
            if any(base.glob(pattern)):
                return True
    except OSError:
        return False
    return False


def chrome_args() -> list[str]:
    args = list(CHROME_ARGS)
    extra = (os.environ.get("PLAYWRIGHT_CHROMIUM_EXTRA_ARGS") or "").strip()
    if extra:
        args.extend(extra.split())
    return args


def rebase(url: str) -> str:
    """Test hook: point hardcoded Scribd URLs at a local mock server."""
    base = (os.environ.get("SCRIBD_BASE") or "").strip().rstrip("/")
    if not base:
        return url
    wanted = urlsplit(url)
    local = urlsplit(base)
    return urlunsplit(
        (local.scheme or "http", local.netloc, wanted.path, wanted.query, "")
    )


def ensure_dirs() -> None:
    out_dir().mkdir(parents=True, exist_ok=True)
    tmp_dir().mkdir(parents=True, exist_ok=True)


def safe_name(raw: str) -> str:
    """A file name, never a path."""
    name = unicodedata.normalize("NFKD", str(raw or "")).strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        return ""
    name = name.encode("ascii", "ignore").decode("ascii")
    name = re.sub(r"[^A-Za-z0-9._ -]+", "", name).strip(" .")
    return name[:180]


def safe_filename(title: str, ident: str = "") -> str:
    """Deterministic output PDF name: title plus document id, no timestamps."""
    base = safe_name(title)
    if base.lower().endswith(".pdf"):
        base = base[:-4]
    if not base:
        base = f"document-{ident or 'scribd'}"
    elif ident and ident not in base:
        base = f"{base}-{ident}"
    return f"{base[:140]}.pdf"


def _cookie_domain_ok(domain: str) -> bool:
    host = domain.lstrip(".").lower()
    return (
        host == "scribd.com"
        or host.endswith(".scribd.com")
        or host == "scribdassets.com"
        or host.endswith(".scribdassets.com")
    )


def cookie_records() -> list[dict[str, object]]:
    """Netscape cookies plus a simple raw Cookie header, filtered to Scribd."""
    records: list[dict[str, object]] = []
    path = cookie_file()
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        lines = []
    for raw_line in lines:
        line = raw_line.strip()
        http_only = line.startswith("#HttpOnly_")
        if http_only:
            line = line[len("#HttpOnly_") :]
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 7:
            continue
        domain, _flag, path_value, secure, expires, name, value = parts
        if not name or not _cookie_domain_ok(domain):
            continue
        try:
            expires_at = int(expires)
        except ValueError:
            expires_at = -1
        records.append(
            {
                "name": name,
                "value": value,
                "domain": domain,
                "path": path_value or "/",
                "secure": secure.upper() == "TRUE",
                "httpOnly": http_only,
                "expires": expires_at if expires_at > 0 else -1,
            }
        )
    for part in raw_cookies().split(";"):
        name, separator, value = part.strip().partition("=")
        if not separator or not name or not value:
            continue
        records.append(
            {
                "name": name,
                "value": value,
                "domain": ".scribd.com",
                "path": "/",
                "secure": True,
                "httpOnly": False,
                "expires": -1,
            }
        )
    unique: dict[tuple[str, str, str], dict[str, object]] = {}
    for row in records:
        key = (str(row["domain"]), str(row["name"]), str(row["path"]))
        unique[key] = row
    return list(unique.values())


def cookie_header() -> str:
    """Cookie header for the one search request. Values are never logged."""
    return "; ".join(
        f"{row['name']}={row['value']}" for row in cookie_records()
    )


def playwright_cookies() -> list[dict[str, object]]:
    """Cookies in the shape Playwright's BrowserContext.add_cookies expects."""
    return [
        {
            "name": row["name"],
            "value": row["value"],
            "domain": row["domain"],
            "path": row["path"],
            "secure": row["secure"],
            "httpOnly": row["httpOnly"],
            "sameSite": "Lax",
            "expires": row["expires"],
        }
        for row in cookie_records()
    ]


def cookie_report() -> str:
    count = len(cookie_records())
    return f"{count} Scribd cookie(s)" if count else "anonymous (no cookies)"


def prune_outputs() -> None:
    """Keep the finished folder clean without a disk-quota subsystem."""
    try:
        files = sorted(
            out_dir().glob("*.pdf"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return
    for old in files[MAX_FILES:]:
        try:
            old.unlink()
        except OSError:
            pass
