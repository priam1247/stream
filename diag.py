"""One-boot diagnostic for a hosted panel — Python standard library only.

Every question that has cost days in this project is answered here, in one
restart, with the evidence written to `.debug/diag-*.html`:

    libc            glibc or musl, and which Debian suite its libraries match
    chromium        does ldd resolve every .so, and does it actually launch
    dns / egress    can this container reach deb.debian.org, Scribd, an engine
    search          can we turn a keyword into document URLs without a browser
    doc chain       doc page -> embed -> one page asset, anonymous AND with
                    your cookies (these two can genuinely differ)

Usage:

    # in .env on the panel
    SCRIBD_DIAG=1
    SCRIBD_DIAG_COOKIES=/home/container/cookies.txt   # optional
    SCRIBD_DIAG_DOC=https://www.scribd.com/document/<id>/<slug>   # optional

    # bot.py runs it after the sysroot step, so ldd sees the fix

    python diag.py            # run it by hand
    python diag.py selftest   # offline check of the parsers

Nothing here writes to the repository, installs anything, or prints a cookie
value: only counts and PASS/FAIL lines.
"""
from __future__ import annotations

import glob
import os
import re
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

CHALLENGE = (
    b"just a moment",
    b"cf-chl",
    b"attention required",
    b"enable javascript",
    b"client challenge",
    b"captcha",
)
CONTENT = (b"docManager", b"page_count", b"document_detail")
DEBUG_DIR = ".debug"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def say(ok: bool, label: str, detail: str = "") -> None:
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {label}" + (f" — {detail}" if detail else ""), flush=True)


def dump(name: str, body: bytes) -> None:
    """Keep the body that decided a FAIL — that is the evidence."""
    try:
        os.makedirs(DEBUG_DIR, exist_ok=True)
        with open(os.path.join(DEBUG_DIR, f"diag-{name}.html"), "wb") as handle:
            handle.write(body or b"")
    except OSError:
        pass


def fetch(url: str, cookies: dict | None = None, timeout: int = 25):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    if cookies:
        request.add_header("Cookie", "; ".join(f"{key}={value}" for key, value in cookies.items()))
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.geturl(), response.read()


def load_cookies(path: str) -> dict[str, str]:
    """Netscape cookies.txt -> {name: value}. Values are never printed."""
    jar: dict[str, str] = {}
    if not path or not os.path.exists(path):
        return jar
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if line.startswith("#HttpOnly_"):
                    line = line[len("#HttpOnly_") :]
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) == 7:
                    jar[parts[5]] = parts[6]
    except OSError:
        pass
    return jar


def classify(body: bytes) -> dict[str, bool]:
    low = (body or b"").lower()
    return {
        "challenge": any(marker in low for marker in CHALLENGE),
        "content": any(marker in (body or b"") for marker in CONTENT),
    }


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------
def check_libc() -> str:
    """musl kills the Debian-sysroot plan; the glibc version picks the suite."""
    try:
        result = subprocess.run(["ldd", "--version"], capture_output=True, text=True, timeout=15)
    except Exception as exc:  # noqa: BLE001
        say(False, "libc", f"{exc!r} — no ldd: assume bookworm and treat "
                           "'GLIBC_x.yy not found' as the signal to drop a suite")
        return "bookworm"
    text = (result.stdout or "") + (result.stderr or "")
    first = (text.strip().splitlines() or [""])[0].lower()
    if "musl" in text.lower()[:400]:
        say(False, "libc", "musl/Alpine image — Debian .so files will never load; "
                           "the Chromium route is impossible on this image")
        return "musl"
    match = re.search(r"(\d+)\.(\d+)", first or text)
    if not match:
        say(False, "libc", f"unrecognised: {first[:60]}")
        return "bookworm"
    version = (int(match.group(1)), int(match.group(2)))
    if version >= (2, 41):
        suite = "trixie"
    elif version >= (2, 36):
        suite = "bookworm"
    else:
        suite = "bullseye"
    note = "" if version >= (2, 31) else " — older than bullseye; expect GLIBC symbol errors"
    say(version >= (2, 31), "libc",
        f"glibc {version[0]}.{version[1]} → pull '{suite}' packages into webdata/sysroot{note}")
    return suite


def _chromium_binaries() -> list[str]:
    roots = [
        os.environ.get("PLAYWRIGHT_BROWSERS_PATH", ""),
        os.path.join(os.path.expanduser("~"), ".cache", "ms-playwright"),
        os.path.join(".", ".cache", "ms-playwright"),
        os.path.join(os.environ.get("SCRIBD_WEB_DATA", "webdata"), "ms-playwright"),
    ]
    found: list[str] = []
    for root in [r for r in roots if r]:
        for pattern in ("**/chrome", "**/chrome-headless-shell", "**/headless_shell"):
            found += glob.glob(os.path.join(root, pattern), recursive=True)
    return sorted(set(found))


def check_chromium_ldd() -> bool:
    """After the sysroot step, every .so must resolve."""
    binaries = _chromium_binaries()
    if not binaries:
        say(False, "chromium binary", "none found — browsers are not installed this boot")
        return False
    clean = True
    for binary in binaries:
        try:
            result = subprocess.run(["ldd", binary], capture_output=True, text=True, timeout=60)
        except Exception as exc:  # noqa: BLE001
            say(False, f"ldd {os.path.basename(binary)}", repr(exc))
            clean = False
            continue
        missing = sorted(set(re.findall(r"(\S+)\s+=>\s+not found", result.stdout)))
        if missing:
            head = ", ".join(missing[:8]) + (" …" if len(missing) > 8 else "")
            say(False, f"ldd {os.path.basename(binary)}", f"{len(missing)} missing: {head}")
            clean = False
        else:
            say(True, f"ldd {os.path.basename(binary)}", "all libraries resolve")
    return clean


def check_chromium_launch() -> bool:
    """ldd clean is necessary, not sufficient: the binary must actually start."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "scribd.browsersetup", "--check"],
            capture_output=True, text=True, timeout=240,
        )
    except Exception as exc:  # noqa: BLE001
        say(False, "chromium launch", repr(exc))
        return False
    output = ((result.stdout or "") + (result.stderr or "")).strip().splitlines()
    tail = output[-1] if output else "no output"
    say(result.returncode == 0, "chromium launch", tail[:200])
    return result.returncode == 0


def check_dns() -> None:
    for host in (
        "deb.debian.org",
        "www.scribd.com",
        "html.scribdassets.com",
        "imgv2-1.scribdassets.com",
        "html.duckduckgo.com",
    ):
        try:
            socket.getaddrinfo(host, 443)
            say(True, f"dns {host}")
        except Exception as exc:  # noqa: BLE001
            say(False, f"dns {host}", repr(exc))


def check_mirror() -> bool:
    for url in ("https://deb.debian.org/debian/", "http://deb.debian.org/debian/"):
        try:
            status, _, body = fetch(url, timeout=20)
            ok = status == 200 and len(body) > 500
            say(ok, "egress deb.debian.org", f"HTTP {status}, {len(body)} bytes")
            return ok
        except Exception as exc:  # noqa: BLE001
            say(False, "egress deb.debian.org", f"{url} → {exc!r}")
    return False


def check_scribd_page() -> None:
    """Was the empty search page a wall or just the JS shell?"""
    url = "https://www.scribd.com/search?query=" + urllib.parse.quote_plus("excel and succeed")
    try:
        status, _, body = fetch(url, timeout=25)
    except urllib.error.HTTPError as exc:
        say(False, "scribd /search", f"HTTP {exc.code}")
        dump("search", exc.read())
        return
    except Exception as exc:  # noqa: BLE001
        say(False, "scribd /search", repr(exc))
        return
    info = classify(body)
    dump("search", body)
    say(not info["challenge"], "scribd /search",
        f"HTTP {status}, {len(body) // 1024} KiB, challenge={info['challenge']} "
        "(0 result links is normal — JS shell)")


SEARCH_ENGINES = (
    ("ddg-html", "https://html.duckduckgo.com/html/?q={query}"),
    ("ddg-lite", "https://lite.duckduckgo.com/lite/?q={query}"),
    ("bing", "https://www.bing.com/search?q={query}&count=20"),
)


def check_search(query: str = "excel and succeed") -> str:
    """Can a keyword become document URLs without a browser? Returns the first."""
    encoded = urllib.parse.quote_plus(f"site:scribd.com {query}")
    first_doc = ""
    for name, template in SEARCH_ENGINES:
        try:
            status, _, body = fetch(template.format(query=encoded), timeout=25)
        except Exception as exc:  # noqa: BLE001
            say(False, f"search {name}", repr(exc))
            continue
        text = urllib.parse.unquote(body.decode("utf-8", "replace"))
        docs = re.findall(r"https?://(?:www\.)?scribd\.com/(?:document|presentation|"
                          r"spreadsheet|ebook)/\d+", text)
        note = ", page looks challenged" if classify(body)["challenge"] else ""
        say(status == 200 and bool(docs), f"search {name}",
            f"HTTP {status}, {len(set(docs))} doc link(s){note}")
        if docs and not first_doc:
            first_doc = docs[0]
    return first_doc


def _asset_counts(body: bytes) -> tuple[int, int]:
    pages = re.findall(rb"https?://[^\s\"'<>]+/pages/\d+-[0-9a-f]+\.jsonp", body or b"")
    images = re.findall(
        rb"https?://[^\s\"'<>]+/(?:images|screenshots)/[^\s\"'<>]+\.(?:jpe?g|png)", body or b""
    )
    return len(set(pages)), len(set(images))


def check_doc_chain(doc_url: str, cookies: dict | None, label: str) -> bool:
    """doc page → embed content → one page asset. The download, end to end."""
    try:
        status, _, body = fetch(doc_url, cookies=cookies)
    except urllib.error.HTTPError as exc:
        say(False, f"doc page ({label})", f"HTTP {exc.code} {exc.reason}")
        dump(f"doc-{label}", exc.read())
        return False
    except Exception as exc:  # noqa: BLE001
        say(False, f"doc page ({label})", repr(exc))
        return False

    info = classify(body)
    dump(f"doc-{label}", body)
    ok_page = status == 200 and info["content"] and not info["challenge"]
    say(ok_page, f"doc page ({label})",
        f"HTTP {status}, {len(body) // 1024} KiB, content={info['content']}, "
        f"challenge={info['challenge']}")
    if not ok_page:
        return False

    match = re.search(r"/document/(\d+)", doc_url)
    if not match:
        return ok_page
    embed = f"https://www.scribd.com/embeds/{match.group(1)}/content"
    try:
        status2, _, body2 = fetch(embed, cookies=cookies)
    except Exception as exc:  # noqa: BLE001
        say(False, f"embed content ({label})", repr(exc))
        return False
    dump(f"embed-{label}", body2)
    pages, images = _asset_counts(body2)
    challenged = classify(body2)["challenge"]
    ok_embed = status2 == 200 and not challenged and bool(pages or images)
    say(ok_embed, f"embed content ({label})",
        f"HTTP {status2}, jsonp={pages}, images={images}, challenge={challenged}")
    return ok_embed


# ---------------------------------------------------------------------------
# the run
# ---------------------------------------------------------------------------
def enabled() -> bool:
    return os.environ.get("SCRIBD_DIAG", "").strip().lower() in ("1", "true", "yes", "on")


def run_diag(force: bool = False) -> int:
    if not force and not enabled():
        return 0

    print("\n==== panel diagnostic ====", flush=True)
    suite = check_libc()
    print(f"       sysroot suite: {suite}", flush=True)
    chromium_ok = check_chromium_ldd()
    if chromium_ok:
        check_chromium_launch()
    check_dns()
    check_mirror()
    check_scribd_page()
    query = os.environ.get("SCRIBD_DIAG_QUERY", "").strip() or "excel and succeed"
    doc = os.environ.get("SCRIBD_DIAG_DOC", "").strip() or check_search(query)
    cookies = load_cookies(os.environ.get("SCRIBD_DIAG_COOKIES", "").strip())
    print(f"       cookies loaded: {len(cookies)} (values hidden)", flush=True)

    if not doc:
        say(False, "scribd doc chain", "no document URL — set SCRIBD_DIAG_DOC or fix search")
    else:
        say(True, "doc under test", doc)
        check_doc_chain(doc, None, "anon")
        if cookies:
            check_doc_chain(doc, cookies, "cookies")
        else:
            say(False, "doc chain with cookies", "SCRIBD_DIAG_COOKIES not set or file missing")

    print("==== end diagnostic ====", flush=True)
    print(
        "verdict: Chromium usable = %s\n"
        "  every line PASS              -> the panel is a complete downloader\n"
        "  chromium lines FAIL          -> HTTP route only (SCRIBD_WEB_BROWSER=off)\n"
        "  doc page FAIL, challenge=True -> the container's IP is walled; download elsewhere\n"
        "  doc page FAIL, URLError/HTTP  -> the container cannot reach Scribd at all\n"
        "  bodies that decided each FAIL are in .debug/diag-*.html"
        % ("yes" if chromium_ok else "no"),
        flush=True,
    )
    return 0


def selftest() -> int:
    assert not classify(b"<html>empty search shell</html>")["challenge"]
    assert classify(b"<title>Just a moment...</title>")["challenge"]
    assert classify(b"Please Enable JavaScript and cookies to continue")["challenge"]
    assert classify(b'window.docManager={"page_count":12}')["content"]
    assert not classify(b"<html>empty shell</html>")["content"]
    pages, images = _asset_counts(
        b'x https://h.scr/p/pages/3-9af1c2.jsonp y https://i.scr/screenshots/a/4.jpeg z'
    )
    assert pages == 1 and images == 1, (pages, images)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
        handle.write(
            "# Netscape HTTP Cookie File\n"
            "#HttpOnly_.scribd.com\tTRUE\t/\tTRUE\t0\tsid\tabc123\n"
        )
        path = handle.name
    try:
        assert load_cookies(path) == {"sid": "abc123"}
    finally:
        os.unlink(path)
    print("selftest: 8/8 ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(selftest() if "selftest" in sys.argv[1:] else run_diag(force=True))
