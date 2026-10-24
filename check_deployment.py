#!/usr/bin/env python3
"""check_deployment.py — one file, no installs, no repository imports.

Drop this single file on the server and it answers, with evidence, the only
question that matters before you bother deploying anything:

    can THIS machine fetch a Scribd document and print it?

It checks, in about a minute:

    python          version, 64-bit, writable working directory, free disk
    libc            glibc version (or musl, which makes Chromium impossible)
    chromium        is the binary here, do all its .so files resolve, does it
                    actually launch, and does it really write a PDF
    network         scribd.com, the oEmbed endpoint, DuckDuckGo, Bing,
                    deb.debian.org (only matters for self-repair)
    cookies         how many are loaded, is a session cookie among them
                    (counts only — a cookie value is never printed)
    document        anonymous vs cookie request to the document page

Then it prints one of: YES / PARTLY / NO, and the next three steps.

Usage
-----
    python check_deployment.py                  # print the report, exit
    python check_deployment.py --serve          # also answer on a port
    python check_deployment.py --json           # machine-readable

    # On a panel with no shell (Pterodactyl etc.): set the startup file to
    # check_deployment.py, restart, then open the server URL. With
    # SERVER_PORT / PORT set it serves automatically:
    SERVER_PORT=25811 python check_deployment.py

    # A specific document, and a cookies file somewhere else:
    python check_deployment.py --doc https://www.scribd.com/document/123456
    python check_deployment.py --cookies /home/container/cookies.txt

Nothing here installs a package, writes to the repository, or prints a cookie
value. Files it writes: .debug/deployment-check.{html,txt}
"""
from __future__ import annotations

import glob
import html
import json
import os
import platform
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0"
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
    b"are you a robot",
)
CONTENT = (b"docManager", b"page_count", b"document_detail", b"outer_page")
SESSION_NAMES = ("_scribd_session", "scribd_session", "scribd_session_id", "sessionid")
DEFAULT_DOC = "https://www.scribd.com/document/751945245"  # public sample
OUT_DIR = ".debug"

PASS, FAIL, WARN, INFO = "PASS", "FAIL", "WARN", "INFO"


# ---------------------------------------------------------------------------
# report model
# ---------------------------------------------------------------------------
class Report:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.lines: list[dict] = []
        self.started = time.time()
        self.finished = 0.0
        self.running = True
        self.verdict = ""
        self.next_steps: list[str] = []

    def add(self, level: str, label: str, detail: str = "") -> None:
        with self.lock:
            self.lines.append({"level": level, "label": label, "detail": detail})
        print(f"[{level:4}] {label}" + (f" — {detail}" if detail else ""), flush=True)

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "ok": self.running is False and self.verdict.startswith("YES"),
                "running": self.running,
                "verdict": self.verdict,
                "next_steps": list(self.next_steps),
                "lines": list(self.lines),
                "started": self.started,
                "finished": self.finished,
                "seconds": round((self.finished or time.time()) - self.started, 1),
                "host": socket.gethostname(),
                "python": platform.python_version(),
                "platform": platform.platform(),
                "version": VERSION,
            }

    def as_text(self) -> dict:
        snap = self.snapshot()
        out = [
            f"deployment check — {snap['host']} — python {snap['python']} — "
            f"{snap['seconds']}s",
            "",
        ]
        for line in snap["lines"]:
            out.append(f"[{line['level']:4}] {line['label']}"
                       + (f" — {line['detail']}" if line["detail"] else ""))
        out += ["", snap["verdict"] or "checks are still running", ""]
        out += [f"{i}. {step}" for i, step in enumerate(snap["next_steps"], 1)]
        return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def parse_netscape_cookies(text: str) -> tuple[dict[str, str], int]:
    """cookies.txt -> ({name: value}, expired_count). Values never printed."""
    jar: dict[str, str] = {}
    expired = 0
    now = time.time()
    for line in (text or "").splitlines():
        line = line.strip()
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 7:
            continue
        try:
            expiry = float(parts[4] or 0)
        except ValueError:
            expiry = 0.0
        if expiry and expiry < now:
            expired += 1
            continue
        jar[parts[5]] = parts[6]
    return jar, expired


def classify_html(body: bytes) -> dict[str, bool]:
    low = (body or b"").lower()
    raw = body or b""
    return {
        "challenge": any(marker in low for marker in CHALLENGE),
        "content": any(marker in raw for marker in CONTENT),
    }


def probe(url: str, cookies: dict[str, str] | None = None, data: bytes | None = None,
          timeout: float = 12.0) -> dict:
    """One HTTP request. Returns status/len/error and a bounded body."""
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    if cookies:
        request.add_header(
            "Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items())
        )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(400_000)
            return {"status": response.status, "len": len(body),
                    "url": response.geturl(), "body": body, "error": ""}
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read(200_000)
        except Exception:  # noqa: BLE001
            body = b""
        return {"status": exc.code, "len": len(body), "url": url,
                "body": body, "error": ""}
    except Exception as exc:  # noqa: BLE001  (URLError, timeout, SSL, DNS)
        return {"status": 0, "len": 0, "url": url, "body": b"", "error": repr(exc)}


def libc_version() -> tuple[str, tuple[int, int]]:
    """('glibc', (2, 36)) / ('musl', (0, 0)) / ('unknown', (0, 0))."""
    musl = glob.glob("/lib/ld-musl-*.so.1") + glob.glob("/usr/lib/ld-musl-*.so.1")
    if musl:
        return "musl", (0, 0)
    try:
        name, version = platform.libc_ver()
        match = re.search(r"(\d+)\.(\d+)", version or "")
        if name == "glibc" and match:
            return "glibc", (int(match.group(1)), int(match.group(2)))
    except Exception:  # noqa: BLE001
        pass
    try:
        result = subprocess.run(["ldd", "--version"], capture_output=True,
                                text=True, timeout=15)
        text = (result.stdout or "") + (result.stderr or "")
        if "musl" in text.lower():
            return "musl", (0, 0)
        match = re.search(r"(\d+)\.(\d+)", text)
        if match:
            return "glibc", (int(match.group(1)), int(match.group(2)))
    except Exception:  # noqa: BLE001
        pass
    return "unknown", (0, 0)


def find_browsers() -> list[str]:
    found: list[str] = []
    for key in ("SCRIBD_CHROMIUM", "CHROME_PATH", "CHROMIUM_PATH"):
        value = os.environ.get(key, "").strip()
        if value and os.path.exists(value):
            found.append(value)
    for name in ("chromium", "chromium-browser", "google-chrome",
                 "google-chrome-stable", "chrome", "headless_shell"):
        path = shutil.which(name)
        if path:
            found.append(path)
    roots = [
        os.environ.get("PLAYWRIGHT_BROWSERS_PATH", ""),
        os.path.expanduser("~/.cache/ms-playwright"),
        os.path.join(".", ".cache", "ms-playwright"),
        os.path.join(os.environ.get("SCRIBD_WEB_DATA", "webdata"), "ms-playwright"),
        os.path.expanduser("~/.cache/puppeteer"),
    ]
    for root in [r for r in roots if r]:
        for pattern in ("**/chrome", "**/chrome-headless-shell", "**/headless_shell"):
            found += glob.glob(os.path.join(root, pattern), recursive=True)
    return sorted({os.path.realpath(p) for p in found if os.path.isfile(p)})


def run_chrome(binary: str, args: list[str], timeout: float = 60.0) -> dict:
    command = [binary, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
               "--disable-extensions", "--no-first-run", *args]
    env = dict(os.environ)
    env.setdefault("HOME", tempfile.gettempdir())
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                timeout=timeout, env=env)
        return {"code": result.returncode, "out": result.stdout or "",
                "err": result.stderr or ""}
    except subprocess.TimeoutExpired:
        return {"code": -1, "out": "", "err": "timed out"}
    except Exception as exc:  # noqa: BLE001
        return {"code": -1, "out": "", "err": repr(exc)}


def writable_dir(path: str = OUT_DIR) -> bool:
    try:
        os.makedirs(path, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(dir=path, delete=True)
        handle.write(b"x")
        handle.close()
        return True
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------
def check_host(report: Report) -> None:
    version = sys.version_info
    report.add(PASS if version >= (3, 9) else FAIL, "python",
               f"{platform.python_version()} on {platform.machine()} "
               f"({platform.platform()[:60]})"
               + ("" if version >= (3, 9) else " — 3.9+ needed"))
    report.add(PASS if version <= (3, 13) else WARN, "python version",
               "supported" if version <= (3, 13)
               else "very new — if a package fails to install, use 3.11 or 3.12")
    if writable_dir():
        report.add(PASS, "working directory", f"{os.getcwd()} is writable")
    else:
        report.add(FAIL, "working directory", f"{os.getcwd()} is not writable")
    try:
        usage = shutil.disk_usage(os.getcwd())
        free = usage.free / 1_000_000
        report.add(PASS if free >= 200 else WARN, "free disk",
                   f"{free:,.0f} MB free" + ("" if free >= 200 else " — tight"))
    except Exception as exc:  # noqa: BLE001
        report.add(INFO, "free disk", f"unknown ({exc!r})")

    kind, version_pair = libc_version()
    if kind == "glibc":
        if version_pair >= (2, 41):
            suite = "trixie"
        elif version_pair >= (2, 36):
            suite = "bookworm"
        else:
            suite = "bullseye"
        report.add(PASS, "libc",
                   f"glibc {version_pair[0]}.{version_pair[1]} — "
                   f"Chromium's missing .so files can be pulled from '{suite}'")
    elif kind == "musl":
        report.add(FAIL, "libc",
                   "musl/Alpine — Debian Chromium binaries can never run here; "
                   "use the HTTP route or GitHub Actions")
    else:
        report.add(WARN, "libc", "unrecognised — proceed, and read the chromium lines")


def check_browser(report: Report) -> tuple[bool, bool]:
    """Returns (chromium_runs, chromium_prints_pdf)."""
    binaries = find_browsers()
    if not binaries:
        report.add(FAIL, "chromium binary",
                   "none found — playwright install chromium, or use the HTTP route")
        return False, False
    binary = binaries[0]
    report.add(PASS, "chromium binary", binary)
    if len(binaries) > 1:
        report.add(INFO, "chromium candidates", ", ".join(binaries[:4]))

    missing: list[str] = []
    try:
        result = subprocess.run(["ldd", binary], capture_output=True,
                                text=True, timeout=60)
        missing = sorted(set(re.findall(r"(\S+)\s+=>\s+not found", result.stdout)))
    except Exception as exc:  # noqa: BLE001
        report.add(WARN, "ldd", f"could not run ldd ({exc!r})")
    if missing:
        report.add(FAIL, "shared libraries",
                   f"{len(missing)} missing: " + ", ".join(missing[:6])
                   + (" …" if len(missing) > 6 else ""))
    else:
        report.add(PASS, "shared libraries", "every .so resolves")

    version = run_chrome(binary, ["--version"], timeout=45)
    text = (version["out"] + version["err"]).strip().splitlines()
    glibc_error = re.search(r"GLIBC_(\d+\.\d+)'? not found", version["out"] + version["err"])
    if version["code"] == 0 and text:
        report.add(PASS, "chromium --version", text[0][:100])
    elif "GLIBC_" in (version["out"] + version["err"]):
        report.add(FAIL, "chromium --version",
                   f"needs GLIBC_{glibc_error.group(1) if glibc_error else '?'}; "
                   "this image is too old for that build")
    else:
        report.add(FAIL, "chromium --version",
                   f"exit {version['code']}: {(text or ['no output'])[0][:120]}")

    with tempfile.TemporaryDirectory() as work:
        probe_html = os.path.join(work, "probe.html")
        with open(probe_html, "w", encoding="utf-8") as handle:
            handle.write("<html><body><h1>probe-ok-12345</h1></body></html>")
        url = "file://" + probe_html
        profile = os.path.join(work, "profile")
        common = [f"--user-data-dir={profile}", "--hide-scrollbars"]
        launched = run_chrome(binary, [*common, "--headless=new", "--dump-dom", url])
        if "probe-ok-12345" not in launched["out"]:
            launched = run_chrome(binary, [*common, "--headless", "--dump-dom", url])
        runs = "probe-ok-12345" in launched["out"]
        if runs:
            report.add(PASS, "chromium launch", "headless page rendered")
        else:
            detail = (launched["err"] or launched["out"] or "no output").strip()
            report.add(FAIL, "chromium launch", detail.splitlines()[-1][:150])

        pdf = os.path.join(work, "probe.pdf")
        printed = run_chrome(binary, [
            *common, "--headless=new", "--no-pdf-header-footer",
            "--run-all-compositor-stages-before-draw", "--virtual-time-budget=3000",
            f"--print-to-pdf={pdf}", url,
        ]) if runs else {"code": -1, "out": "", "err": "skipped: browser did not launch"}
        size, header = 0, b""
        if os.path.exists(pdf):
            size = os.path.getsize(pdf)
            with open(pdf, "rb") as handle:
                header = handle.read(5)
        prints_pdf = header == b"%PDF-" and size > 800
        if prints_pdf:
            report.add(PASS, "PDF printing", f"wrote a {size:,} byte PDF")
        elif runs:
            report.add(FAIL, "PDF printing",
                       f"no usable PDF (exit {printed['code']}, {size} bytes)")
        else:
            report.add(FAIL, "PDF printing", "cannot be tested without a browser")
    return runs, prints_pdf


def check_network(report: Report, doc_url: str) -> tuple[bool, bool, bool]:
    """Returns (scribd_reachable, scribd_walled, search_works)."""
    root = probe("https://www.scribd.com/")
    if root["error"]:
        report.add(FAIL, "scribd.com", root["error"][:140])
        reachable = False
    else:
        reachable = True
        report.add(PASS if root["status"] < 400 else WARN, "scribd.com",
                   f"HTTP {root['status']}, {root['len']:,} bytes")

    walled = False
    if reachable:
        doc = probe(doc_url)
        if doc["error"]:
            report.add(WARN, "document page (anonymous)", doc["error"][:120])
        else:
            flags = classify_html(doc["body"])
            walled = flags["challenge"]
            note = "challenge page" if flags["challenge"] else (
                "document markers found" if flags["content"] else "no markers")
            report.add(WARN if flags["challenge"] else PASS,
                       "document page (anonymous)",
                       f"HTTP {doc['status']}, {doc['len']:,} bytes, {note}")

    doc_id = doc_id_of(doc_url)
    if not reachable:
        report.add(INFO, "oEmbed endpoint",
                   "not tested — no route to scribd.com from this machine")
    if reachable and doc_id:
        query = urllib.parse.quote(f"https://www.scribd.com/document/{doc_id}", safe="")
        oembed = probe(f"https://www.scribd.com/services/oembed?url={query}&format=json",
                       timeout=15)
        if oembed["error"]:
            report.add(WARN, "oEmbed endpoint", oembed["error"][:120])
        else:
            title = author = ""
            try:
                payload = json.loads(oembed["body"] or b"{}")
                title = str(payload.get("title", ""))[:60]
                author = str(payload.get("author_name", ""))[:40]
            except Exception:  # noqa: BLE001
                payload = {}
            if title:
                report.add(PASS, "oEmbed endpoint",
                           f"HTTP {oembed['status']} — '{title}'"
                           + (f" by {author}" if author else ""))
            else:
                report.add(PASS, "oEmbed endpoint",
                           f"HTTP {oembed['status']} — endpoint answers "
                           "(no public metadata for this id)")

    search = False
    ddg = probe("https://html.duckduckgo.com/html/",
                data=urllib.parse.urlencode({"q": "site:scribd.com exceL"}).encode())
    if not ddg["error"] and b"scribd.com" in (ddg["body"] or b"").lower():
        search = True
        report.add(PASS, "search (DuckDuckGo)", f"HTTP {ddg['status']}, results contain scribd.com")
    else:
        reason = ddg["error"] or f"HTTP {ddg['status']}, no scribd.com links"
        report.add(WARN, "search (DuckDuckGo)", reason[:120])
        bing = probe("https://www.bing.com/search?q=site%3Ascribd.com+exceL&count=20")
        if not bing["error"] and b"scribd.com" in (bing["body"] or b"").lower():
            search = True
            report.add(PASS, "search (Bing)", f"HTTP {bing['status']}, results contain scribd.com")
        else:
            report.add(WARN, "search (Bing)",
                       (bing["error"] or f"HTTP {bing['status']}, no scribd.com links")[:120])

    mirror = probe("https://deb.debian.org/debian/", timeout=12)
    if mirror["error"]:
        report.add(INFO, "deb.debian.org",
                   "unreachable — missing Chromium libraries cannot be repaired in-job")
    else:
        report.add(INFO, "deb.debian.org", f"HTTP {mirror['status']} — in-job repair possible")
    return reachable, walled, search


def check_cookies(report: Report, explicit: str, doc_url: str) -> tuple[bool, bool]:
    """Returns (cookies_loaded, session_seen)."""
    candidates = [
        explicit,
        os.environ.get("SCRIBD_DIAG_COOKIES", ""),
        os.environ.get("SCRIBD_WEB_COOKIES", ""),
        os.environ.get("SCRIBD_COOKIES", ""),
        os.path.join(os.getcwd(), "cookies.txt"),
        "/home/container/cookies.txt",
    ]
    path = next((p for p in candidates if p and os.path.isfile(p)), "")
    if not path:
        report.add(WARN, "cookies file",
                   "none found — anonymous requests only (many documents need a session)")
        return False, False
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            jar, expired = parse_netscape_cookies(handle.read())
    except OSError as exc:
        report.add(FAIL, "cookies file", f"{path} — {exc!r}")
        return False, False
    session = [name for name in jar if name.lower() in SESSION_NAMES]
    if not jar:
        report.add(FAIL, "cookies file", f"{path} — 0 usable cookies")
        return False, False
    report.add(PASS if session else WARN, "cookies file",
               f"{path} — {len(jar)} cookies"
               + (f", {expired} expired" if expired else "")
               + (f", session cookie '{session[0]}' present" if session else
                  ", no session cookie — may be logged out"))

    if doc_url and session:
        doc = probe(doc_url, cookies=jar)
        if doc["error"]:
            report.add(WARN, "document page (with cookies)", doc["error"][:120])
        else:
            flags = classify_html(doc["body"])
            report.add(WARN if flags["challenge"] else PASS,
                       "document page (with cookies)",
                       f"HTTP {doc['status']}, {doc['len']:,} bytes, "
                       + ("challenge page" if flags["challenge"]
                          else "document markers found" if flags["content"]
                          else "no markers"))
    return True, bool(session)


def check_code(report: Report) -> bool:
    present = os.path.isfile("bot.py") and os.path.isdir("scribd")
    report.add(INFO, "project files",
               "bot.py + scribd/ present here" if present
               else "not in this directory — standalone test only, nothing to install")
    missing = []
    for module in ("playwright", "flask", "httpx", "curl_cffi", "bs4", "pypdf"):
        try:
            __import__(module)
        except Exception:  # noqa: BLE001
            missing.append(module)
    if missing:
        report.add(INFO, "python packages",
                   "not installed: " + ", ".join(missing)
                   + " (normal before the zip; the test file needs none of them)")
    else:
        report.add(INFO, "python packages", "all of playwright, flask, httpx, curl_cffi, bs4, pypdf")
    return present


def doc_id_of(url: str) -> str:
    match = re.search(r"/(?:doc|document|embeds|presentation)/(\d+)", url or "")
    if match:
        return match.group(1)
    return url.strip() if (url or "").strip().isdigit() else ""


# ---------------------------------------------------------------------------
# the run
# ---------------------------------------------------------------------------
def run_checks(report: Report, doc_url: str, cookies: str) -> None:
    report.running = True
    report.lines = []
    report.started = time.time()
    print("", flush=True)
    print(f"deployment check {VERSION} — {platform.python_version()} — {os.getcwd()}",
          flush=True)
    print("-" * 72, flush=True)
    try:
        check_host(report)
        runs, prints_pdf = check_browser(report)
        reachable, walled, search = check_network(report, doc_url)
        loaded, session = check_cookies(report, cookies, doc_url)
        present = check_code(report)
    except Exception as exc:  # noqa: BLE001
        report.add(FAIL, "check crashed", repr(exc)[:200])
        runs = prints_pdf = reachable = walled = search = loaded = present = False

    browser_ok = runs and prints_pdf
    if browser_ok and reachable and not walled:
        verdict = ("YES — this machine can download and print the document itself, "
                   "one book page per sheet.")
        steps = [
            "Deploy the zip here as before (PY_FILE=bot.py, SCRIBD_WEB_BROWSER=auto).",
            "Put cookies.txt in the project root — the file you already have.",
            "Open the web UI, paste a Scribd URL, choose PDF, press Download.",
        ]
    elif browser_ok and reachable and walled:
        verdict = ("PARTLY — the browser works, but Scribd shows this IP a challenge "
                   "page. Logged-in cookies may still get through; if not, the job "
                   "belongs on GitHub Actions.")
        steps = [
            "Deploy as usual and try one document with your cookies loaded.",
            "If every document stops at 'challenge', run the workflow in GitHub "
            "Actions instead (server-side IP, no Chrome on this box).",
            "Keep the HTTP route (SCRIBD_WEB_BROWSER=off) for search only.",
        ]
    elif reachable:
        verdict = ("PARTLY — it can reach Scribd, but it cannot run Chromium here, so "
                   "no one-page-per-sheet PDF. The HTTP route and metadata work; "
                   "printing needs GitHub Actions."
                   + (" Scribd also shows this IP a challenge page, so even the HTTP "
                      "route may be limited." if walled else "")
                   + (" Search engines are blocked from this IP as well, so searches "
                      "must run elsewhere too." if not search else ""))
        steps = [
            "Deploy without the browser: SCRIBD_WEB_BROWSER=off in .env.",
            "Use search + --pick here; the files it can fetch arrive as page images.",
            f"Install a browser here only if the host allows it "
            f"({'playwright install chromium' if not present else 'see the chromium lines'}), "
            "otherwise run the Actions workflow.",
        ]
    else:
        verdict = ("NO — this machine cannot reach scribd.com, so nothing here will "
                   "download. Move the job to GitHub Actions.")
        steps = [
            "Do not deploy the zip on this host for downloading.",
            "Run the workflow in GitHub Actions (works from any IP, no local browser).",
            "Download the artifact zip and open the PDFs.",
        ]
    if not loaded:
        steps = steps[:2] + ["Add cookies.txt — without a session most documents "
                             "return the login page instead of pages."]
    report.verdict = verdict
    report.next_steps = steps
    report.finished = time.time()
    report.running = False

    print("-" * 72, flush=True)
    print(verdict, flush=True)
    for index, step in enumerate(steps, 1):
        print(f"  {index}. {step}", flush=True)
    print("", flush=True)
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(os.path.join(OUT_DIR, "deployment-check.txt"), "w",
                  encoding="utf-8") as handle:
            handle.write(report.as_text())
        with open(os.path.join(OUT_DIR, "deployment-check.html"), "w",
                  encoding="utf-8") as handle:
            handle.write(render_html(report.snapshot()))
        print(f"saved: {OUT_DIR}/deployment-check.txt and .html", flush=True)
    except OSError:
        pass


COLOURS = {PASS: "#1a7f37", FAIL: "#b42318", WARN: "#9a6700", INFO: "#57606a"}


def render_html(snap: dict) -> str:
    rows = []
    for line in snap["lines"]:
        colour = COLOURS.get(line["level"], "#57606a")
        rows.append(
            f'<tr><td class="lv" style="color:{colour}">{line["level"]}</td>'
            f'<td class="lb">{html.escape(line["label"])}</td>'
            f'<td class="dt">{html.escape(line["detail"])}</td></tr>'
        )
    steps = "".join(f"<li>{html.escape(step)}</li>" for step in snap["next_steps"])
    status = ("checks are running — this page refreshes itself"
              if snap["running"] else f"finished in {snap['seconds']}s")
    verdict = html.escape(snap["verdict"] or "checking…")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
{'<meta http-equiv="refresh" content="5">' if snap['running'] else ''}
<title>deployment check</title>
<style>
 body{{font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:#fbfbfa;color:#1f2328;margin:0;padding:28px 20px 60px}}
 .wrap{{max-width:1000px;margin:0 auto}}
 h1{{font-size:19px;margin:0 0 4px}}
 .meta{{color:#57606a;font-size:13px;margin-bottom:20px}}
 .verdict{{background:#fff;border:1px solid #d0d7de;border-left:5px solid
  {'#1a7f37' if snap['verdict'].startswith('YES') else '#b42318' if snap['verdict'].startswith('NO') else '#9a6700' if snap['verdict'] else '#d0d7de'};
  padding:14px 16px;margin:0 0 18px;font-size:16px;white-space:pre-wrap}}
 table{{border-collapse:collapse;width:100%;background:#fff;border:1px solid #d0d7de}}
 td{{padding:7px 10px;border-top:1px solid #eaeef2;vertical-align:top;font-size:13px}}
 tr:first-child td{{border-top:0}}
 .lv{{width:52px;font-weight:700}}
 .lb{{width:230px;font-weight:600}}
 .dt{{color:#3d444d;white-space:pre-wrap;word-break:break-word}}
 ol{{background:#fff;border:1px solid #d0d7de;padding:14px 16px 14px 34px;margin:20px 0 0}}
 ol li{{margin:5px 0}}
 a{{color:#0969da}}
</style></head><body><div class="wrap">
<h1>Can this deployment do the job?</h1>
<div class="meta">{html.escape(snap['host'])} · python {snap['python']} ·
 {html.escape(snap['platform'][:70])} · {status} ·
 <a href="/run">run again</a> · <a href="/json">json</a></div>
<div class="verdict">{verdict}</div>
<table>{''.join(rows)}</table>
<ol>{steps}</ol>
</div></body></html>"""


def serve(report: Report, port: int, doc_url: str, cookies: str) -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:  # quiet
            pass

        def _send(self, body: bytes, ctype: str, code: int = 200) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            path = urllib.parse.urlparse(self.path).path
            if path == "/json":
                self._send(json.dumps(report.snapshot(), indent=2).encode(),
                           "application/json; charset=utf-8")
            elif path == "/run":
                if not report.running:
                    threading.Thread(target=run_checks,
                                     args=(report, doc_url, cookies),
                                     daemon=True).start()
                self._send(render_html(report.snapshot()).encode(),
                           "text/html; charset=utf-8")
            elif path == "/health":
                self._send(b"ok", "text/plain")
            else:
                self._send(render_html(report.snapshot()).encode(),
                           "text/html; charset=utf-8")

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"report: http://0.0.0.0:{port}/  (this process stays up; press Ctrl-C)",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        server.server_close()


def main(argv: list[str]) -> int:
    doc_url = DEFAULT_DOC
    cookies_path = ""
    as_json = False
    want_serve = False
    port = int(os.environ.get("SERVER_PORT") or os.environ.get("PORT") or 0)
    index = 1
    while index < len(argv):
        arg = argv[index]
        if arg == "--doc" and index + 1 < len(argv):
            doc_url = argv[index + 1]
            index += 2
            continue
        if arg == "--cookies" and index + 1 < len(argv):
            cookies_path = argv[index + 1]
            index += 2
            continue
        if arg == "--port" and index + 1 < len(argv):
            port = int(argv[index + 1])
            want_serve = True
            index += 2
            continue
        if arg in ("--json",):
            as_json = True
        elif arg in ("--serve",):
            want_serve = True
        elif arg in ("-h", "--help"):
            print(__doc__)
            return 0
        elif arg == "--selftest":
            print(selftest())
            return 0
        index += 1

    report = Report()
    if want_serve or port:
        threading.Thread(target=run_checks, args=(report, doc_url, cookies_path),
                         daemon=True).start()
        try:
            serve(report, port or 8000, doc_url, cookies_path)
        except OSError as exc:
            print(f"cannot listen on port {port}: {exc} — printing the report instead",
                  flush=True)
            while report.running:
                time.sleep(0.2)
            print(report.as_text(), flush=True)
        return 0

    run_checks(report, doc_url, cookies_path)
    if as_json:
        print(json.dumps(report.snapshot(), indent=2))
    return 0


def selftest() -> str:
    """Offline sanity check of the parsers — no network, no browser."""
    jar, expired = parse_netscape_cookies(
        "# Netscape HTTP Cookie File\n"
        ".scribd.com\tTRUE\t/\tFALSE\t0\t_scribd_session\tabc123\n"
        ".scribd.com\tTRUE\t/\tFALSE\t1\told\tnope\n"
        "#HttpOnly_.scribd.com\tTRUE\t/\tFALSE\t0\tsessionid\tzzz\n"
    )
    assert jar.get("_scribd_session") == "abc123", jar
    assert jar.get("sessionid") == "zzz", jar
    assert expired == 1, expired
    flags = classify_html(b"<html><title>Just a moment...</title></html>")
    assert flags == {"challenge": True, "content": False}, flags
    flags = classify_html(b"<script>window.docManager={page_count:12}</script>")
    assert flags == {"challenge": False, "content": True}, flags
    assert doc_id_of("https://www.scribd.com/document/751945245/2K-Data") == "751945245"
    assert doc_id_of("https://www.scribd.com/doc/42") == "42"
    assert doc_id_of("https://www.scribd.com/embeds/7/content") == "7"
    assert doc_id_of("nonsense") == ""
    assert render_html({"running": False, "verdict": "YES", "next_steps": ["a"],
                        "lines": [{"level": "PASS", "label": "l", "detail": "d"}],
                        "host": "h", "python": "3", "platform": "p", "seconds": 1.0,
                        "verdict_unused": ""}).startswith("<!doctype html>")
    return "selftest: 7/7 ok"


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(130)
