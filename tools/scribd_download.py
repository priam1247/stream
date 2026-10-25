#!/usr/bin/env python3
"""scribd_download.py — ONE file, standard library only.  Version 2.12

Turns Scribd documents into clean PDFs, one document page per sheet, with no
browser, no pip install and no repository.

    python scribd_download.py                        # serves the page (panel mode)
    python scribd_download.py --find "physics 12th"  # search Scribd, print the links
    python scribd_download.py --find "physics 12th" --pages 3
    python scribd_download.py --find "physics 12th" --pick 1,3
    python scribd_download.py --url LINK             # one document, all pages
    python scribd_download.py --url LINK --limit 5   # first 5 pages only
    python scribd_download.py --url LINK --probe 4   # every url and its answer
    python scribd_download.py --url LINK --text      # searchable text, not photos
    python scribd_download.py --links "LINK LINK"    # several documents
    python scribd_download.py --verify FILE.pdf      # check a finished PDF
    python scribd_download.py --selftest             # offline check of this file

Panel mode: set PY_FILE to this file, restart, open the server address. The page
has two ways in:

  1. FIND HERE. The panel asks Scribd's own search — the very request its search
     page makes, /search/query — and gets the documents back as JSON with their
     titles, page counts and links. Results are put in the order the words were
     typed, and a result that only shares a common word is marked "related".
     Tick what you want, or press "Tick all shown", then download. "Load more"
     asks for page 2, 3, … and the page can say "showing 80 of 1,234".
  2. SEND LINKS FROM YOUR BROWSER. A bookmarklet built from the address you
     opened the panel on: search Scribd in your own browser, click it, and every
     document link on the page is handed to /send.

Why the finding is done by Scribd and not by a search engine: the engines refuse
this address (this was measured — the old check_deployment.py printed "Search
engines are blocked from this IP as well"), and they refuse it whether the
request comes from the panel or from a browser on the same network. Scribd does
not refuse it: the panel already reads Scribd pages and scans to build the PDFs.
The old failure was asking Google/Bing/DuckDuckGo for `site:scribd.com`; this
asks Scribd directly, which is the same thing its own search box does. The one
honest caveat: /search/query is not a documented API — it is the endpoint the
site's own JavaScript calls. If Scribd changes it, the page says so in plain
words instead of pretending there are no results.

What 2.12 added: WIRING THIS PANEL INTO ANOTHER DASHBOARD
  The panel is a plain HTTP service, so another site can drive it without a line
  of browser automation. Four small things were missing for that to be clean:
  1. A KEY. This panel sits on a public address and can spend your Scribd
     session, so it can now be locked: set PANEL_KEY (or SCRIBD_PANEL_KEY) and
     every route except /health wants X-Panel-Key, ?key=…, or the cookie that
     opening ?key=… once sets. Unset means open, exactly as before.
  2. CORS, but never a wildcard: PANEL_ORIGIN=https://your-dashboard lists the
     origins allowed to call the JSON endpoints from a browser, and OPTIONS is
     answered. A server-side proxy needs none of this and is the better way.
  3. /health now answers JSON ({"ok", "version", "locked", "state"}) so a
     dashboard can show "panel online / locked" before it tries a job, and
     /files lists the finished PDFs — no side has to remember a file name.
  4. ?embed=1 hides the bookmarklet card and the wide margins, for showing the
     panel inside a frame. The bookmarklet itself now carries ?key= when the
     panel is locked, so "send links from your browser" still works.

What 2.11 fixed: "HTTP 200, 6 kB jpeg that is not a page scan" (a real run)
  A 323-page book came back with 108 pages lost, most of them not 403s but
  small pictures the tool refused to call pages. The line said nothing useful:
  not how big the picture was, not whether it had arrived whole.
  1. Every refusal now names what actually arrived — "a 60x80 jpeg, 430 B —
     below the 200 px floor for a page", "a 764x1031 jpeg, 6.2 kB, cut short
     (no end-of-image marker)" — and the bytes are kept in debug/rejected/ so
     the sentence can be checked instead of believed.
  2. A picture is only "cut short" if it has no end-of-image marker. That test
     did not exist; a transfer cut in half was embedded silently and showed as
     a grey band. Now it is asked for once more, then kept and counted.
  3. A complete, page-shaped picture smaller than a real scan is a PREVIEW, not
     a failure: some documents are only served at 96x130 under every name we
     know. Those pages now go into the PDF filled to the sheet, are left out of
     the median that decides the page size, and are counted in the verdict
     ("1 small preview"). A blank placeholder with an excuse helps nobody.
     Below 80 px it is still a smudge and still refused.
  4. The verifier knows the difference too: a 96x130 page is a legal sheet, a
     40x40 one is still a broken file.

What 2.10 added: REAL TEXT INSIDE THE PDF (--text, or the panel's checkbox)
  A Scribd page is a scan plus its words. The scan was always downloaded; the
  words were thrown away, so the PDF could be read but not searched or copied.
  1. Each page's words come from the page's own descriptor, the same
     <hash>/pages/<n>-<hash>.jsonp the downloader already knows how to read —
     it answers window.pageN_callback([...]) with that page's text as HTML.
  2. Descriptors were not always named in the HTML, so the name is DERIVED from
     the scan's: pages/2-90c206b2e6.jsonp sits beside images/2-90c206b2e6.jpg.
     Verified against a live 402-page document before writing a line of this.
  3. The text goes in invisibly (render mode 3) under the scan, wrapped to the
     sheet, in Helvetica WinAnsi: the page looks exactly as before, but search,
     select and copy work, and the file is accessible. If a line has no room it
     is dropped rather than printed over the picture.
  4. It is opt-in and honest about its cost: one extra request per page, cached
     beside the scan as NNNN.text, and the verdict says how many pages got words
     ("14 sheet(s), 0.10 MB, 14 page(s) with searchable text").
  5. Nothing is invented and nothing is bypassed: the words come from the same
     pages the downloader is already allowed to read, only the scan's pictures
     were being used before.

What 2.9 fixed in the DOWNLOADS (the "failed pages keep increasing" report)
  1. A 403 was treated as permanent: the first one failed the page and blacklisted
     that name for the whole job, while the gate only slowed by 3%. When Scribd
     throttles a long job it answers 403, so every page hit in that window was
     lost and the retries failed too (same dead names, same token).
  2. Now a 403 is read in context: ONE page refused while others arrive is a
     locked page (give up at once, no resting). THREE different pages refused in
     a row is throttling: rest the whole job for 4s, then 12s, then 30s, clear
     the blacklist and the dead list, slow the gate, and try that name again.
  3. Retry rounds re-read the document page and viewer first, so they get a new
     token and any names the first read missed. A retry with the same names is
     not a retry, it is the same request.
  4. If two retries recover nothing, the third is skipped instead of resting 20
     more seconds for nothing.
  5. The report says why: "why: 12 answer(s) 403" and whether that looks like a
     locked document or a throttled address.

Measured on the local mock (14 pages, refusals start after 5 scans for 6s):
old code -> PDF PARTIAL, 10 of 14 real. New code -> PDF BUILT, 14 of 14, in 30s.
One permanently locked page: 10.7s and an honest PARTIAL, with no resting.

What 2.4 fixed in the OUTPUT (2.3 is kept everywhere else)
  1. PDF BROKEN was the checker, not the file: image streams were counted inside
     the "is this a page" branch, so the count was always 0. They are counted as
     their own objects now.
  2. The page size is the MEDIAN page, not the commonest one. On a 402-page book
     2.3 took 772x68 (a strip) and then re-fetched 392 good pages against it.
     A size no scan could have is refused: 90 kB cannot be a 772x68 picture.
  3. The JPEG size reader validates every frame header and cross-checks it
     against the file size, instead of trusting the first marker it meets.
  4. Every sheet is the document's own page size and each scan is fitted to fill
     it, aspect preserved, nothing cropped, never blown up more than 2x.
     EXIF rotation is applied by the page matrix (lossless, no re-encode).
  5. Nothing re-fetches in bulk: if more than a fifth of the pages disagree on
     size, that is a mixed-size document and each sheet keeps its own size.

What 2.4 fixed in your COOKIES
  2.3 sent every cookie in the file to scribd.com (on one export: 46 scribd
  cookies plus 3794 cookies for 479 other sites). Now only scribd.com and
  scribdassets.com are sent, expired ones are dropped, and the log says how many
  were kept and how many other sites were left out. Values are never printed.

How a document is downloaded, plain HTTPS with your cookies:
  1. read the document page and the embed viewer
  2. collect the per-page names: scans already named in the HTML, and the
     per-page descriptor  <hash>/pages/<n>-<token>.jsonp
  3. fetch pages 1..N in parallel over keep-alive connections, cache every scan
     in ./downloads/cache/, then assemble the PDF in page order: JPEG goes in
     as-is, PNG as its own filtered stream (predictor 15, no pixel loop)
  4. read the finished PDF back and validate it before calling it done

A page that will not answer walks a short ladder: the name the document gave,
the same name without the token, then the page's own descriptor, which names the
real asset outright. Every url tried for a failed page is recorded.

Options: --find "TEXT", --pages N, --pick 1,3, --url LINK (repeatable), --links "TEXT",
         --limit N, --out DIR, --cookies PATH, --base URL, --jobs N (default 12),
         --text (put each page's words in the PDF, searchable and copyable),
         --refresh, --name TITLE, --no-check, --no-placeholder, --no-verify,
         --verify FILE, --probe N, --selftest

Panel options (environment, all optional):
  PANEL_KEY / SCRIBD_PANEL_KEY   lock the panel (X-Panel-Key, ?key=, or cookie)
  PANEL_ORIGIN                   comma-separated browser origins allowed by CORS
  SERVER_PORT / PORT             port to listen on

Endpoints, for a dashboard in front of this panel:
  GET  /health                   {"ok", "version", "locked", "state"} — no key
  GET  /status                   the running job: state, verdict, progress, log
  GET  /files                    {"files": [{name, bytes, when}]} newest first
  GET  /file[/NAME]              the finished PDF
  GET  /logs[/NAME]              the debug folder, as a page or a file
  POST /run                      {"urls"|"url"|"links", "limit", "text"}
  POST /find                     {"query", "page"} -> documents from Scribd

Cookies are read, never printed. Files stay on this machine.
"""

from __future__ import annotations

import base64
import datetime
import gzip
import hashlib
import hmac
import http.client
import json
import os
import re
import socket
import shutil
import struct
import sys
import threading
import time
import urllib.parse
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "2.15"
SAMPLE = "https://www.scribd.com/document/751945245"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
OUT = "downloads"
DOC_MARKERS = (b"docManager", b"page_count", b"document_detail", b"outer_page")
CHALLENGE = (b"just a moment", b"cf-chl", b"attention required")
IMAGE_RE = re.compile(
    r"https?://[^\s\"'\\<>]+/images/(\d+)-[0-9A-Za-z]+\.(?:jpe?g|png|webp)"
    r"(?:\?[^\s\"'\\<>]*)?", re.IGNORECASE)
JSONP_RE = re.compile(
    r"https?://[^\s\"'\\<>]+/pages/(\d+)-[0-9A-Za-z]+\.jsonp"
    r"(?:\?[^\s\"'\\<>]*)?", re.IGNORECASE)
ASSET_RE = re.compile(
    r"https?://[^\s\"'\\<>()]+?/(?:images|pages)/\d+-[0-9A-Za-z]+"
    r"\.(?:jpe?g|png|webp|jsonp|json)(?:\?[^\s\"'\\<>()]*)?", re.IGNORECASE)
SCAN_RE = re.compile(r"\.(?:jpe?g|png|webp)(?:\?|$)", re.IGNORECASE)
TOKEN_RE = re.compile(r"[?&]token=([A-Za-z0-9._\-%]+)", re.IGNORECASE)
RETRY_STATUS = (408, 425, 429, 500, 502, 503, 504)
HARD_THROTTLE = (429, 503)
# A 403 has two meanings and they need opposite answers: "this page is not for
# you" (nothing to do) and "you are going too fast" (wait, then it works). The
# only way to tell them apart is what the rest of the job is doing: one refusal
# on its own is a locked page, several in a row with nothing succeeding is a
# throttle. Three in a row rests the whole job, clears the blacklist and tries
# that name again.
REFUSALS_IN_A_ROW = 3
PAUSE_LADDER = (4.0, 12.0, 30.0)
# How long one document may spend resting and retrying before it is built with
# whatever arrived. A page Scribd will not serve is not worth ten minutes of a
# 100-page book: the placeholders are labelled, the PDF still lands.
RETRY_BUDGET = float(os.environ.get("SCRIBD_RETRY_BUDGET", "75"))
OTHER_HOSTS = ("html.scribd.com", "html2-f.scribdassets.com",
               "html3-f.scribdassets.com", "html4-f.scribdassets.com")
# This panel is reachable from the internet, so it can be given a key. Empty
# means open, exactly as before: nothing changes for anyone who does not set it.
PANEL_KEY = (os.environ.get("PANEL_KEY") or os.environ.get("SCRIBD_PANEL_KEY")
             or "").strip()
# Optional browser origins allowed to call the JSON endpoints directly, e.g.
# PANEL_ORIGIN=https://my-dashboard.vercel.app — a server-side proxy needs none.
PANEL_ORIGINS = [part.strip().rstrip("/") for part in
                 (os.environ.get("PANEL_ORIGIN") or "").split(",") if part.strip()]
PANEL_COOKIE = "scribd_panel_key"

# a page scan is never smaller than this, and never this lopsided
MIN_PAGE_PX = 200
PREVIEW_MIN_PX = 80                # below this a picture is a smudge, not a page
ASPECT_RANGE = (0.4, 3.0)          # width / height
SIZE_TOLERANCE = 0.06              # 6% either way counts as the same page
MAX_REFETCH = 40                   # pages whose wrong size we will pay to redo

# ---------------------------------------------------------------------------
# http — keep-alive, so 400 page files do not mean 400 TLS handshakes
# ---------------------------------------------------------------------------
def find_cookies() -> str:
    for candidate in (os.environ.get("COOKIES", ""),
                      os.environ.get("SCRIBD_WEB_COOKIES", ""),
                      os.environ.get("SCRIBD_DIAG_COOKIES", ""),
                      "cookies.txt", "./cookies.txt",
                      "/home/container/cookies.txt"):
        if candidate and os.path.isfile(candidate):
            return candidate
    return ""

def read_cookie_lines(path: str) -> list[list[str]]:
    rows: list[list[str]] = []
    if not path or not os.path.isfile(path):
        return rows
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if line.startswith("#HttpOnly_"):
                    line = line[len("#HttpOnly_"):]
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) == 7:
                    rows.append(parts)
    except OSError:
        pass
    return rows

def scribd_only(path: str) -> dict[str, str]:
    """Only this site's cookies, and only the ones that are still alive.

    A browser export is usually for every site you use. Sending all of it to
    scribd.com would hand over logins that have nothing to do with this job, and
    can push the request header past what a CDN will accept. So: filter by
    domain, drop expired, keep the rest.
    """
    jar: dict[str, str] = {}
    for parts in read_cookie_lines(path):
        domain = parts[0].lstrip("#").lstrip(".").lower()
        if not (domain.endswith("scribd.com") or domain.endswith("scribdassets.com")):
            continue
        expires = parts[4]
        if expires.isdigit() and int(expires) and int(expires) < time.time():
            continue
        jar[parts[5]] = parts[6]
    return jar

def cookie_report(path: str) -> str:
    rows = read_cookie_lines(path)
    if not rows:
        return "no cookies loaded — anonymous"
    kept = scribd_only(path)
    domains = {parts[0].lstrip("#").lstrip(".").lower() for parts in rows}
    others = sorted(d for d in domains
                    if not (d.endswith("scribd.com") or d.endswith("scribdassets.com")))
    session = ([name for name in kept if name in ("_scribd_session", "scribd_session")]
               or [name for name in kept if "session" in name.lower()])
    text = (f"{len(kept)} scribd cookie(s)"
            + (f", session '{session[0]}'" if session else ", NO session"))
    if others:
        text += (f" · {len(rows) - len(kept)} cookie(s) for {len(others)} other "
                 f"site(s) NOT sent")
    return text

# kept for the old call sites and for tests
def load_cookies(path: str) -> dict[str, str]:
    return scribd_only(path)

def cookie_sentence(jar: dict[str, str]) -> str:
    if not jar:
        return "no cookies loaded — anonymous"
    session = [name for name in jar if "session" in name.lower()]
    return (f"{len(jar)} scribd cookie(s)"
            + (f", session '{session[0]}'" if session else ", NO session"))

BASE = os.environ.get("SCRIBD_BASE", "").rstrip("/")   # only for local tests
_POOL = threading.local()

def rebase(url: str) -> str:
    if not BASE:
        return url
    parsed = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit(
        (urllib.parse.urlsplit(BASE).scheme, urllib.parse.urlsplit(BASE).netloc,
         parsed.path, parsed.query, ""))

def _connection(scheme: str, netloc: str, timeout: float):
    pool = getattr(_POOL, "pool", None)
    if pool is None:
        pool = _POOL.pool = {}
    connection = pool.get((scheme, netloc))
    if connection is None:
        factory = (http.client.HTTPSConnection if scheme == "https"
                   else http.client.HTTPConnection)
        connection = factory(netloc, timeout=timeout)
        pool[(scheme, netloc)] = connection
    return connection

def _forget(scheme: str, netloc: str) -> None:
    pool = getattr(_POOL, "pool", None) or {}
    connection = pool.pop((scheme, netloc), None)
    if connection is not None:
        try:
            connection.close()
        except Exception:  # noqa: BLE001
            pass

def _decompress(raw: bytes, encoding: str) -> bytes:
    if encoding == "gzip":
        try:
            return gzip.decompress(raw)
        except OSError:
            return raw
    if encoding == "deflate":
        try:
            return zlib.decompress(raw)
        except zlib.error:
            try:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
            except zlib.error:
                return raw
    return raw

def fetch(url: str, jar: dict[str, str] | None = None, referer: str = "",
          timeout: float = 25.0) -> dict:
    target = rebase(url)
    headers = {"User-Agent": UA,
               "Accept": "text/html,application/xhtml+xml,application/json,"
                         "image/avif,image/webp,image/*,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9",
               "Accept-Encoding": "gzip, deflate"}
    if referer:
        headers["Referer"] = rebase(referer)
    if jar:
        headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in jar.items())
    for _hop in range(4):
        parsed = urllib.parse.urlsplit(target)
        scheme = parsed.scheme or "https"
        netloc = parsed.netloc
        path = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
        status = 0
        body = b""
        location = ""
        answer: dict = {}
        answered = False
        for attempt in (0, 1):
            connection = _connection(scheme, netloc, timeout)
            try:
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                status = response.status
                body = _decompress(response.read(),
                                   (response.getheader("Content-Encoding") or "").lower())
                location = response.getheader("Location") or ""
                answer = {k.lower(): v for k, v in response.getheaders()}
                answered = True
                break
            except Exception as exc:  # noqa: BLE001
                _forget(scheme, netloc)
                if attempt:
                    return {"status": 0, "body": b"", "headers": {},
                            "error": repr(exc)[:200]}
        if not answered:
            return {"status": 0, "body": b"", "headers": {}, "error": "no answer"}
        if status in (301, 302, 303, 307, 308) and location:
            target = urllib.parse.urljoin(target, location)
            continue
        return {"status": status, "body": body, "headers": answer, "error": ""}
    return {"status": 0, "body": b"", "headers": {}, "error": "too many redirects"}

def retry_after(headers: dict) -> float:
    value = (headers or {}).get("retry-after")
    if not value:
        return 0.0
    try:
        return min(20.0, max(0.0, float(value)))
    except ValueError:
        try:
            when = parsedate_to_datetime(value)
            if when.tzinfo is None:
                when = when.replace(tzinfo=datetime.timezone.utc)
            delta = (when - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
            return min(20.0, max(0.0, delta))
        except Exception:  # noqa: BLE001
            return 0.0

def http_reason(got: dict) -> str:
    """A short, honest description of a non-image answer."""
    body = got.get("body") or b""
    if body.startswith(b"<?xml") or b"<Error>" in body[:200]:
        code = re.search(rb"<Code>([^<]+)</Code>", body)
        label = code.group(1).decode("latin-1") if code else "xml error"
        return f"HTTP {got['status']} {label}"
    if body[:2] in (b"\xff\xd8", b"\x89P"):
        return f"HTTP {got['status']} short image"
    snippet = body[:50].decode("latin-1", "replace").strip()
    return f"HTTP {got['status']}, not an image ({snippet!r})"

def doc_id_of(url: str) -> str:
    match = re.search(r"/(?:doc|document|embeds|presentation)/(\d+)", url or "")
    if match:
        return match.group(1)
    return url.strip() if (url or "").strip().isdigit() else ""

def text_of(body) -> str:
    """Scribd writes urls inside JS as https:\\/\\/… — sometimes with one backslash,
    sometimes two, depending on how the string was nested. Strip them all.

    Accepts bytes or str: the search parsers hand it text they already decoded.
    """
    if isinstance(body, bytes):
        text = body.decode("utf-8", "replace")
    else:
        text = str(body or "")
    return re.sub(r"\\+/", "/", text.replace("&amp;", "&"))

def describe(body: bytes) -> str:
    if any(m in body for m in DOC_MARKERS):
        return "document content"
    if any(m in (body or b"").lower() for m in CHALLENGE):
        return "CHALLENGE page"
    return "no document markers"

# ---------------------------------------------------------------------------
# url helpers — no guessing, only the names the document gave
# ---------------------------------------------------------------------------
def image_url_for(jsonp_url: str) -> str:
    """The scan name that sits next to a descriptor name, under the same hash."""
    swapped = re.sub(r"/pages/(\d+-[0-9A-Za-z]+)\.jsonp(?:\?.*)?$",
                     r"/images/\1.jpg", jsonp_url, flags=re.IGNORECASE)
    return "" if swapped == jsonp_url else swapped

def jsonp_from_image(image_url: str) -> str:
    """The descriptor that sits beside an image, under the same hash.

    Measured against a live document: images/2-90c206b2e6.jpg and
    pages/2-90c206b2e6.jsonp are the same <page>-<hash> pair, and the jsonp is
    where that page's words are. So a document that names only its scans still
    gives up its text.
    """
    swapped = re.sub(r"/images/(\d+-[0-9A-Za-z]+)\.(?:jpe?g|png|webp)(?:\?.*)?$",
                     r"/pages/\1.jsonp", image_url, flags=re.IGNORECASE)
    return "" if swapped == image_url else swapped


def alternate_host(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    if not host:
        return ""
    other = OTHER_HOSTS[0] if "scribdassets" in host else "html.scribdassets.com"
    return urllib.parse.urlunsplit((parsed.scheme, other, parsed.path,
                                    parsed.query, ""))

# ---------------------------------------------------------------------------
# the token scribd puts on some page scans
# ---------------------------------------------------------------------------
def jwt_exp(token: str) -> int:
    parts = token.split(".")
    if len(parts) < 2:
        return 0
    try:
        raw = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        return int(json.loads(raw).get("exp") or 0)
    except Exception:  # noqa: BLE001
        return 0

def jwt_ok(token: str) -> bool:
    """Both leading segments must really decode to JSON.

    "navigator.userAgent.toLowerCase" has three dot-separated parts and passes
    any shape test; only the decode tells it apart from a real token.
    """
    parts = (token or "").split(".")
    if len(parts) != 3:
        return False
    try:
        for segment in parts[:2]:
            raw = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
            json.loads(raw.decode("utf-8", "replace"))
        return True
    except Exception:  # noqa: BLE001
        return False

def usable_token(value: str) -> bool:
    """A real token is a JWT, or a plain signed string with no dots.

    A dotted value that does not decode as a JWT is a JavaScript expression
    ("navigator.userAgent.toLowerCase") which the viewer writes into the url
    template. It is never a signature, so it is never sent.
    """
    value = urllib.parse.unquote((value or "").strip("\"'"))
    if not value or len(value) < 16:
        return False
    if jwt_ok(value):
        return True
    if "." in value:
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9_\-]+", value))

def token_score(token: str) -> tuple[int, int]:
    """(expiry, tier) — a real token always beats a placeholder."""
    if not token:
        return 0, 0
    if jwt_ok(token):
        return jwt_exp(token), 2
    if usable_token(token):
        return jwt_exp(token), 1
    return 0, 0

def harvest_token(body: bytes) -> str:
    """Find the scan token wherever it is written, and refuse the fake ones."""
    scored: list[tuple[tuple[int, int], str]] = []
    seen: set[str] = set()
    for variant in (text_of(body), urllib.parse.unquote(text_of(body))):
        for match in TOKEN_RE.finditer(variant):
            for candidate in (match.group(1), urllib.parse.unquote(match.group(1))):
                candidate = candidate.strip("\"'")
                if candidate in seen or not usable_token(candidate):
                    continue
                seen.add(candidate)
                scored.append((token_score(candidate), candidate))
    if not scored:
        return ""
    scored.sort(key=lambda row: row[0], reverse=True)
    return scored[0][1]

def with_token(url: str, token: str) -> str:
    """Put the real token on the url, replacing anything that is not one."""
    if not url:
        return url
    match = TOKEN_RE.search(url)
    if not match:
        if not usable_token(token):
            return url
        return url + ("&" if "?" in url else "?") + "token=" + token
    if usable_token(match.group(1)) or not usable_token(token):
        return url
    return url[:match.start(1)] + token + url[match.end(1):]

def strip_token(url: str) -> str:
    if not url:
        return url
    match = TOKEN_RE.search(url)
    if not match:
        return url
    separator = url[match.start():match.start() + 1]
    rest = url[match.end():]
    if not rest:
        return url[:match.start()]
    return url[:match.start()] + ("?" if separator == "?" else "&") + rest.lstrip("&")

def token_note(token: str) -> str:
    if not token:
        return ("image token: none on the page — trying without one (the viewer "
                "may build it in the browser)")
    if jwt_ok(token):
        left = (jwt_exp(token) - time.time()) / 3600
        if left > 0:
            return f"image token: found, valid for the next {left:.0f} h"
        return (f"image token: found but EXPIRED {abs(left):.0f} h ago — open the "
                "document while logged in, then reload it")
    return "image token: found (a plain token, not a JWT)"

class Token:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.value = ""

    def set(self, token: str) -> bool:
        if not usable_token(token):
            return False                      # a JS expression is never stored
        with self.lock:
            if token_score(token) >= token_score(self.value):
                changed = token != self.value
                self.value = token
                return changed
        return False

    def get(self) -> str:
        with self.lock:
            return self.value

# ---------------------------------------------------------------------------
# links: what a pasted list or a bookmarklet hands to us
# ---------------------------------------------------------------------------
# Nothing on this machine searches. Searching happens in your own browser, where
# the address is not blocked; only the links travel to the panel (see
# bookmarklet() and the /send endpoint). These two helpers are the receiving end.
LINK_IN_TEXT_RE = re.compile(
    r"https?://(?:[a-z0-9-]+\.)*scribd\.com/"
    r"(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)/"
    r"\d{3,}(?:/[^\s\"'<>]*)?", re.I)


def links_from_text(text: str) -> list[str]:
    """Document links out of a pasted block: one per line or all mixed together.

    Keeps the order you pasted, drops duplicates, ignores anything that is not a
    Scribd document link, and strips the query string (`?utm_…`, `#page=3`) which
    Scribd does not need and which makes two copies of one document look
    different.
    """
    urls: list[str] = []
    for match in LINK_IN_TEXT_RE.finditer(text or ""):
        url = match.group(0).split("?")[0].split("#")[0].rstrip(".,;)")
        if url not in urls:
            urls.append(url)
    return urls


def panel_gate(headers, query: dict, cookies: str = "") -> bool:
    """Is this request allowed in?

    Open panel: everything is. Keyed panel: the key must arrive as the
    X-Panel-Key header (a server-side proxy), as ?key= (a link somebody was
    given), or in the cookie that opening the panel with the right key sets.
    The cookie is SameSite=Strict, so another site cannot borrow it.
    """
    if not PANEL_KEY:
        return True
    wanted = PANEL_KEY.encode()
    given = (headers.get("X-Panel-Key") or "").strip()
    if not given:
        given = (query.get("key") or [""])[0].strip()
    if not given and cookies:
        for part in cookies.split(";"):
            name, _sep, value = part.strip().partition("=")
            if name == PANEL_COOKIE:
                given = urllib.parse.unquote(value.strip())
                break
    return bool(given) and hmac.compare_digest(given.encode(), wanted)


def file_token(name: str, expires: int) -> str:
    """A short-lived signature for one file, so a browser can fetch it directly.

    Why this exists: the dashboard proxies every byte through its own server
    function, and a hosting function has a wall-clock limit (60 s on Vercel's
    free plan). A 150 MB book on a slow link does not fit in that. With this the
    dashboard mints `?t=…&e=…` for one file and one moment, the phone downloads
    straight from the panel, and the panel key never appears in the URL.
    """
    if not PANEL_KEY:
        return ""
    message = f"{name}|{int(expires)}".encode()
    return hmac.new(PANEL_KEY.encode(), message, hashlib.sha256).hexdigest()


def token_ok(name: str, expires, given: str) -> bool:
    """Is that signature ours, for this file, and still in date?"""
    if not PANEL_KEY:
        return True                       # an open panel needs no signature
    if not given or expires is None:
        return False
    try:
        moment = int(expires)
    except (TypeError, ValueError):
        return False
    now = time.time()
    if moment < now or moment > now + 7 * 24 * 3600:
        return False                      # expired, or absurdly far ahead
    return hmac.compare_digest(given.strip(), file_token(name, moment))


def panel_cookie() -> str:
    """The cookie that keeps the panel working after ?key= was used once."""
    return (f"{PANEL_COOKIE}={urllib.parse.quote(PANEL_KEY, safe='')}; "
            "Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000")


def cors_headers(origin: str) -> dict[str, str]:
    """Allow exactly the origins listed in PANEL_ORIGIN, and no others.

    A wildcard would let any page on the internet drive this panel with a
    visitor's cookies, so the list is explicit or the answer is none.
    """
    clean = (origin or "").strip().rstrip("/")
    if not clean or clean not in PANEL_ORIGINS:
        return {}
    return {"Access-Control-Allow-Origin": clean,
            "Access-Control-Allow-Headers": "Content-Type, X-Panel-Key",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin"}


KEEP_FILES = int(os.environ.get("SCRIBD_KEEP_FILES", "40"))
MAX_OUT_MB = int(os.environ.get("SCRIBD_MAX_MB", "6000"))
CACHE_DAYS = float(os.environ.get("SCRIBD_CACHE_DAYS", "3"))


def folder_mb(folder: str) -> float:
    total = 0
    for root, _dirs, names in os.walk(folder):
        for name in names:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total / (1024 * 1024)


def prune_out(folder: str) -> list[str]:
    """Keep the output folder from filling a small disk.

    A 10 GB plan holds maybe forty 150 MB books, and every document also leaves
    its page scans in `cache/` — which is what makes re-running a partial cheap,
    so it is kept for a few days rather than thrown away at once. Rules, in
    order:

      1. page caches older than SCRIBD_CACHE_DAYS are deleted;
      2. only the newest SCRIBD_KEEP_FILES PDFs are kept;
      3. if the folder is still bigger than SCRIBD_MAX_MB, the oldest PDFs go
         until it is not.

    Returns one line per thing it deleted, so the log can say what happened
    instead of a folder quietly shrinking.
    """
    said: list[str] = []
    if not os.path.isdir(folder):
        return said

    cache_root = os.path.join(folder, "cache")
    cutoff = time.time() - CACHE_DAYS * 86400
    if os.path.isdir(cache_root):
        for name in sorted(os.listdir(cache_root)):
            path = os.path.join(cache_root, name)
            try:
                if os.path.isdir(path) and os.path.getmtime(path) < cutoff:
                    shutil.rmtree(path, ignore_errors=True)
                    said.append(f"cache: dropped {name} (older than "
                                f"{CACHE_DAYS:g} day(s))")
            except OSError:
                pass

    pdfs = panel_files(folder, limit=100000)
    for row in pdfs[KEEP_FILES:]:
        path = os.path.join(folder, row["name"])
        try:
            os.remove(path)
            said.append(f"disk: removed {row['name']} "
                        f"({row['bytes'] / 1e6:.0f} MB, older than the newest "
                        f"{KEEP_FILES})")
        except OSError:
            pass

    while folder_mb(folder) > MAX_OUT_MB and len(pdfs) > 1:
        row = pdfs.pop()                      # the oldest one left
        path = os.path.join(folder, row["name"])
        try:
            os.remove(path)
            said.append(f"disk: removed {row['name']} to stay under "
                        f"{MAX_OUT_MB} MB")
        except OSError:
            break
    return said


def panel_files(folder: str, limit: int = 100) -> list[dict]:
    """Every finished PDF in the output folder, newest first.

    The dashboard cannot guess file names, so it asks for this list instead of
    remembering what it started.
    """
    found: list[dict] = []
    try:
        names = os.listdir(folder)
    except OSError:
        return found
    for name in names:
        if not name.lower().endswith(".pdf"):
            continue
        path = os.path.join(folder, name)
        try:
            stat = os.stat(path)
        except OSError:
            continue
        found.append({"name": name, "bytes": stat.st_size,
                      "when": int(stat.st_mtime)})
    found.sort(key=lambda item: -item["when"])
    return found[:max(1, limit)]


def bookmarklet(origin: str) -> str:
    """The one-bookmark route: your browser finds, the panel downloads.

    Built server-side from the address you actually opened the panel on, so the
    link always points back at this panel — never at scribd.com.
    """
    target = (origin or "").rstrip("/") + "/send?"
    if PANEL_KEY:
        target += "key=" + urllib.parse.quote(PANEL_KEY, safe="") + "&"
    return ("javascript:(()=>{const o=" + json.dumps(target) + ";"
            "const sel='a[href*=\"/document/\"],a[href*=\"/presentation/\"],'"
            "+'a[href*=\"/spreadsheet/\"],a[href*=\"/ebook/\"]';"
            "const u=[...document.querySelectorAll(sel)]"
            ".map(a=>a.href.split('?')[0]).filter((v,i,s)=>s.indexOf(v)===i)"
            ".slice(0,40);"
            "if(!u.length){alert('no document links on this page');return}"
            "location.href=o+u.map(x=>'url='+encodeURIComponent(x)).join('&')})()")


def html_escape(text) -> str:
    raw = str(text if text is not None else "")
    for a, b in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"), ('"', "&quot;")):
        raw = raw.replace(a, b)
    return raw


# ---------------------------------------------------------------------------
# what the document is called
# ---------------------------------------------------------------------------
def safe_name(text: str, fallback: str) -> str:
    text = text or ""
    for a, b in (("&amp;", "&"), ("&#39;", "'"), ("&quot;", '"'), ("&lt;", "<"),
                 ("&gt;", ">")):
        text = text.replace(a, b)
    text = re.sub(r"\s+", " ", text).strip().strip("\"' ")
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", text)
    text = text.strip(" .")[:120].strip(" .")
    return text or fallback

def title_from_html(body: bytes, url: str) -> str:
    text = text_of(body)
    patterns = (
        r'<meta[^>]+property=["\']og:title["\'][^>]*?content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*?property=["\']og:title',
        r"<title[^>]*>([^<]+)</title>",
        r'"document_title"\s*:\s*"([^"]{3,200})"',
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
        if not match:
            continue
        name = match.group(1)
        name = re.sub(r"\s*[|\-–—]\s*Scribd.*$", "", name, flags=re.IGNORECASE)
        name = re.sub(r"\s+on Scribd$", "", name, flags=re.IGNORECASE)
        name = safe_name(name, "")
        if len(name) >= 3 and name.lower() not in ("scribd", "untitled"):
            return name
    slug = urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1]
    if slug and not slug.isdigit():
        return safe_name(urllib.parse.unquote(slug).replace("-", " ")
                         .replace("_", " "), "")
    return ""

def oembed(ident: str, jar: dict) -> dict:
    url = ("https://www.scribd.com/services/oembed?url="
           + urllib.parse.quote(f"https://www.scribd.com/document/{ident}", safe="")
           + "&format=json")
    got = fetch(url, jar, timeout=20)
    if got["error"] or got["status"] >= 400 or not got["body"]:
        return {}
    try:
        data = json.loads(got["body"].decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return {}
    return data if isinstance(data, dict) else {}

# ---------------------------------------------------------------------------
# images -> something a PDF can hold
# ---------------------------------------------------------------------------
def _sof_candidates(data: bytes) -> list[tuple[int, int, int]]:
    """Every JPEG frame header in the data, as (width, height, components)."""
    found: list[tuple[int, int, int]] = []
    for match in re.finditer(rb"\xff[\xc0-\xcf]", data):
        position = match.start()
        marker = data[position + 1]
        if marker in (0xC4, 0xC8, 0xCC):        # not frame headers
            continue
        if position + 10 > len(data):
            continue
        height, width = struct.unpack(">HH", data[position + 5:position + 9])
        components = data[position + 9]
        if width and height:
            found.append((width, height, components))
    return found

def jpeg_frames(data: bytes) -> tuple[list[tuple[int, int, int]], bool]:
    """Every frame header in a JPEG, and whether the file arrived whole.

    A cut transfer keeps the header and loses the tail, so the only honest test
    for "did this file arrive complete" is the end-of-image marker. Without it a
    viewer draws the decoded sliver and greys the rest — a page that looks like
    our bug instead of the CDN's.
    """
    if data[:2] != b"\xff\xd8":
        return [], False
    frames: list[tuple[int, int, int]] = []
    index = 2
    limit = min(len(data), 4_000_000)
    saw_scan = False
    while index + 4 <= limit:
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker == 0xFF:
            index += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        if marker == 0xD9:                    # end of image, before any scan
            break
        if marker == 0xDA:                    # scan data starts here
            saw_scan = True
            break
        length = struct.unpack(">H", data[index + 2:index + 4])[0]
        if length < 2:
            break
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if index + 10 <= limit:
                height, width = struct.unpack(">HH", data[index + 5:index + 9])
                components = data[index + 9]
                if width and height:
                    frames.append((width, height, components))
        index += 2 + length
    tail = data.rstrip(b"\x00\t\r\n ")
    return frames, bool(saw_scan and tail.endswith(b"\xff\xd9"))


def biggest_frame(frames: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """The largest picture in a JPEG file — never a header's decoy thumbnail."""
    if not frames:
        return 0, 0, 0
    return max(frames, key=lambda frame: frame[0] * frame[1])


def small_frame(frames: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """A page-shaped picture that is complete but smaller than a real scan.

    Some documents are only served at reduced size under every name we know. A
    page at 300x400 is readable; one at 60 px is a smudge, so there is a floor.
    """
    best = (0, 0, 0)
    for width, height, components in frames:
        if min(width, height) < PREVIEW_MIN_PX:
            continue
        if not (ASPECT_RANGE[0] <= width / height <= ASPECT_RANGE[1]):
            continue
        if width * height > best[0] * best[1]:
            best = (width, height, components or 3)
    return best


def jpeg_size(data: bytes) -> tuple[int, int, int]:
    """The real frame size, validated — not the first marker we trip over.

    2.3 walked the marker chain and believed the first SOF it met. An EXIF
    thumbnail, a padding segment or a truncated chain can put a 772x68 "frame"
    in front of the real one, and then the whole book was laid out for 772x68.
    Now: walk the chain, collect every plausible frame, and only if none of them
    is a plausible page scan fall back to scanning the raw bytes.
    """
    if data[:2] != b"\xff\xd8":
        return 0, 0, 0
    walked, _complete = jpeg_frames(data)
    for group in (walked, _sof_candidates(data[:200_000])):
        for width, height, components in group:
            if (width >= MIN_PAGE_PX and height >= MIN_PAGE_PX
                    and ASPECT_RANGE[0] <= width / height <= ASPECT_RANGE[1]):
                return width, height, components or 3
    return 0, 0, 0

def jpeg_orientation(data: bytes) -> int:
    """EXIF orientation 1..8, or 1 when there is none."""
    if data[:2] != b"\xff\xd8":
        return 1
    index = 2
    while index + 4 <= min(len(data), 200_000):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        if marker in (0xD9, 0xDA):
            break
        length = struct.unpack(">H", data[index + 2:index + 4])[0]
        if length < 2:
            break
        segment = data[index + 4:index + 2 + length]
        if marker == 0xE1 and segment[:6] == b"Exif\x00\x00":
            tiff = segment[6:]
            if len(tiff) > 8:
                little = tiff[:2] == b"II"
                order = "<" if little else ">"
                try:
                    ifd = struct.unpack(order + "I", tiff[4:8])[0]
                    count = struct.unpack(order + "H", tiff[ifd:ifd + 2])[0]
                    for entry in range(count):
                        base = ifd + 2 + entry * 12
                        tag, kind, _count = struct.unpack(
                            order + "HHI", tiff[base:base + 8])
                        if tag == 0x0112 and kind == 3:
                            value = struct.unpack(order + "H", tiff[base + 8:base + 10])[0]
                            return value if 1 <= value <= 8 else 1
                except struct.error:
                    return 1
            return 1
        index += 2 + length
    return 1

def png_chunks(data: bytes) -> tuple[dict, bytes, bytes] | None:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos = 8
    header: dict = {}
    palette = b""
    stream = b""
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if len(body) != length:
            break
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", body)
            header = {"width": width, "height": height, "depth": depth,
                      "colour": colour, "interlace": interlace}
        elif kind == b"PLTE":
            palette = body
        elif kind == b"IDAT":
            stream += body
        elif kind == b"IEND":
            break
    if not header or not stream:
        return None
    return header, palette, stream

def png_for_pdf(data: bytes) -> dict | None:
    """Embed a PNG's own filtered scanlines. No decode, no pixel loop."""
    parsed = png_chunks(data)
    if parsed is None:
        return None
    header, palette, stream = parsed
    width, height = header["width"], header["height"]
    depth, colour = header["depth"], header["colour"]
    # only 8-bit goes in directly: 1/2/4-bit rows are legal in PDF but readers
    # disagree about unpacking them, and a page that renders differently in
    # someone else's reader is worse than a slow page.
    if header["interlace"] != 0 or depth != 8 or not width:
        return None
    if colour == 0:
        colours, space = 1, "/DeviceGray"
    elif colour == 2:
        colours, space = 3, "/DeviceRGB"
    elif colour == 3:
        if not palette:
            return None
        entries = max(1, len(palette) // 3)
        colours = 1
        space = (f"[/Indexed /DeviceRGB {entries - 1} "
                 f"<{palette[:entries * 3].hex()}>]")
    else:
        return None
    params = (f"/Width {width} /Height {height} /ColorSpace {space} "
              f"/BitsPerComponent {depth} /Filter /FlateDecode "
              f"/DecodeParms << /Predictor 15 /Colors {colours} "
              f"/BitsPerComponent {depth} /Columns {width} >>")
    return {"payload": stream, "params": params, "width": width, "height": height,
            "label": f"{width}x{height} png, {len(stream) / 1000:.0f} kB"}

def _unfilter(raw: bytes, width: int, height: int, bpp: int, stride: int) -> bytes:
    out = bytearray(height * stride)
    previous = bytearray(stride)
    pos = 0
    for row in range(height):
        if pos >= len(raw):
            break
        kind = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if kind == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif kind == 2:
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif kind == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif kind == 4:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                up = previous[i]
                corner = previous[i - bpp] if i >= bpp else 0
                delta = left + up - corner
                pa, pb, pc = abs(delta - left), abs(delta - up), abs(delta - corner)
                predictor = left if (pa <= pb and pa <= pc) else (
                    up if pb <= pc else corner)
                line[i] = (line[i] + predictor) & 0xFF
        out[row * stride:(row + 1) * stride] = line
        previous = line
    return bytes(out)

def _unpack_bits(row: bytes, count: int, depth: int) -> list[int]:
    out: list[int] = []
    per_byte = 8 // depth
    mask = (1 << depth) - 1
    for byte in row:
        for slot in range(per_byte):
            out.append((byte >> (8 - depth * (slot + 1))) & mask)
            if len(out) == count:
                return out
    return out

def png_to_raw(data: bytes) -> tuple[bytes, int, int, int] | None:
    parsed = png_chunks(data)
    if parsed is None:
        return None
    header, palette, stream = parsed
    width, height = header["width"], header["height"]
    depth, colour = header["depth"], header["colour"]
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(colour)
    if not width or not channels or header["interlace"] != 0:
        return None
    if depth not in (1, 2, 4, 8):
        return None
    if depth < 8 and colour not in (0, 3):
        return None
    try:
        raw = zlib.decompress(stream)
    except zlib.error:
        return None
    bits = depth * channels
    stride = (width * bits + 7) // 8
    bpp = max(1, bits // 8)
    pixels = _unfilter(raw, width, height, bpp, stride)

    if depth < 8:
        full = (1 << depth) - 1
        rows: list[bytes] = []
        for row in range(height):
            line = pixels[row * stride:(row + 1) * stride]
            samples = _unpack_bits(line, width * channels, depth)
            if colour == 3:
                out = bytearray()
                for index in samples:
                    entry = index * 3
                    out += palette[entry:entry + 3] or b"\x00\x00\x00"
                rows.append(bytes(out))
            else:
                rows.append(bytes(sample * 255 // full for sample in samples))
        pixels = b"".join(rows)
        return (pixels, width, height, 3) if colour == 3 else (pixels, width, height, 1)

    if colour == 3:
        out = bytearray(width * height * 3)
        for index in range(width * height):
            entry = pixels[index] * 3
            out[index * 3:index * 3 + 3] = palette[entry:entry + 3] or b"\x00\x00\x00"
        return bytes(out), width, height, 3
    if colour == 2:
        return pixels, width, height, 3
    if colour == 0:
        return pixels, width, height, 1
    if colour == 6:
        out = bytearray(width * height * 3)
        for index in range(width * height):
            out[index * 3:index * 3 + 3] = pixels[index * 4:index * 4 + 3]
        return bytes(out), width, height, 3
    if colour == 4:
        out = bytearray(width * height)
        for index in range(width * height):
            out[index] = pixels[index * 2]
        return bytes(out), width, height, 1
    return None

def _raw_page(pixels: bytes, width: int, height: int, components: int,
              label: str) -> dict:
    payload = zlib.compress(pixels, 6)
    space = "/DeviceRGB" if components == 3 else "/DeviceGray"
    return {"payload": payload, "width": width, "height": height, "rotate": 1,
            "params": (f"/Width {width} /Height {height} /ColorSpace {space} "
                       "/BitsPerComponent 8 /Filter /FlateDecode"),
            "label": f"{label}, {len(payload) / 1000:.0f} kB"}

def pillow_page(data: bytes) -> dict | None:
    """Decode with Pillow when the bytes are legal but awkward (webp, 16-bit PNG,
    interlaced PNG). Optional: without Pillow these pages are reported, not lost
    silently."""
    try:
        import io

        from PIL import Image
    except Exception:  # noqa: BLE001
        return None
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            kind = {"WEBP": "webp", "PNG": "png"}.get(image.format or "", "image")
            rgb = image.convert("RGB")
            return _raw_page(rgb.tobytes(), rgb.width, rgb.height, 3,
                             f"{rgb.width}x{rgb.height} {kind}")
    except Exception:  # noqa: BLE001
        return None

def pillow_size(data: bytes) -> tuple[int, int, int]:
    """Last-resort size for an image whose header the parser cannot trust.

    Only reached when the bytes look like an image but no plausible frame header
    was found. Pillow is optional; without it this simply says "unknown" and the
    page is reported, never guessed at.
    """
    try:
        import io

        from PIL import Image
    except Exception:  # noqa: BLE001
        return 0, 0, 0
    try:
        with Image.open(io.BytesIO(data)) as image:
            return image.width, image.height, 3
    except Exception:  # noqa: BLE001
        return 0, 0, 0

def with_flags(page: dict | None, complete: bool = True) -> dict | None:
    """Record what the report needs to know about the picture that arrived."""
    if not page:
        return None
    page.setdefault("preview", False)
    page.setdefault("complete", complete)
    return page


def scan_for_pdf(data: bytes) -> dict | None:
    """One page scan -> {'payload','params','width','height','rotate','label'}.

    Two facts ride along with the picture, because both decide what the report
    can honestly say about it:

      complete  the file ends where it should (JPEG end-of-image, PNG IEND).
                A transfer cut in the middle looks normal otherwise.
      preview   a complete, page-shaped picture smaller than a real scan: some
                documents are only served at that size. It still goes into the
                PDF, scaled to the sheet, and the count is reported — a readable
                page beats a blank placeholder with an excuse.
    """
    if data[:2] == b"\xff\xd8":
        frames, complete = jpeg_frames(data)
        width, height, components = jpeg_size(data)
        preview = False
        if width and not page_can_be_this_small(width, height, len(data)):
            # a page-sized file cannot really be a 772x68 picture: the header
            # read is wrong, so ask a decoder before believing either number
            wide, tall, guess = pillow_size(data)
            if page_can_be_this_small(wide, tall, len(data)):
                width, height, components = wide, tall, guess
            else:
                width = 0
        if not (width and plausible_page({"width": width, "height": height})):
            # the header chain said nothing usable, or said something no page
            # could be: ask a real decoder, then fall back to the best picture
            # the file actually contains
            wide, tall, guess = pillow_size(data)
            if wide and tall and plausible_page({"width": wide, "height": tall}):
                width, height, components = wide, tall, guess
            else:
                width, height, components = small_frame(frames)
                if not width:
                    return None
                preview = True
        space = {1: "/DeviceGray", 3: "/DeviceRGB", 4: "/DeviceCMYK"}.get(
            components, "/DeviceRGB")
        return {"payload": data, "width": width, "height": height,
                "rotate": jpeg_orientation(data),
                "params": (f"/Width {width} /Height {height} /ColorSpace {space} "
                           "/BitsPerComponent 8 /Filter /DCTDecode /Interpolate true"),
                "label": (f"{width}x{height} jpeg, {len(data) / 1000:.0f} kB"
                          + (", small preview" if preview else "")
                          + ("" if complete else ", cut short")),
                "preview": preview, "complete": complete}
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        complete = data.rstrip(b"\x00\t\r\n ").endswith(b"IEND\xaeB`\x82")
        direct = png_for_pdf(data)
        if direct:
            return with_flags(direct, complete)
        decoded = png_to_raw(data)
        if decoded:
            pixels, width, height, components = decoded
            return with_flags(_raw_page(pixels, width, height, components,
                                        f"{width}x{height} png"), complete)
        return with_flags(pillow_page(data), complete)   # 16-bit / interlaced
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return with_flags(pillow_page(data))
    return with_flags(pillow_page(data))


def size_text(count: int) -> str:
    """Bytes as the log should say them: 430 B, 6.2 kB, 151 kB."""
    if count < 1000:
        return f"{count} B"
    if count < 10_000:
        return f"{count / 1000:.1f} kB"
    return f"{count / 1000:.0f} kB"


def describe_image(data: bytes) -> str:
    """What actually arrived, in one line, so a refusal is never a riddle.

    "6 kB jpeg that is not a page scan" told nobody anything. This says the
    size the file declares, whether it is complete, and whether it was simply
    too small to be a page — which is the difference between a bad parse, a cut
    transfer and a document Scribd keeps at low resolution.
    """
    size = size_text(len(data))
    if not data:
        return "an empty body"
    if data[:2] == b"\xff\xd8":
        frames, complete = jpeg_frames(data)
        cut = "" if complete else ", cut short (no end-of-image marker)"
        width, height, _components = biggest_frame(frames)
        if not width:
            return f"a jpeg with no frame header, {size}{cut}"
        if not plausible_page({"width": width, "height": height}):
            return (f"a {width}x{height} jpeg, {size}{cut} — below the "
                    f"{MIN_PAGE_PX} px floor for a page")
        return f"a {width}x{height} jpeg, {size}{cut}"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return f"a png, {size}"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return f"a webp, {size}"
    return (f"{size} that is not an image at all "
            f"(starts {data[:12].decode('latin-1', 'replace').strip()!r})")


def looks_like_image(data: bytes) -> bool:
    return (data[:2] == b"\xff\xd8" or data[:8] == b"\x89PNG\r\n\x1a\n"
            or (data[:4] == b"RIFF" and data[8:12] == b"WEBP"))

def page_can_be_this_small(width: int, height: int, size: int) -> bool:
    """Could a file of `size` bytes really be a picture this many pixels?

    A JPEG spends roughly 0.2 to 8 bits per pixel. 90 kB declared as 772x68 is
    13 bits per pixel, which no scan reaches: the size read is wrong. This is
    the cheap, dependency-free guard against exactly the misparse that made
    2.3 lay out a 402-page book as strips.
    """
    if not width or not height:
        return False
    bits = size * 8 / (width * height)
    return bits <= 12.0


def plausible_page(page: dict) -> bool:
    """Is this really a page scan, or a thumbnail / banner / misparse?"""
    width, height = page["width"], page["height"]
    if width < MIN_PAGE_PX or height < MIN_PAGE_PX:
        return False
    return ASPECT_RANGE[0] <= width / height <= ASPECT_RANGE[1]

# ---------------------------------------------------------------------------
# pdf
# ---------------------------------------------------------------------------
def pdf_string(text: str) -> bytes:
    return (text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
            ).encode("latin-1", "replace")

def median_page(pages: list[dict]) -> tuple[int, int]:
    """The document's page size: the median PAGE, not the commonest and not two
    medians. Sorting by area and taking the middle page keeps the answer a real
    page's own (width, height); averaging the axes separately can invent a size
    no page ever had (1200x1600 + 1600x1200 -> 1600x1600). One misparsed page
    cannot move the middle of 400.
    """
    ordered = sorted(pages, key=lambda page: (page["width"] * page["height"],
                                              page["width"]))
    page = ordered[len(ordered) // 2]
    return page["width"], page["height"]

def house_sheet(pages: list[dict]) -> tuple[float, float]:
    """The one sheet every page is scaled into: the median page, in points.

    Pages that only came as a small preview are left out of the median: a
    document served half in 96x130 copies must not end up with 96x130 sheets.
    """
    real = [page for page in pages if not page.get("preview")] or pages
    width, height = median_page(real)
    return round(width * 0.75, 2), round(height * 0.75, 2)

def sheet_list(collected: dict[int, dict], total: int,
               placeholder: bool) -> list[dict | None]:
    """Page N of the PDF is page N of the document — unless you ask otherwise."""
    if placeholder:
        return [collected.get(number) for number in range(1, total + 1)]
    return [collected[number] for number in sorted(collected) if number <= total]

def _placement(page: dict, sheet: tuple[float, float]) -> tuple[float, float, float, float]:
    """(box_w, box_h, left, bottom) for one scan on one sheet.

    Aspect ratio is preserved and nothing is ever cropped. EXIF orientation is
    applied by swapping the box, and the image matrix is rotated to match.
    """
    width, height = page["width"], page["height"]
    rotate = page.get("rotate", 1)
    if rotate in (5, 6, 7, 8):                    # stored sideways
        width, height = height, width
    natural_w, natural_h = width * 0.75, height * 0.75
    # fill the sheet, but never blow a small scan up into mush: past 2x the
    # pixels are invented, so a genuinely small page stays crisp and centred.
    # A preview has no crispness to lose, so it fills the sheet instead of
    # sitting in the middle of it like a postage stamp.
    fit = min(sheet[0] / natural_w, sheet[1] / natural_h)
    if not page.get("preview"):
        fit = min(fit, 2.0)
    box_w = round(natural_w * fit, 2)
    box_h = round(natural_h * fit, 2)
    return (box_w, box_h, round((sheet[0] - box_w) / 2, 2),
            round((sheet[1] - box_h) / 2, 2))

def _image_matrix(page: dict, box: tuple[float, float, float, float]) -> str:
    """The cm matrix that draws the scan inside its box, EXIF rotation applied.

    The box is already in DISPLAY orientation, so the matrix only has to turn
    the stored pixels: x = a*u + c*v + e, y = b*u + d*v + f, over the unit
    square. (u,v) run along the stored width and height.
    """
    width, height, left, bottom = box
    rotate = page.get("rotate", 1)
    if rotate in (6, 5):                     # stored sideways, turn 90 deg CW
        return f"0 {-height} {width} 0 {left} {bottom + height} cm"
    if rotate in (8, 7):                     # stored sideways, turn 90 deg CCW
        return f"0 {height} {-width} 0 {left + width} {bottom} cm"
    if rotate == 3:
        return f"{-width} 0 0 {-height} {left + width} {bottom + height} cm"
    return f"{width} 0 0 {height} {left} {bottom} cm"

def pdf_visible_text(text: str) -> str:
    """Escape a string for a PDF literal, and give up on what Helvetica cannot say.

    The font is base-14 WinAnsi, so anything outside Latin-1 is dropped rather
    than turned into a row of question marks. Brackets and backslashes must be
    escaped or the string ends the content stream early.
    """
    out: list[str] = []
    for char in text:
        code = ord(char)
        if char in "()\\":
            out.append("\\" + char)
        elif 32 <= code <= 126 or 160 <= code <= 255:
            out.append(char)
        elif char in "\t":
            out.append(" ")
    return "".join(out)


def text_layer(words: str, box: tuple[float, float, float, float],
               size: float = 9.0) -> bytes:
    """The invisible text of one page, laid out inside the sheet.

    box is _placement's (width, height, left, bottom). Invisible on purpose
    (render mode 3): the scan is already the picture, so the text only has to be
    there for search, copy and accessibility. Lines are wrapped to the sheet so
    selection follows the page instead of running off it.
    """
    width, height, left, bottom = box
    if not words or width < 20 or height < 20:
        return b""
    usable = max(10.0, width - 6)
    per_line = max(8, int(usable / (size * 0.5)))
    lines: list[str] = []
    for paragraph in words.split("\n"):
        while len(paragraph) > per_line:
            cut = paragraph.rfind(" ", 0, per_line)
            cut = cut if cut > per_line // 2 else per_line
            lines.append(paragraph[:cut].strip())
            paragraph = paragraph[cut:].strip()
        lines.append(paragraph)
    lines = [line for line in lines if line]
    if not lines:
        return b""
    leading = size * 1.2
    room = int((height - 8) / leading)
    if room <= 0:
        return b""
    lines = lines[:room]
    top = bottom + height - size - 2
    body = [f"BT /F1 {size:.1f} Tf 3 Tr 0 0 0 rg"]
    for index, line in enumerate(lines):
        body.append(f"1 0 0 1 {left + 3:.2f} {top - index * leading:.2f} Tm "
                    f"({pdf_visible_text(line)}) Tj")
    body.append("ET")
    return "\n".join(body).encode("latin-1", "replace")


def build_pdf(pages: list[dict | None], path: str, title: str = "",
              author: str = "", uniform: bool = True,
              texts: dict[int, str] | None = None) -> tuple[bool, str]:
    """pages: [{'payload','params','width','height','rotate'}|None] in sheet order.

    None is a labelled placeholder sheet, so PDF page N always equals document
    page N. uniform=False gives every sheet the MediaBox of its own scan.
    """
    real = [page for page in pages if page]
    if not real:
        return False, "no pages to write"
    house = house_sheet(real)
    texts = texts or {}
    with_text = 0

    objects: list[bytes] = [b"", b"", b""]     # 1 catalog, 2 pages, 3 font
    objects[2] = (b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
                  b"/Encoding /WinAnsiEncoding >>")
    kids: list[int] = []

    for index, page in enumerate(pages, start=1):
        if page is None:
            sheet = house
            text = f"page {index} - scan not available"
            # centred on the sheet, with a light frame, so a missing page is
            # obvious in the book rather than an empty white leaf
            span = len(text) * 16 * 0.5
            left = max(36.0, (sheet[0] - span) / 2)
            middle = sheet[1] / 2
            content = (f"0.85 0.85 0.85 RG 1 w 36 {middle - 40:.2f} "
                       f"{sheet[0] - 72:.2f} 80 re S "
                       f"BT /F1 16 Tf 0 0 0 rg 1 0 0 1 {left:.2f} {middle:.2f} Tm "
                       f"({text}) Tj ET").encode()
            objects.append(b"<< /Length " + str(len(content)).encode()
                           + b" >>\nstream\n" + content + b"\nendstream")
            content_num = len(objects)
            objects.append(
                (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {sheet[0]} {sheet[1]}]"
                 f" /Resources << /ProcSet [/PDF /Text] /Font << /F1 3 0 R >> >>"
                 f" /Contents {content_num} 0 R >>").encode())
            kids.append(len(objects))
            continue

        sheet = (house if uniform else
                 (round(page["width"] * 0.75, 2), round(page["height"] * 0.75, 2)))
        box = _placement(page, sheet)
        image = page["payload"]
        objects.append(("<< /Type /XObject /Subtype /Image " + page["params"]
                        + f" /Length {len(image)} >>").encode()
                       + b"\nstream\n" + image + b"\nendstream")
        image_num = len(objects)
        body = [("q " + _image_matrix(page, box) + " /Im0 Do Q").encode()]
        layer = text_layer(texts.get(index, ""), box) if texts else b""
        if layer:
            body.append(layer)
            with_text += 1
        content = b"\n".join(body)
        objects.append(b"<< /Length " + str(len(content)).encode()
                       + b" >>\nstream\n" + content + b"\nendstream")
        content_num = len(objects)
        objects.append(
            (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {sheet[0]} {sheet[1]}]"
             f" /Resources << /ProcSet [/PDF /ImageB /ImageC /Text]"
             f" /Font << /F1 3 0 R >>"
             f" /XObject << /Im0 {image_num} 0 R >> >>"
             f" /Contents {content_num} 0 R >>").encode())
        kids.append(len(objects))

    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = (f"<< /Type /Pages /Count {len(kids)} /Kids ["
                  + " ".join(f"{kid} 0 R" for kid in kids) + "] >>").encode()
    stamp = datetime.datetime.now().strftime("D:%Y%m%d%H%M%S")
    info = (b"<< /Title " + pdf_string(title) + b" /Author " + pdf_string(author)
            + b" /Producer (scribd_download " + VERSION.encode()
            + b") /CreationDate (" + stamp.encode() + b") >>")
    objects.append(info)
    info_num = len(objects)

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info {info_num} 0 R"
            f" >>\nstartxref\n{xref}\n%%EOF\n").encode()
    with open(path, "wb") as handle:
        handle.write(bytes(out))
    blanks = sum(1 for page in pages if page is None)
    return True, (f"{len(kids)} sheet(s), {len(out) / 1_000_000:.2f} MB"
                  + (f", {blanks} placeholder" if blanks else "")
                  + (f", {with_text} page(s) with searchable text" if texts
                     and with_text else ""))

# ---------------------------------------------------------------------------
# read the file back and check it as a PDF
# ---------------------------------------------------------------------------
XREF_ENTRY_RE = re.compile(rb"\d{10} \d{5} [nf] \r?\n")

def verify_pdf(path: str, expect_pages: int = 0, expect_images: int = 0,
               uniform: bool = True) -> tuple[bool, str]:
    """Read the finished file and validate it, instead of assuming it is fine."""
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError as exc:
        return False, f"unreadable: {exc}"
    return verify_bytes(data, expect_pages, expect_images, uniform)

def verify_bytes(data: bytes, expect_pages: int = 0, expect_images: int = 0,
                 uniform: bool = True) -> tuple[bool, str]:
    """The checks themselves, over the bytes of a PDF.

    Checks the header, every xref offset against the object header that should be
    there, the trailer and /Root, each page's MediaBox and /Contents, each stream's
    /Length against the bytes that follow it, the filter against the data magic,
    /Count against the real number of kid pages, and the image count.
    """
    size = len(data)
    problems: list[str] = []
    if not data.startswith(b"%PDF-1."):
        return False, "no %PDF header"
    if b"%%EOF" not in data[-1024:]:
        problems.append("no %%EOF in the last 1 kB")
    match = re.search(rb"startxref\s+(\d+)", data[-4096:])
    if not match:
        return False, "no startxref in the trailer"
    xref = int(match.group(1))
    if xref >= size or data[xref:xref + 4] != b"xref":
        return False, f"startxref {xref} does not point at an xref table"
    head = re.match(rb"xref\r?\n(\d+) (\d+)\r?\n", data[xref:])
    if not head:
        return False, "malformed xref header"
    first, count = int(head.group(1)), int(head.group(2))
    if first != 0:
        problems.append(f"xref starts at object {first}, not 0")
    pos = xref + head.end()
    offsets: dict[int, int] = {}
    for index in range(count):
        entry = data[pos:pos + 20]
        if not XREF_ENTRY_RE.fullmatch(entry):
            problems.append(f"xref entry {first + index} malformed: {entry!r}")
            break
        if entry[17:18] == b"n":
            offsets[first + index] = int(entry[:10])
        pos += 20
    trailer = data[pos:pos + 512]
    if not trailer.startswith(b"trailer"):
        problems.append("no trailer keyword after the xref")
    root = re.search(rb"/Root (\d+) 0 R", trailer)
    if not root:
        problems.append("trailer has no /Root")
    elif int(root.group(1)) not in offsets:
        problems.append("/Root does not resolve to an object")

    ordered = sorted(offsets.items(), key=lambda item: item[1])
    pages = 0
    images = 0
    boxes: set[tuple[float, float]] = set()
    counted = -1
    for index, (number, offset) in enumerate(ordered):
        end = ordered[index + 1][1] if index + 1 < len(ordered) else xref
        if not re.match(rb"%d 0 obj" % number, data[offset:offset + 24]):
            problems.append(f"object {number} is not at its xref offset")
            continue
        body = data[offset:end]
        # only the dictionary is inspected: a page could legitimately contain
        # the bytes "/Type /Page" inside its image data by pure chance
        head = body.split(b"stream", 1)[0]
        length_match = re.search(rb"/Length (\d+)\s*>>\s*stream\r?\n", body)
        if length_match:
            length = int(length_match.group(1))
            start = length_match.end()
            if start + length > len(body):
                problems.append(f"object {number}: stream runs past the object")
            else:
                payload = body[start:start + length]
                if not body[start + length:start + length + 12].startswith(b"\nendstream"):
                    problems.append(f"object {number}: no endstream after /Length bytes")
                if b"/DCTDecode" in head:
                    if payload[:2] != b"\xff\xd8":
                        problems.append(f"object {number}: DCTDecode without JPEG data")
                elif b"/FlateDecode" in body:
                    try:
                        zlib.decompress(payload)
                    except zlib.error:
                        problems.append(f"object {number}: FlateDecode will not inflate")
        if b"/Type /XObject" in head and b"/Subtype /Image" in head:
            images += 1                       # an image is its own object
            width = re.search(rb"/Width (\d+)", head)
            height = re.search(rb"/Height (\d+)", head)
            if width and height:
                wide, tall = int(width.group(1)), int(height.group(1))
                if wide < PREVIEW_MIN_PX or tall < PREVIEW_MIN_PX:
                    # a preview page is allowed to be small, a smudge is not:
                    # the sheet can only ever be as readable as its picture
                    problems.append(f"image object {number} is only {wide}x{tall} px")
        if b"/Type /Catalog" in head:
            if b"/Pages" not in body:
                problems.append("catalog has no /Pages")
        elif b"/Type /Pages" in head:
            found = re.search(rb"/Count (\d+)", body)
            counted = int(found.group(1)) if found else -1
            listed = re.findall(rb"(\d+) 0 R", head.split(b"/Kids", 1)[-1])
            if len(listed) != counted:
                problems.append(f"/Count says {counted}, /Kids lists {len(listed)}")
        elif b"/Type /Page" in head:
            pages += 1
            box = re.search(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]", head)
            if not box:
                problems.append(f"page object {number} has no MediaBox")
            else:
                wide, tall = float(box.group(1)), float(box.group(2))
                boxes.add((wide, tall))
                if not (40 <= wide <= 4000 and 40 <= tall <= 4000):
                    problems.append(f"page object {number}: MediaBox {wide}x{tall}")
            for key in (b"/Contents", b"/Parent"):
                if key not in head:
                    problems.append(f"page object {number} lacks {key.decode()}")

    if expect_pages and pages != expect_pages:
        problems.append(f"{pages} page object(s), expected {expect_pages}")
    if expect_images and images != expect_images:
        problems.append(f"{images} image stream(s), expected {expect_images}")
    if uniform and len(boxes) > 1:
        problems.append(f"{len(boxes)} different sheet sizes: {sorted(boxes)[:4]}")

    if problems:
        return False, ("; ".join(problems[:6])
                       + (f" (+{len(problems) - 6} more)" if len(problems) > 6 else ""))
    shapes = sorted(boxes)
    if not shapes:
        sheets = "no sheet"
    elif len(shapes) == 1:
        sheets = f"sheet {shapes[0][0]}x{shapes[0][1]} pt"
    else:
        listed = ", ".join(f"{wide}x{tall}" for wide, tall in shapes[:3])
        sheets = f"{len(shapes)} sheet size(s): {listed} pt"
    return True, (f"{pages} page(s), {images} image stream(s), "
                  f"{size / 1_000_000:.2f} MB, {sheets}, xref and trailer ok")

# ---------------------------------------------------------------------------
# the job
# ---------------------------------------------------------------------------
STALL_SECONDS = 420          # a "running" job with no page progress for 7 min is wedged


class Job:
    """One job slot, with a generation number so a stopped job really stops.

    The generation is what makes stopping honest: every worker asks
    `alive(gen)`, and a reset bumps the generation, so the abandoned thread
    can never write into the new job's progress or verdict.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.generation = 0
        self.heartbeat = 0.0
        self.lines: list[str] = []
        self.state = "idle"
        self.verdict = ""
        self.detail = ""
        self.url = ""
        self.started = 0.0
        self.ended = 0.0
        self.progress = {"page": 0, "of": 0, "ok": 0, "skipped": 0, "blank": 0}
        self.file = ""
        self.title = ""
        self.out = OUT
        # the queue: ticked documents wait here, one is downloaded at a time
        self.queue: list[dict] = []
        self.queue_done = 0
        self.queue_total = 0
        self.current = ""
        self.results: list[dict] = []

    def say(self, text: str) -> None:
        with self.lock:
            self.lines.append(text)
            del self.lines[:-400]
        print(text, flush=True)

    def set_progress(self, **kwargs) -> None:
        with self.lock:
            self.progress.update(kwargs)
            self.heartbeat = time.time()      # the sign of a job that is alive

    def quiet_for(self) -> float:
        """Seconds since the last page progress (0 when nothing is running)."""
        with self.lock:
            if self.state != "running":
                return 0.0
            last = self.heartbeat or self.started or time.time()
            return max(0.0, time.time() - last)

    def stalled(self) -> bool:
        return self.quiet_for() > STALL_SECONDS

    def alive(self, gen: int) -> bool:
        """Is that generation still the job that owns the slot?"""
        with self.lock:
            return self.state == "running" and gen == self.generation

    def _start(self) -> int:
        """Take the slot. `threading.Lock` is not re-entrant, so the CALLER
        holds the lock — `begin()` and `enqueue()` both do."""
        self.generation += 1
        self.state = "running"
        self.started = time.time()
        self.heartbeat = self.started
        self.ended = 0.0
        self.verdict = ""
        self.detail = ""
        self.file = ""
        self.title = ""
        self.lines.clear()
        self.progress = {"page": 0, "of": 0, "ok": 0, "skipped": 0, "blank": 0}
        # a fresh start begins a fresh tally; anything already queued stays queued
        self.queue_done = 0
        self.results = []
        self.current = ""
        return self.generation

    def begin(self) -> int:
        """Start a job from the command line, where there is no queue to check."""
        with self.lock:
            return self._start()

    def stop(self, reason: str, clear_queue: bool = True) -> bool:
        """Stop whatever is running, so its workers see they are not alive."""
        with self.lock:
            dropped = len(self.queue)
            if clear_queue:
                self.queue.clear()
                self.current = ""
            if self.state != "running":
                return False
            self.generation += 1          # every worker now answers alive() == False
            self.state = "done"
            self.verdict = "STOPPED"
            self.detail = reason + (f" · {dropped} document(s) dropped from the queue"
                                    if dropped else "")
            self.ended = time.time()
        return True

    # -- the queue ---------------------------------------------------------
    def pending(self) -> int:
        with self.lock:
            return len(self.queue)

    def enqueue(self, items: list[dict]) -> tuple[bool, int, str]:
        """Queue these documents. Start the worker only if nobody is working.

        This is what makes "download ticked while another book is downloading"
        work: a second tap is not refused and nothing is lost — it is added
        behind the one in flight. A job that has not moved for STALL_SECONDS is
        taken over, and whatever was still queued for it carries on here.
        """
        if not items:
            return False, self.generation, ""
        note = ""
        with self.lock:
            if self.state == "running":
                quiet = time.time() - (self.heartbeat or self.started or time.time())
                if quiet <= STALL_SECONDS:
                    self.queue.extend(items)
                    self.queue_total += len(items)
                    return False, self.generation, ""
                note = (f"taking over from a job that had not moved for "
                        f"{int(quiet)}s")
            self.queue.extend(items)      # a takeover keeps the waiting work
            gen = self._start()
            self.queue_total = len(self.queue)
            return True, gen, note

    def next_item(self, gen: int) -> dict | None:
        """The next document for this worker, or None when the queue is empty."""
        with self.lock:
            if gen != self.generation or self.state != "running":
                return None
            if not self.queue:
                return None
            item = self.queue.pop(0)
            self.current = str(item.get("url") or "")
            self.progress = {"page": 0, "of": 0, "ok": 0, "skipped": 0, "blank": 0}
            self.heartbeat = time.time()
            return item

    def finish_item(self, gen: int, item: dict, verdict: str, detail: str,
                    file: str) -> None:
        """Record one finished document and move the queue forward."""
        with self.lock:
            if gen != self.generation:
                return
            self.queue_done += 1
            self.results.append({
                "url": item.get("url", ""),
                "title": os.path.basename(file or "") or item.get("url", ""),
                "file": file or "",
                "verdict": verdict,
                "detail": detail,
            })
            self.current = ""
            self.heartbeat = time.time()
            self.progress = {"page": self.queue_done, "of": self.queue_total,
                             "ok": self.queue_done, "skipped": 0, "blank": 0}

    def close_queue(self, gen: int) -> None:
        """The queue is empty: one honest verdict for the whole batch."""
        with self.lock:
            if gen != self.generation or self.state != "running":
                return
            built = sum(1 for row in self.results if row["verdict"] == "PDF BUILT")
            partial = sum(1 for row in self.results if row["verdict"] == "PDF PARTIAL")
            other = len(self.results) - built - partial
            last_file = next((row["file"] for row in reversed(self.results)
                              if row["file"]), "")
            if built and not partial and not other:
                self.verdict = "PDF BUILT"
            elif built or partial:
                self.verdict = "PDF PARTIAL"
            else:
                self.verdict = "FAILED"
            if len(self.results) == 1:
                # one book keeps its own verdict and detail, not "0 of 1 built"
                self.verdict = self.results[0]["verdict"] or self.verdict
                self.detail = self.results[0]["detail"] or self.verdict
            else:
                self.detail = (f"{built} of {len(self.results)} document(s) built"
                               + (f", {partial} partial" if partial else "")
                               + (f", {other} failed" if other else ""))
            self.file = last_file
            self.current = ""
            self.state = "done"
            self.ended = time.time()

    def snapshot(self) -> dict:
        with self.lock:
            return {"state": self.state, "verdict": self.verdict,
                    "detail": self.detail, "url": self.url,
                    "progress": dict(self.progress), "file": self.file,
                    "title": self.title,
                    "seconds": round((self.ended or time.time()) - self.started, 1)
                    if self.started else 0,
                    "log": list(self.lines)[-200:],
                    "cookies": cookie_report(find_cookies()),
                    "queue": {"pending": len(self.queue), "done": self.queue_done,
                              "total": self.queue_total, "current": self.current,
                              "results": list(self.results)[-20:]},
                    "quiet": round(max(0.0, time.time() - self.heartbeat)
                                   if self.state == "running" and self.heartbeat else 0),
                    "stalled": (self.state == "running" and self.heartbeat
                                and time.time() - self.heartbeat > STALL_SECONDS),
                    "stall_after": STALL_SECONDS,
                    "version": VERSION, "sample": SAMPLE}

JOB = Job()

class Gate:
    """A shared token bucket that tells the two kinds of refusal apart.

    A 429/503 is the CDN throttling: pay 30% of the rate. A 403 is a key that
    will 403 however slowly it is asked for, so it only costs 3%.
    """

    def __init__(self, rate: float = 24.0, floor: float = 8.0,
                 ceiling: float = 60.0) -> None:
        self.lock = threading.Lock()
        self.rate = rate
        self.floor = floor
        self.ceiling = ceiling
        self.tokens = 10.0
        self.stamp = time.time()
        self.clean = 0

    def acquire(self) -> None:
        while True:
            with self.lock:
                now = time.time()
                self.tokens = min(16.0, self.tokens + (now - self.stamp) * self.rate)
                self.stamp = now
                if self.tokens >= 1.0:
                    self.tokens -= 1.0
                    return
                wait = (1.0 - self.tokens) / self.rate
            time.sleep(min(wait, 0.2))

    def clean_answer(self) -> None:
        with self.lock:
            self.clean += 1
            if self.clean >= 4:
                self.clean = 0
                self.rate = min(self.ceiling, self.rate * 1.03)

    def complaint(self, status: int) -> None:
        with self.lock:
            if status in HARD_THROTTLE:
                self.clean = 0
                self.rate = max(self.floor, self.rate * 0.70)
            else:
                self.rate = max(self.floor, self.rate * 0.97)

class Sources:
    """page number -> the names seen for it, in the order seen.

    A list, not one name: the document's own name stays first (so good pages
    still cost one request) and a descriptor's name is appended behind it, so a
    stale name can never evict a working one.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.images: dict[int, list[str]] = {}
        self.jsonps: dict[int, list[str]] = {}
        self.folders: set[str] = set()

    @staticmethod
    def _add(table: dict[int, list[str]], number: int, url: str) -> bool:
        bucket = table.setdefault(number, [])
        if url in bucket:
            return False
        bucket.append(url)
        return True

    def merge(self, body: bytes) -> int:
        text = text_of(body)
        changed = 0
        with self.lock:
            for match in JSONP_RE.finditer(text):
                if self._add(self.jsonps, int(match.group(1)), match.group(0)):
                    changed += 1
            for match in IMAGE_RE.finditer(text):
                if self._add(self.images, int(match.group(1)), match.group(0)):
                    changed += 1
        return changed

    def get(self, number: int) -> dict[str, str]:
        with self.lock:
            images = self.images.get(number) or []
            jsonps = self.jsonps.get(number) or []
            return {"image": images[0] if images else "",
                    "jsonp": jsonps[0] if jsonps else ""}

    def images_for(self, number: int) -> list[str]:
        with self.lock:
            return list(self.images.get(number) or [])

    def jsonps_for(self, number: int) -> list[str]:
        with self.lock:
            return list(self.jsonps.get(number) or [])

    def count(self) -> int:
        with self.lock:
            return len(set(self.images) | set(self.jsonps))

    def highest(self) -> int:
        with self.lock:
            both = set(self.images) | set(self.jsonps)
            return max(both) if both else 0

TEXT_OF_JSONP_RE = re.compile(r"^\s*(?:window\.)?[A-Za-z0-9_$.]*call?back?\s*\(|"
                              r"^\s*[A-Za-z0-9_$.]+\s*\(", re.I)
BREAK_TAG_RE = re.compile(r"<\s*(?:br|/p|/div|/li|/h[1-6]|/tr)\s*/?\s*>", re.I)
TAG_STRIP_RE = re.compile(r"<[^>]*>")
SPACE_RE = re.compile(r"[ \t\u00a0]+")


def html_to_text(html: str) -> str:
    """The words of one page out of Scribd's own HTML, line by line.

    Scribd sends each page's text as HTML with <br> and block tags, so breaks
    have to become newlines before the tags are stripped; otherwise the whole
    page becomes one long line and a text layer is useless for selection.
    """
    text = BREAK_TAG_RE.sub("\n", html or "")
    text = TAG_STRIP_RE.sub("", text)
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
                 ("&#39;", "'"), ("&#x27;", "'"), ("&nbsp;", " "),
                 ("&mdash;", "-"), ("&ndash;", "-"), ("&rsquo;", "'"),
                 ("&lsquo;", "'"), ("&ldquo;", '"'), ("&rdquo;", '"')):
        text = text.replace(a, b)
    # blank lines carry no words and only eat the little room a sheet has,
    # so they are dropped: one line of text per line of the page
    lines = [SPACE_RE.sub(" ", line).strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


def text_from_jsonp(body: bytes) -> str:
    """A page's text out of its descriptor: window.pageN_callback([…, "…"])."""
    raw = text_of(body)
    start, end = raw.find("["), raw.rfind("]")
    if start < 0 or end <= start:
        return ""
    try:
        parts = json.loads(raw[start:end + 1])
    except ValueError:
        return ""
    if not isinstance(parts, list):
        return ""
    return html_to_text("".join(part for part in parts if isinstance(part, str)))


def page_count(body: bytes, sources: Sources) -> int:
    text = text_of(body)
    for pattern in (r'"page_count"\s*:\s*(\d+)', r'"totalPages"\s*:\s*(\d+)',
                    r'"pageCount"\s*:\s*(\d+)', r'"pages_count"\s*:\s*(\d+)'):
        match = re.search(pattern, text)
        if match:
            return int(match.group(1))
    return sources.highest()

class Ctx:
    """Everything one document needs: session, names, token, gate, cache."""

    def __init__(self, url: str, jobs: int = 12) -> None:
        self.url = url
        self.jobs = max(1, min(jobs, 32))
        self.ident = doc_id_of(url)
        self.cookie_path = find_cookies()
        self.jar = scribd_only(self.cookie_path)
        self.document_url = f"https://www.scribd.com/document/{self.ident}"
        self.embed_url = f"https://www.scribd.com/embeds/{self.ident}/content"
        self.sources = Sources()
        self.token = Token()
        self.gate = Gate()
        self.dead: set[str] = set()
        self.notes: list[str] = []
        self.notes_lock = threading.Lock()
        self.trace: dict[int, list[str]] = {}
        self.tried: dict[int, set[str]] = {}
        self.rejected: dict[str, int] = {}
        self.trace_lock = threading.Lock()
        self.cache_dir = ""
        self.refresh = False
        self.gen = 0                 # 0 = a job that was not started from the panel
        self.total = 0
        self.title = ""
        self.author = ""
        # the throttle breaker, shared by every worker thread
        self.refuse_lock = threading.Lock()
        self.refused_pages: set[int] = set()
        self.rest_until = 0.0
        self.rests = 0
        self.reliefs = 0

    # -- the throttle breaker ------------------------------------------------
    def rest(self) -> None:
        """Wait out a rest the breaker called, if there is one."""
        wait = self.rest_until - time.time()
        if wait > 0:
            time.sleep(min(wait, 30.0))

    def refused(self, number: int) -> bool:
        """One more 403 on this page. True means "throttled: rest, then again".

        The discriminator is *which* page keeps being refused. One page refused
        over and over while the rest arrive is a locked page — retrying it is
        pointless and resting for it wastes minutes. Different pages refused in
        a row, with nothing succeeding between them, is the address being
        throttled, and resting is the only thing that helps.
        """
        with self.refuse_lock:
            if time.time() < self.rest_until:
                return True                # already resting: do not climb the ladder
            if number in self.refused_pages:
                return False               # the same page again: it is not ours
            self.refused_pages.add(number)
            if len(self.refused_pages) < REFUSALS_IN_A_ROW:
                return False
            pause = PAUSE_LADDER[min(self.rests, len(PAUSE_LADDER) - 1)]
            self.rests += 1
            self.rest_until = time.time() + pause
            self.refused_pages.clear()     # after a rest they get a fair second look
            self.dead.clear()              # a name refused while throttled is not dead
            self.gate.rate = max(self.gate.floor, self.gate.rate * 0.75)
        JOB.say(f"refused {REFUSALS_IN_A_ROW} times with nothing succeeding — "
                f"resting {pause:.0f}s and slowing down (that is throttling, "
                f"not a locked page)")
        return True

    def answered(self) -> None:
        """A page arrived: start counting refusals again from zero.

        After a run of good answers the pause ladder steps back down, so one
        throttle early in a big document does not make every later pause long.
        """
        with self.refuse_lock:
            self.refused_pages.clear()
            self.reliefs += 1
            if self.rests and self.reliefs >= 8 and time.time() >= self.rest_until:
                self.rests = max(0, self.rests - 1)
                self.reliefs = 0

    def reload_names(self) -> None:
        """Ask Scribd for the document again before a retry round.

        A retry with the same token and the same names is not a retry, it is the
        same request. This reads the document page and the viewer again, which
        re-harvests the token and any page names the first read did not have.
        """
        before = self.sources.count()
        JOB.say("refreshing the document before retrying: new names, new token")
        if not self.load():
            self.note("retry: the document page did not answer the second time")
            return
        self.note(f"retry: names refreshed ({before} -> {self.sources.count()})")

    def note(self, text: str) -> None:
        with self.notes_lock:
            if text not in self.notes:
                self.notes.append(text)

    def record(self, number: int, url: str, status: int) -> None:
        with self.trace_lock:
            self.trace.setdefault(number, []).append(f"{status:>3}  {url}")
            self.tried.setdefault(number, set()).add(url)

    def keep_reject(self, number: int, data: bytes) -> None:
        """Keep the picture that was refused, so the reason can be checked.

        A rejection nobody can look at is a rumour. The bytes land in
        debug/rejected/ (capped, so a broken document cannot fill the disk) and
        the log says so once.
        """
        if not number or not data:
            return
        folder = os.path.join(JOB.out or OUT, "debug", "rejected")
        try:
            os.makedirs(folder, exist_ok=True)
            if len(os.listdir(folder)) >= 40:
                return
            with open(os.path.join(folder, f"page-{number:04d}.bin"), "wb") as handle:
                handle.write(data)
            self.note(f"page {number}: the refused picture is saved in "
                      "debug/rejected — the log line above says what it was")
        except OSError:
            pass

    def reject(self, data: bytes) -> str:
        """Remember the KIND of file that arrived but could not be read."""
        if data[:2] == b"\xff\xd8":
            kind = "jpeg"
        elif data[:8] == b"\x89PNG\r\n\x1a\n":
            kind = "png"
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            kind = "webp"
        else:
            kind = (data[:8].decode("latin-1", "replace").strip() or "empty")[:12]
        with self.trace_lock:
            self.rejected[kind] = self.rejected.get(kind, 0) + 1
        return kind

    def load(self) -> bool:
        doc = fetch(self.document_url, self.jar)
        if doc["error"]:
            JOB.say(f"document page: {doc['error']}")
            return False
        JOB.say(f"document page: HTTP {doc['status']}, "
                f"{len(doc['body']) / 1000:.0f} kB, {describe(doc['body'])}")
        embed = fetch(self.embed_url + "?start_page=1&view_mode=scroll", self.jar,
                      referer=self.document_url)
        if embed["error"]:
            JOB.say(f"embed viewer: {embed['error'][:120]} — using the document page")
            embed = {"status": 0, "body": b""}
        else:
            JOB.say(f"embed viewer: HTTP {embed['status']}, "
                    f"{len(embed['body']) / 1000:.0f} kB, {describe(embed['body'])}")

        combined = embed["body"] + doc["body"]
        self.sources.merge(combined)
        self.token.set(harvest_token(combined))
        self.total = page_count(combined, self.sources)
        if not self.total:
            return False
        JOB.say(f"pages: {self.total} found · {self.sources.count()} with a page name")
        JOB.say(token_note(self.token.get()))

        meta = oembed(self.ident, self.jar)
        self.author = safe_name(str(meta.get("author_name") or ""), "")
        self.title = (safe_name(str(meta.get("title") or ""), "")
                      or title_from_html(combined, self.url)
                      or f"scribd-{self.ident}")
        JOB.title = self.title
        JOB.say(f"title: {self.title!r}"
                + (f" · author: {self.author}" if self.author else ""))
        return True

    def primaries_for(self, number: int) -> list[str]:
        """Every plausible name for this page's scan, best first.

        Only names the document itself gave: the scan already in the HTML, and
        the sibling of a descriptor. Each with the real token, and with none.
        """
        token = self.token.get()
        raw_urls = list(self.sources.images_for(number)) + [
            image_url_for(name) for name in self.sources.jsonps_for(number)]
        out: list[str] = []
        for raw in raw_urls:
            if not raw:
                continue
            for candidate in (with_token(raw, token), strip_token(raw)):
                if candidate and candidate not in out:
                    out.append(candidate)
        return out

    def candidates_for(self, number: int, wide: bool = False) -> list[str]:
        """The names above, then the same path on the other asset host.

        wide adds that for every variant. Nothing is invented: no extension
        flips, no folder swaps, no thumbnails pretending to be pages.
        """
        primaries = self.primaries_for(number)
        urls = list(primaries)
        for candidate in primaries:
            other = alternate_host(candidate)
            if other:
                urls.append(other)
                if wide:
                    urls.append(strip_token(other))
        return list(dict.fromkeys(urls))

    def jsonp_variants(self, jsonp: str) -> list[str]:
        token = self.token.get()
        out: list[str] = []
        for candidate in (with_token(jsonp, token), strip_token(jsonp)):
            if candidate:
                out.append(candidate)
        return list(dict.fromkeys(out))

    def assets_in(self, body: bytes, number: int, token: str) -> list[str]:
        """Every scan name in a body that belongs to this page number."""
        out: list[str] = []
        for match in ASSET_RE.finditer(text_of(body)):
            url = match.group(0)
            if f"/{number}-" not in url or not SCAN_RE.search(url):
                continue
            out.append(with_token(url, token))
            out.append(strip_token(url))
            derived = image_url_for(url)
            if derived:
                out.append(derived)
        return list(dict.fromkeys(out))

    def descriptor(self, number: int) -> list[str]:
        """The page's own descriptor — where the real asset name is written."""
        found: list[str] = []
        token = self.token.get()
        for jsonp in self.sources.jsonps_for(number):
            for variant in self.jsonp_variants(jsonp):
                got = fetch(variant, self.jar, referer=self.document_url, timeout=20)
                if got["status"] == 200 and got["body"]:
                    self.sources.merge(got["body"])
                    found += self.assets_in(got["body"], number, token)
                    break
                self.note(f"page {number}: descriptor {variant[:110]} -> "
                          + (got["error"] or http_reason(got)))
        return found

    def deep(self, number: int) -> list[str]:
        """Network fallbacks: the page's own descriptor, then the embed window."""
        found = self.descriptor(number)
        token = self.token.get()
        window = fetch(f"{self.embed_url}?start_page={number}&view_mode=scroll",
                       self.jar, referer=self.document_url, timeout=25)
        if window["status"] == 200 and window["body"]:
            self.sources.merge(window["body"])
            fresh = harvest_token(window["body"])
            if fresh:
                self.token.set(fresh)
                token = self.token.get()
            found += self.assets_in(window["body"], number, token)
        else:
            self.note(f"page {number}: window -> "
                      + (window["error"] or http_reason(window)))
        found += self.primaries_for(number)
        return list(dict.fromkeys(found))

    def page_text(self, number: int) -> str:
        """This page's words, from the descriptor, cached beside the scan.

        Costs one extra request per page, which is why it is opt-in: the words
        are what make the finished PDF searchable and selectable instead of a
        stack of photographs.
        """
        if not self.cache_dir:
            return ""
        cached = os.path.join(self.cache_dir, f"{number:04d}.text")
        if os.path.isfile(cached):
            try:
                with open(cached, encoding="utf-8", errors="replace") as handle:
                    return handle.read()
            except OSError:
                pass
        token = self.token.get()
        names = list(self.sources.jsonps_for(number))
        if not names:                       # scans named, descriptors not
            names = [jsonp for jsonp in
                     (jsonp_from_image(url) for url in self.sources.images_for(number))
                     if jsonp]
        for jsonp in names:
            for variant in ([with_token(jsonp, token), strip_token(jsonp)]
                            if token else [strip_token(jsonp)]):
                if not variant:
                    continue
                self.rest()
                self.gate.acquire()
                got = fetch(variant, self.jar, referer=self.document_url, timeout=20)
                if got["status"] != 200 or not got["body"]:
                    continue
                self.answered()
                words = text_from_jsonp(got["body"])
                if words:
                    try:
                        with open(cached, "w", encoding="utf-8") as handle:
                            handle.write(words)
                    except OSError:
                        pass
                    return words
        return ""

    def cache_path(self, number: int) -> str:
        source = self.sources.get(number)
        stem = (source.get("image") or source.get("jsonp") or str(number)).split("?")[0]
        stem = re.sub(r"[^0-9A-Za-z]+", "-", stem.rsplit("/", 1)[-1])[:48]
        return os.path.join(self.cache_dir, f"{number:04d}-{stem}.bin")

    def attempt(self, url: str, tries: int,
                number: int = 0) -> tuple[dict | None, str, int]:
        """Ask for one name, with the breaker deciding what a 403 means.

        A single 403 with pages succeeding around it is a locked page: give up
        now, quietly. A 403 that arrives with its neighbours is throttling: rest
        the whole job and try that same name again, because it was never dead.
        """
        reason = "no attempt"
        delay = 0.7
        status = 0
        attempt = 0
        budget = tries + REFUSALS_IN_A_ROW      # a rest earns at most this many
        while attempt < budget:
            attempt += 1
            self.rest()
            self.gate.acquire()
            got = fetch(url, self.jar, referer=self.document_url, timeout=25)
            status = got["status"]
            if status == 200 and looks_like_image(got["body"]):
                built = scan_for_pdf(got["body"])
                if built:
                    if built.get("complete") is False and attempt < min(tries, 2):
                        # the CDN cut the transfer: the picture is here but its
                        # tail is not, so ask once more before keeping it
                        reason = "cut short mid-transfer — asking again"
                        time.sleep(delay)
                        continue
                    self.gate.clean_answer()
                    self.answered()
                    built["url"] = url
                    built["bytes"] = len(got["body"])
                    built["raw"] = got["body"]
                    return built, "", status
                self.reject(got["body"])
                self.answered()
                self.keep_reject(number, got["body"])
                return None, f"HTTP 200 — {describe_image(got['body'])}", status
            if got["error"]:
                reason = got["error"]
            else:
                reason = http_reason(got)
                self.gate.complaint(status)
                if status == 403:
                    if not self.refused(number):
                        return None, reason, status   # a locked page
                    continue                           # throttled: rest, then again
                if status not in RETRY_STATUS:
                    return None, reason, status
            if attempt >= tries:
                break
            time.sleep(retry_after(got["headers"]) or delay)
            delay = min(6.0, delay * 1.8)
        return None, reason, status

    def grab(self, number: int, force: bool = False,
             wide: bool = False) -> tuple[int, dict | None, str]:
        if self.gen and not JOB.alive(self.gen):
            return number, None, ""      # a stopped job asks the network for nothing
        path = self.cache_path(number)
        if not force and not self.refresh and os.path.isfile(path):
            try:
                with open(path, "rb") as handle:
                    data = handle.read()
            except OSError:
                data = b""
            built = scan_for_pdf(data)
            if built and (plausible_page(built) or built.get("preview")):
                built["url"] = "cache"
                built["bytes"] = len(data)
                return number, built, ""
            if data:
                try:
                    os.remove(path)        # a cache file that will not parse
                except OSError:
                    pass

        reason = "no candidate name"
        seen: set[str] = set()
        for phase in ("ladder", "deep"):
            candidates = (self.candidates_for(number, wide) if phase == "ladder"
                          else self.deep(number))
            for url in candidates:
                if url in seen:
                    continue
                seen.add(url)
                tries = 1 if url in self.dead else 2
                built, reason, status = self.attempt(url, tries, number)
                self.record(number, url, status)
                if built and (plausible_page(built) or built.get("preview")):
                    raw = built.pop("raw", b"")
                    if raw:
                        try:
                            with open(path, "wb") as handle:
                                handle.write(raw)
                        except OSError:
                            pass
                    built["phase"] = phase
                    return number, built, ""
                if built:
                    self.note(f"page {number}: {built['width']}x{built['height']} "
                              f"from {url[:100]} is not a page scan — ignored")
                    reason = f"{built['width']}x{built['height']} is not a page"
                if status == 403:
                    self.dead.add(url)
        self.note(f"page {number}: {len(seen)} name(s) tried, nothing usable came "
                  f"back ({reason})")
        return number, None, f"page {number}: {reason}"

def run_job(url: str | list[str], limit: int = 0, out: str = OUT, jobs: int = 12,
            refresh: bool = False, name: str = "", check: bool = True,
            placeholder: bool = True, probe_page: int = 0,
            verify: bool = True, text: bool = False, gen: int = 0,
            note: str = "") -> None:
    urls = [str(item).strip() for item in
            (url if isinstance(url, (list, tuple)) else [url])
            if str(item or "").strip()]
    if gen:
        # /run already claimed the slot, so its progress must not be wiped here
        with JOB.lock:
            JOB.url = urls[0] if urls else ""
            JOB.out = out
    else:
        gen = JOB.begin()
        with JOB.lock:
            JOB.url = urls[0] if urls else ""
            JOB.out = out
    os.makedirs(out, exist_ok=True)
    if note:
        JOB.say(note)
    try:
        if not urls:
            with JOB.lock:
                JOB.verdict = "BAD LINK"
                JOB.detail = "no link given"
        elif probe_page:
            _probe(urls[0], probe_page)
        elif len(urls) > 1:
            _batch(urls, limit, out, jobs, refresh, check, placeholder, verify,
                   text, gen)
        else:
            _download(urls[0], limit, out, jobs, refresh, name, check, placeholder,
                      verify, text, gen)
    except Exception as exc:  # noqa: BLE001
        JOB.say(f"crashed: {exc!r}")
        with JOB.lock:
            JOB.verdict = "FAILED"
            JOB.detail = repr(exc)[:180]
    finally:
        with JOB.lock:
            # a reset or a takeover may already have closed this job: never
            # reopen it, and never let it narrate the job that replaced it
            owner = JOB.generation == gen and JOB.state == "running"
            if owner:
                JOB.state = "done"
                JOB.ended = time.time()
            verdict, detail = JOB.verdict, JOB.detail
        if owner:
            JOB.say("")
            JOB.say(f"== {verdict} — {detail}")

def run_queue(gen: int, out: str, note: str = "") -> None:
    """Download the queue, one document at a time, until it is empty.

    One document at a time is the whole point: the panel has one connection
    budget and one output folder, and Scribd throttles by address anyway. What
    the queue buys is the other half of the feature — you can keep searching and
    tick more books while the current one downloads, and they are appended here
    instead of being refused.
    """
    os.makedirs(out, exist_ok=True)
    if note:
        JOB.say(note)
    while True:
        item = JOB.next_item(gen)
        if item is None:
            break
        url = str(item.get("url") or "")
        with JOB.lock:
            index = JOB.queue_done + 1
            total = JOB.queue_total
            JOB.url = url
            JOB.verdict = ""
            JOB.detail = ""
            JOB.file = ""
        JOB.say("")
        JOB.say(f"=== document {index} of {total}: {url}")
        try:
            _download(url, int(item.get("limit") or 0), out,
                      int(item.get("jobs") or PANEL_JOBS), False, "",
                      True, True, True, bool(item.get("text")), gen)
        except Exception as exc:  # noqa: BLE001
            JOB.say(f"crashed on {url}: {exc!r}")
            with JOB.lock:
                JOB.verdict = "FAILED"
                JOB.detail = repr(exc)[:180]
                JOB.file = ""
        with JOB.lock:
            verdict, detail, file = JOB.verdict, JOB.detail, JOB.file
        JOB.finish_item(gen, item, verdict, detail, file)

    if not JOB.alive(gen):
        return                        # stopped or taken over: say nothing
    JOB.close_queue(gen)
    with JOB.lock:
        verdict, detail = JOB.verdict, JOB.detail
    JOB.say("")
    JOB.say(f"== {verdict} — {detail}")


def _batch(urls: list[str], limit: int, out: str, jobs: int = 12,
           refresh: bool = False, check: bool = True, placeholder: bool = True,
           verify: bool = True, text: bool = False, gen: int = 0) -> None:
    """Several documents, one after another, with one honest verdict at the end.

    Each link goes through exactly the same _download path as a single link, so
    a batch can never behave differently from the one-document case.
    """
    total = len(urls)
    built = partial = broken = 0
    lines: list[str] = []
    last_file = ""
    for index, link in enumerate(urls, start=1):
        if gen and not JOB.alive(gen):
            JOB.say("stopped before the next document")
            break
        JOB.say("")
        JOB.say(f"=== document {index} of {total}: {link}")
        with JOB.lock:
            JOB.url = link
        try:
            _download(link, limit, out, jobs, refresh, "", check, placeholder,
                      verify, text, gen)
        except Exception as exc:  # noqa: BLE001
            JOB.say(f"crashed on {link}: {exc!r}")
            broken += 1
            lines.append(f"{index}. FAILED — {link}")
            continue
        verdict = JOB.verdict
        if verdict == "PDF BUILT":
            built += 1
            last_file = JOB.file or last_file
        elif verdict == "PDF PARTIAL":
            partial += 1
            last_file = JOB.file or last_file
        else:
            broken += 1
        lines.append(f"{index}. {verdict} — {os.path.basename(JOB.file or '') or link}")
        JOB.set_progress(page=index, of=total)
        with JOB.lock:
            JOB.title = f"document {index} of {total}"
    if gen and not JOB.alive(gen):
        return                       # a reset ended this batch; leave it ended
    with JOB.lock:
        if built == total:
            JOB.verdict = "PDF BUILT"
        elif built or partial:
            JOB.verdict = "PDF PARTIAL"
        else:
            JOB.verdict = "FAILED"
        JOB.file = last_file
        JOB.detail = (f"{built} of {total} document(s) built"
                      + (f", {partial} partial" if partial else "")
                      + (f", {broken} failed" if broken else ""))
    JOB.say("")
    for line in lines:
        JOB.say("  " + line)


def _probe(url: str, number: int) -> None:
    ctx = Ctx(url)
    if not ctx.ident:
        with JOB.lock:
            JOB.verdict = "BAD LINK"
            JOB.detail = "no document id in that URL"
        return
    if not ctx.load():
        with JOB.lock:
            JOB.verdict = "NO PAGES"
            JOB.detail = "the page named no pages"
        return
    JOB.say(f"probe: page {number} · token "
            f"{ctx.token.get()[:44] if ctx.token.get() else 'none'}")
    for name in ctx.sources.images_for(number):
        JOB.say(f"probe: document names {name[:140]}")
    for jsonp in ctx.sources.jsonps_for(number):
        JOB.say(f"probe: descriptor {jsonp[:140]}")
        for variant in ctx.jsonp_variants(jsonp):
            got = fetch(variant, ctx.jar, referer=ctx.document_url, timeout=20)
            JOB.say(f"  {got['status']:>3} {len(got['body']):>7} B  {variant[:140]}"
                    + (f"   {http_reason(got)}" if got["status"] != 200 else ""))
            if got["status"] == 200 and got["body"]:
                JOB.say("        body: "
                        + got["body"][:500].decode("latin-1", "replace")
                        .replace("\n", " "))
    for candidate in ctx.deep(number) + ctx.candidates_for(number, True):
        got = fetch(candidate, ctx.jar, referer=ctx.document_url, timeout=20)
        size = len(got["body"])
        mark = "IMAGE" if looks_like_image(got["body"]) else "     "
        detail = ""
        if mark == "IMAGE":
            built = scan_for_pdf(got["body"])
            detail = (f"  {built['width']}x{built['height']}"
                      f" rot {built.get('rotate', 1)}"
                      + (", small preview" if built.get("preview") else "")
                      + ("" if built.get("complete", True) else ", cut short")
                      if built else f"  {describe_image(got['body'])}")
        JOB.say(f"  {mark} {got['status']:>3} {size / 1000:8.1f} kB  {candidate[:150]}"
                + (detail or (f"   {http_reason(got)}" if mark == "     " else "")))
    with JOB.lock:
        JOB.verdict = "PROBE DONE"
        JOB.detail = f"page {number}"

def _download(url: str, limit: int, out: str, jobs: int = 12,
              refresh: bool = False, name: str = "", check: bool = True,
              placeholder: bool = True, verify: bool = True,
              text: bool = False, gen: int = 0) -> None:
    ctx = Ctx(url, jobs)
    ctx.refresh = refresh
    ctx.gen = gen or JOB.generation
    if not ctx.ident:
        with JOB.lock:
            JOB.verdict = "BAD LINK"
            JOB.detail = "no document id in that URL"
        return
    JOB.say(f"document {ctx.ident} · {socket.gethostname()} · python "
            f"{sys.version.split()[0]} · {cookie_report(ctx.cookie_path)}")
    if not ctx.load():
        with JOB.lock:
            JOB.verdict = "NO PAGES"
            JOB.detail = ("the page named no pages — is the session logged in?"
                          if ctx.total == 0 else "nothing to do")
        JOB.say("no page count and no page descriptors found")
        return

    with_limit = min(ctx.total, limit) if limit else ctx.total
    JOB.say(("downloading the first %d" % with_limit) if limit
            else "downloading the whole document")
    JOB.set_progress(page=0, of=with_limit, ok=0, skipped=0, blank=0)

    ctx.cache_dir = os.path.join(out, "cache", ctx.ident)
    os.makedirs(ctx.cache_dir, exist_ok=True)
    os.makedirs(os.path.join(out, "debug"), exist_ok=True)

    collected: dict[int, dict] = {}
    failed: list[int] = []
    done = 0
    with ThreadPoolExecutor(max_workers=ctx.jobs) as pool:
        futures = [pool.submit(ctx.grab, number)
                   for number in range(1, with_limit + 1)]
        for future in as_completed(futures):
            if not JOB.alive(ctx.gen):
                for pending in futures:
                    pending.cancel()
                JOB.say("stopped — no more pages requested")
                return
            number, built, message = future.result()
            done += 1
            if message:
                JOB.say(message)
            if built:
                collected[number] = built
            else:
                failed.append(number)
            JOB.set_progress(page=done, ok=len(collected), skipped=len(failed))
            if done % 25 == 0 or done == with_limit:
                spent = max(0.001, time.time() - JOB.started)
                rate = done / spent
                left = (with_limit - done) / rate if rate else 0
                JOB.say(f"… {done}/{with_limit} pages, {len(collected)} ok"
                        + (f", {len(failed)} failed" if failed else "")
                        + f" · {rate:.1f} pages/s · gate {ctx.gate.rate:.1f}/s"
                        + (f" · about {left:.0f} s left" if left > 1 else ""))

    # ---- retries, on a budget -------------------------------------------
    # A page Scribd refuses is refused for a reason (not this account, or the
    # address is throttled). Retrying is worth a minute; it is not worth ten.
    # Everything already fetched is kept, the missing pages go in as labelled
    # placeholders, and the PDF still lands.
    recovered_last = -1
    spent = 0.0
    for round_number, pause in ((1, 2.0), (2, 8.0), (3, 20.0)):
        if not failed:
            break
        if not JOB.alive(ctx.gen):
            break
        if round_number > 1 and recovered_last == 0:
            JOB.say(f"retry {round_number - 1} recovered nothing — not resting again")
            break
        if spent + pause > RETRY_BUDGET:
            JOB.say(f"retry budget spent ({spent:.0f}s of {RETRY_BUDGET:.0f}s) — "
                    f"building the PDF with {len(failed)} placeholder page(s)")
            break
        JOB.say(f"retry {round_number}: {len(failed)} page(s), resting {pause:.0f}s")
        time.sleep(pause)
        spent += pause
        # a retry with the same names and the same token is the same request
        ctx.reload_names()
        ctx.dead.clear()
        still: list[int] = []
        for number in sorted(failed):
            if not JOB.alive(ctx.gen):
                still.append(number)
                continue
            _n, built, _message = ctx.grab(number, force=True, wide=True)
            if built:
                collected[number] = built
                JOB.say(f"page {number}: recovered on retry {round_number}")
            else:
                still.append(number)
        recovered = len(failed) - len(still)
        recovered_last = recovered
        JOB.say(f"retry {round_number}: {recovered} recovered, {len(still)} still missing")
        failed = still
        JOB.set_progress(ok=len(collected), skipped=len(failed))

    # ---- pictures that arrived, but not as a full scan -------------------
    previews = sorted(number for number, page in collected.items()
                      if page.get("preview"))
    cuts = sorted(number for number, page in collected.items()
                  if page.get("complete") is False)
    if previews:
        sample = collected[previews[0]]
        JOB.say(f"{len(previews)} page(s) were only served as a small preview "
                f"({sample['width']}x{sample['height']}) — no larger copy came "
                "under any name; they are in the PDF, filled to the sheet")
    if cuts:
        JOB.say(f"{len(cuts)} page(s) still arrived cut short after a retry — "
                "kept, but part of each picture may show grey")

    # ---- one document, one page size ------------------------------------
    # The size is the MEDIAN of the scans, so a single odd page cannot shape the
    # book. Pages that miss it are refetched once; if most pages miss it, the
    # document simply has mixed page sizes and every sheet keeps its own.
    # Previews are excluded: a low-resolution copy is not this book's page size.
    reference = (0, 0)
    if collected:
        reference = median_page([page for page in collected.values()
                                 if not page.get("preview")]
                                or list(collected.values()))
    mixed = False
    if check and reference[0] and len(collected) >= 8:
        offenders = [
            number for number, page in collected.items()
            if not page.get("preview")
            and (abs(page["width"] / reference[0] - 1) > SIZE_TOLERANCE
                 or abs(page["height"] / reference[1] - 1) > SIZE_TOLERANCE)]
        if len(offenders) > len(collected) * 0.2:
            mixed = True
            JOB.say(f"size check: {len(offenders)} of {len(collected)} pages differ "
                    f"from {reference[0]}x{reference[1]} — this document has mixed "
                    "page sizes, so every sheet keeps its own size")
        elif offenders:
            JOB.say(f"size check: {len(offenders)} page(s) are not "
                    f"{reference[0]}x{reference[1]} — refetching")
            for number in sorted(offenders)[:MAX_REFETCH]:
                _n, built, _m = ctx.grab(number, force=True, wide=True)
                if not built:
                    continue
                old = collected[number]
                if (abs(built["width"] / reference[0] - 1)
                        + abs(built["height"] / reference[1] - 1)) < (
                        abs(old["width"] / reference[0] - 1)
                        + abs(old["height"] / reference[1] - 1)):
                    collected[number] = built
                    JOB.say(f"  page {number}: {old['width']}x{old['height']}"
                            f" -> {built['width']}x{built['height']}")
            JOB.set_progress(ok=len(collected))

    # ---- the words of each page, so the PDF is not just photographs --------
    texts: dict[int, str] = {}
    if text and collected:
        JOB.say("text: asking for each page's words (one extra request per page)")
        for number in sorted(collected):
            words = ctx.page_text(number)
            if words:
                texts[number] = words
        JOB.say(f"text: {len(texts)} of {len(collected)} page(s) had words")

    uniform = check and not mixed and bool(collected)
    sheets = sheet_list(collected, with_limit, placeholder)
    if uniform:
        sheet = house_sheet([page for page in sheets if page])
    elif reference[0]:
        sheet = (round(reference[0] * 0.75, 2), round(reference[1] * 0.75, 2))
    else:
        sheet = (0.0, 0.0)

    with open(os.path.join(out, "debug", "pages.txt"), "w") as handle:
        handle.write(f"document {ctx.ident} · title {ctx.title!r} · "
                     f"author {ctx.author!r}\n")
        handle.write(f"pages in document: {ctx.total} · used: {len(collected)}"
                     f" · placeholder: {sum(1 for s in sheets if s is None)}\n")
        handle.write(f"page size: {reference[0]}x{reference[1]} px · "
                     f"sheet {sheet[0]}x{sheet[1]} pt · "
                     f"uniform: {uniform}\n")
        if ctx.rejected:
            handle.write("arrived but unreadable: "
                         + ", ".join(f"{count} {kind}" for kind, count in
                                     sorted(ctx.rejected.items())) + "\n")
        for number in range(1, with_limit + 1):
            page = collected.get(number)
            if page:
                handle.write(f"{number:4d}  {page['width']}x{page['height']}"
                             f"  rot {page.get('rotate', 1)}"
                             f"  {page.get('bytes', 0) / 1000:7.0f} kB"
                             f"  [{page.get('phase', '?')}]"
                             f"  {page.get('url', '')[:130]}\n")
            else:
                handle.write(f"{number:4d}  PLACEHOLDER\n")
        if ctx.notes:
            handle.write("\nnotes:\n" + "\n".join(sorted(ctx.notes)) + "\n")

    if failed:
        with open(os.path.join(out, "debug", "failed-pages.txt"), "w") as handle:
            handle.write(f"document {ctx.ident} · {len(failed)} page(s) failed\n")
            for number in sorted(failed):
                handle.write(f"\npage {number} — every name tried, and its answer:\n")
                for line in ctx.trace.get(number, []):
                    handle.write("  " + line + "\n")
            if ctx.notes:
                handle.write("\nnotes:\n" + "\n".join(sorted(ctx.notes)) + "\n")
        with open(os.path.join(out, "debug", "missing-pages.txt"), "w") as handle:
            handle.write(", ".join(str(n) for n in failed) + "\n")
        codes: dict[str, int] = {}
        for number in failed:
            for line in ctx.trace.get(number, []):
                parts = line.split()
                code = parts[0] if parts else "?"
                codes[code] = codes.get(code, 0) + 1
        order = sorted(codes.items(), key=lambda row: -row[1])[:4]
        JOB.say("why: " + " · ".join(f"{count} answer(s) {code}"
                                     for code, count in order))
        if codes.get("403", 0) >= sum(codes.values()) * 0.6:
            JOB.say("     403 is the only answer: either those pages are not for "
                    "this account, or Scribd is still throttling this address — "
                    "run it again later, the finished pages are cached")
        if ctx.rejected:
            JOB.say("     arrived but unreadable: "
                    + ", ".join(f"{count} {kind}" for kind, count in
                                sorted(ctx.rejected.items())))
        for number in sorted(failed)[:3]:
            lines = ctx.trace.get(number, [])
            names = len(ctx.tried.get(number, ()))
            JOB.say(f"page {number}: {names} name(s) tried, "
                    f"nothing usable came back ({len(lines)} request(s))")
            for line in lines[:4]:
                JOB.say("   " + line)

    if not collected:
        kinds = ", ".join(f"{count} {kind}" for kind, count in
                          sorted(ctx.rejected.items(), key=lambda row: -row[1]))
        if ctx.rejected:
            why = (f"{sum(ctx.rejected.values())} page file(s) arrived but none could "
                   f"be read as a scan ({kinds})")
            if "webp" in ctx.rejected:
                why += (" · webp needs Pillow: this build reads jpeg and png alone. "
                        "Run --probe 1 to see the file that arrived")
        else:
            why = ("no page scan could be fetched — see downloads/debug/"
                   + ("" if ctx.token.get() else
                      " · no image token was on the page: open the document while "
                      "logged in, then reload it"))
        with JOB.lock:
            JOB.verdict = "NO PAGES"
            JOB.detail = why
        for number in sorted(ctx.tried)[:3]:
            JOB.say(f"page {number}: {len(ctx.tried[number])} name(s) tried")
            for line in ctx.trace.get(number, [])[:3]:
                JOB.say("   " + line)
        return

    stem = safe_name(name, "") or ctx.title or f"scribd-{ctx.ident}"
    target = os.path.join(out, f"{stem}.pdf")
    suffix = 2
    while os.path.exists(target) and suffix <= 50:
        target = os.path.join(out, f"{stem} ({suffix}).pdf")
        suffix += 1

    ok, note_text = build_pdf(sheets, target, title=ctx.title, author=ctx.author,
                              uniform=uniform, texts=texts)
    if not ok:
        with JOB.lock:
            JOB.verdict = "FAILED"
            JOB.detail = note_text
        return

    if verify:
        sound, report = verify_pdf(target, expect_pages=len(sheets),
                                   expect_images=len(collected), uniform=uniform)
        JOB.say("verify: " + report)
        if not sound:
            with JOB.lock:
                JOB.file = target
                JOB.verdict = "PDF BROKEN"
                JOB.detail = f"{os.path.basename(target)} — {report}"
            return

    with JOB.lock:
        JOB.file = target
        JOB.verdict = "PDF BUILT" if not failed else "PDF PARTIAL"
        asked = with_limit if limit else ctx.total
        JOB.detail = (f"{note_text} · {len(collected)} of {asked} page(s) real"
                      + (f" of {ctx.total} in the document" if limit and
                         with_limit < ctx.total else "")
                      + (f" · {len(failed)} placeholder" if failed else "")
                      + (f" · {len(previews)} small preview" if previews else "")
                      + (f" · {len(cuts)} cut short" if cuts else "")
                      + (" · verified" if verify else ""))
    if failed:
        JOB.say("placeholder pages: " + ", ".join(str(n) for n in failed[:60])
                + (" …" if len(failed) > 60 else ""))
        JOB.say("why, page by page: downloads/debug/failed-pages.txt")

    # a small disk fills up quietly; say what was cleaned instead of hiding it
    for line in prune_out(out):
        JOB.say(line)
        JOB.say("to see every name and answer for one of them: --probe <page>")
    JOB.say(f"written: {target}")

# ---------------------------------------------------------------------------
# find — Scribd's OWN search, so no search engine can refuse the request
# ---------------------------------------------------------------------------
FIND_URL = "https://www.scribd.com/search/query"
FIND_REFERER = "https://www.scribd.com/search"
FIND_PER_PAGE = 40                 # measured: 40 documents on a page of results
FIND_MAX_PAGE = 40                 # a stop, so a typo cannot walk the whole index


def search_url(query: str, page: int = 1) -> str:
    """The request Scribd's own search page makes.

    /search is a JavaScript app, but it does not search on the page: it asks
    /search/query and renders the JSON that comes back. This is that same
    request, so the answers come from Scribd itself — no search engine in the
    way, and none of the engine blocking that made the old panel search fail.
    """
    params = {"query": " ".join((query or "").split()), "verbatim": "true",
              "ct_lang": "0"}
    if page > 1:
        params["page"] = str(page)
    return FIND_URL + "?" + urllib.parse.urlencode(params)


def documents_in(payload) -> list:
    """The list of documents inside Scribd's answer, wherever it is nested."""
    node = payload
    for key in ("results", "documents", "content", "documents"):
        node = node.get(key) if isinstance(node, dict) else None
        if node is None:
            break
    if isinstance(node, list):
        return [item for item in node if isinstance(item, dict)]
    # the shape moved? take the first list of documents that names a reader_url
    queue = [payload]
    while queue:
        item = queue.pop(0)
        if isinstance(item, dict):
            queue.extend(item.values())
        elif isinstance(item, list):
            if any(isinstance(x, dict) and "reader_url" in x for x in item[:5]):
                return [x for x in item if isinstance(x, dict)]
            queue.extend(item)
    return []


def hit_from(doc: dict) -> dict:
    """One search result, in the shape the page and the downloader both use."""
    url = str(doc.get("reader_url") or doc.get("url") or "").strip()
    if url and not re.search(r"(?:^|\.)scribd\.com/", url, re.I):
        return {}
    if url:
        url = url.split("?")[0].split("#")[0]
    ident = str(doc.get("id") or "").strip() or doc_id_of(url)
    if not ident.isdigit():
        return {}
    if not url:
        url = f"https://www.scribd.com/document/{ident}"
    author = ""
    authors = doc.get("authors")
    if isinstance(authors, list) and authors and isinstance(authors[0], dict):
        author = str(authors[0].get("name") or "").strip()
    if not author and isinstance(doc.get("author"), dict):
        author = str(doc["author"].get("name") or "").strip()
    try:
        pages = int(doc.get("pageCount") or 0)
    except (TypeError, ValueError):
        pages = 0
    return {"id": ident,
            "title": " ".join(str(doc.get("title") or "").split())
                     or f"document {ident}",
            "url": url, "pages": pages,
            "views": str(doc.get("views") or "").strip(), "author": author}


def find_refusal(status: int, body: bytes, error: str = "") -> str:
    """Say plainly whether Scribd refused the address or just had no answer."""
    if any(marker in (body or b"").lower() for marker in CHALLENGE):
        return (f"HTTP {status} challenge page — Scribd wants a browser check "
                f"from this address")
    if status in (401, 403, 429, 503):
        return (f"HTTP {status} — Scribd refused the search from this address; "
                f"the download still works, the search has to happen elsewhere")
    if not status:
        return f"no answer ({error or 'connection failed'})"
    return f"HTTP {status}"


def count_in(payload, key: str) -> int:
    """A number Scribd sent, or 0 when it sent nothing usable."""
    value = payload.get(key) if isinstance(payload, dict) else None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    return number if 0 <= number <= 10000000 else 0


PANEL_JOBS = 16              # pages fetched at once; more is not always faster


def as_channels(value, default: int = 0, top: int = 24) -> int:
    """How many pages to fetch at once.

    Each one is a channel: one connection, one page. Scribd throttles per
    address, so past a point extra channels only produce more 403s — the
    download rate stops rising and the log gets noisy. 16 is the measured
    middle for a small container; the panel offers 8, 12, 16 and 24.
    """
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        number = default or PANEL_JOBS
    if number <= 0:
        number = default or PANEL_JOBS
    return max(1, min(number, top))


def as_limit(value, default: int = 0, top: int = 5000) -> int:
    """A page limit from a browser or a shell: 0 means the whole document."""
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return max(0, min(number, top))


def as_page(value, default: int = 1) -> int:
    """A page number from anything a browser or a shell might send."""
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        number = default
    return max(1, min(number, FIND_MAX_PAGE))


SEARCH_STOPWORDS = {"a", "an", "the", "of", "for", "and", "or", "in", "on", "to",
                    "with", "by", "from", "pdf", "part"}


def query_words(query: str) -> list[str]:
    """The words a person actually searched for, without filler."""
    raw = re.split(r"[^0-9a-z]+", (query or "").lower())
    words = [word for word in raw if word and word not in SEARCH_STOPWORDS]
    return list(dict.fromkeys(words))


def title_words(text: str) -> list[str]:
    return [word for word in re.split(r"[^0-9a-z]+", (text or "").lower()) if word]


def rank_hits(hits: list[dict], query: str) -> tuple[list[dict], int]:
    """Order results the way the words were typed, and say which are exact.

    Scribd's own search is deliberately loose — a search for "physics 12th"
    also returns books that merely share a common word, which is why the panel
    used to look like it was answering something nobody asked. Nothing is
    thrown away here: a result that matches every word comes first, a result
    that matches none is kept but marked `match: "none"`, so the page can show
    it as *related* instead of pretending it was the answer.
    """
    words = query_words(query)
    phrase = " ".join((query or "").split()).lower()
    rows: list[tuple[int, int, dict]] = []
    for order, hit in enumerate(hits):
        title = str(hit.get("title") or "").lower()
        author = str(hit.get("author") or "").lower()
        in_title = title_words(title)
        title_set = set(in_title)
        score = 0
        matched = 0
        for word in words:
            if word in title_set:
                score += 12
                matched += 1
            elif any(candidate.startswith(word) for candidate in in_title):
                score += 6
                matched += 1
            elif any(len(word) >= 4 and word.startswith(candidate)
                     for candidate in in_title):
                score += 4
                matched += 1
            elif word in author:
                score += 3
                matched += 1
        if phrase and phrase in title:
            score += 100                      # the exact phrase, first
        if words and matched == len(words):
            score += 20                       # every word, in any order
        if hit.get("pages"):
            score += 1                       # a tie-break that prefers real books
        marked = dict(hit)
        marked["score"] = score
        # an empty query (or one made only of filler words) cannot fail a match
        marked["match"] = ("all" if not words or matched == len(words)
                           else "some" if matched else "none")
        rows.append((score, order, marked))
    rows.sort(key=lambda row: (-row[0], row[1]))
    ordered = [row[2] for row in rows]
    weak = sum(1 for hit in ordered if hit["match"] == "none")
    return ordered, weak


def find_page(query: str, page: int = 1,
              ask=None) -> tuple[list[dict], str, dict]:
    """One page of Scribd's own search.

    Returns (hits, one line saying what happened, what Scribd said about the
    result set). The page number is honoured by Scribd, so "load more" asks for
    page 2, 3, … instead of asking for page 1 again and hoping.
    """
    query = " ".join((query or "").split())
    if not query:
        return [], "type a few words to search for", {}
    page = as_page(page)
    caller = ask or (lambda url: fetch(url, referer=FIND_REFERER))
    got = caller(search_url(query, page)) or {}
    status = int(got.get("status") or 0)
    body = got.get("body") or b""
    if status != 200:
        return [], find_refusal(status, body, str(got.get("error") or "")), {}
    try:
        payload = json.loads(body.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return [], f"the answer was not search data ({describe(body)})", {}
    documents = documents_in(payload)
    hits: list[dict] = []
    seen: set[str] = set()
    for doc in documents:
        hit = hit_from(doc)
        if hit and hit["id"] not in seen:
            seen.add(hit["id"])
            hits.append(hit)
    info = {"page": page, "documents": len(documents),
            "total": count_in(payload, "total_results_count"),
            "pages": count_in(payload, "page_count")}
    if not documents:
        note = ("Scribd answered, but named no documents for that query"
                if page == 1 else "no more documents")
    else:
        hits, weak = rank_hits(hits, query)
        note = f"{len(documents)} document(s)"
        dropped = len(documents) - len(hits)
        if dropped:
            note += f", {dropped} dropped (duplicate or not a Scribd document)"
        if weak:
            note += f", {weak} only loosely related"
    return hits, note, info


def find_documents(query: str, pages: int = 1,
                   limit: int = 0, ask=None) -> tuple[list[dict], list[str]]:
    """Search Scribd itself. Returns (hits, notes) — notes say what happened."""
    query = " ".join((query or "").split())
    if not query:
        return [], ["type a few words to search for"]
    wanted = max(1, min(int(pages or 1), FIND_MAX_PAGE))
    found: dict[str, dict] = {}
    notes: list[str] = []
    for page in range(1, wanted + 1):
        hits, note, info = find_page(query, page, ask)
        if not info:                      # refused, challenged or not search data
            notes.append(f"page {page}: {note}")
            break
        fresh = 0
        for hit in hits:
            if hit["id"] in found:
                continue
            found[hit["id"]] = hit
            fresh += 1
            if limit and len(found) >= limit:
                break
        notes.append(f"page {page}: {info['documents']} document(s), {fresh} new")
        if not info["documents"] or not fresh or (limit and len(found) >= limit):
            break
    return list(found.values()), notes


def print_hits(hits: list[dict]) -> None:
    for number, hit in enumerate(hits, 1):
        extra = " · ".join(part for part in (
            f"{hit['pages']} pages" if hit["pages"] else "",
            f"{hit['views']} views" if hit["views"] else "",
            hit["author"] or "") if part)
        print(f"  {number:2}. {hit['title']}")
        print(f"      {hit['url']}" + (f"   ({extra})" if extra else ""))


def picked_hits(hits: list[dict], spec: str) -> list[dict]:
    """`--pick 1,3` and `--pick 2-4` out of the numbered list."""
    chosen: list[dict] = []
    for part in str(spec or "").replace(" ", ",").split(","):
        if not part:
            continue
        try:
            if "-" in part:
                start, end = part.split("-", 1)
                numbers = range(int(start), int(end) + 1)
            else:
                numbers = [int(part)]
        except ValueError:
            continue
        for number in numbers:
            if 1 <= number <= len(hits) and hits[number - 1] not in chosen:
                chosen.append(hits[number - 1])
    return chosen


# ---------------------------------------------------------------------------
# page
# ---------------------------------------------------------------------------
def queue_links(urls: list[str], limit: int, out: str) -> tuple[bool, str]:
    """Start a download of these links, unless a job is already running."""
    with JOB.lock:
        busy = JOB.state == "running"
    if busy:
        return False, "a download is already running — try again when it finishes"
    if not urls:
        return False, "no Scribd document links in that request"
    threading.Thread(target=run_job, args=(list(urls), limit, out),
                     daemon=True).start()
    return True, f"queued {len(urls)} link(s)"


# ?embed=1: the same panel with the "send links" card and the wide margins
# removed, for the case where it is shown inside another site's frame.
EMBED_CSS = ("body{padding:12px 10px 34px;background:#fff}"
             ".wrap{max-width:none}h1{font-size:17px;margin-bottom:2px}"
             "#bmblock,#bmcard{display:none}")

SEND_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<title>links queued</title><style>
body{font:15px/1.6 ui-monospace,Menlo,Consolas,monospace;background:#fbfbfa;
 color:#1f2328;max-width:760px;margin:40px auto;padding:0 18px}
li{margin:3px 0;word-break:break-all} a{color:#0969da} .muted{color:#57606a}
</style></head><body>
<h3>__HEADLINE__</h3>
<ol>__ROWS__</ol>
<p class="muted">__NOTE__</p>
<p><a href="/">back to the panel</a></p>
</body></html>"""


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>download Scribd documents</title>
<style>
 body{font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:#fbfbfa;color:#1f2328;margin:0;padding:26px 18px 70px}
 .wrap{max-width:1000px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px}
 h2{font-size:14px;margin:26px 0 10px;color:#57606a;font-weight:600;
  text-transform:uppercase;letter-spacing:.04em}
 .meta{color:#57606a;font-size:13px;margin-bottom:14px}
 .card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:16px}
 .card.primary{border-left:5px solid #1f6feb}
 .card.alt{border-left:5px solid #b8c0c8}
 textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px;
  border:1px solid #b8c0c8;border-radius:6px;background:#fff;min-height:96px;
  resize:vertical}
 input[type=number]{width:86px;font:inherit;padding:8px;border:1px solid #b8c0c8;
  border-radius:6px;background:#fff}
 input[type=search]{flex:1 1 260px;min-width:180px;font:inherit;padding:9px 10px;
  border:1px solid #b8c0c8;border-radius:6px;background:#fff}
 .hit{display:flex;gap:10px;align-items:flex-start;padding:7px 2px;
  border-bottom:1px solid #eaeef2;cursor:pointer}
 .hit:last-child{border-bottom:0}
 .hit input{margin-top:5px}
 .hit .t{font-weight:600}
 .hit .m{color:#57606a;font-size:12.5px;word-break:break-all}
 .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0 0}
 button,.btn{font:inherit;padding:9px 16px;border-radius:6px;
  border:1px solid #1f6feb;background:#1f6feb;color:#fff;cursor:pointer;
  text-decoration:none;display:inline-block}
 button.ghost{background:#fff;color:#1f6feb}
 button:disabled{opacity:.45;cursor:default}
 code.bm{display:block;background:#0d1117;color:#e6edf3;padding:11px;
  border-radius:6px;font-size:11.5px;overflow:auto;white-space:nowrap;margin:10px 0}
 .verdict{background:#fff;border:1px solid #d0d7de;border-left:5px solid #9a6700;
  padding:13px 15px;margin:18px 0;white-space:pre-wrap;font-size:16px}
 .ok{border-left-color:#1a7f37} .bad{border-left-color:#b42318}
 pre{background:#0d1117;color:#e6edf3;padding:14px;border-radius:8px;
  overflow:auto;max-height:420px;font-size:12.5px;line-height:1.45;margin:0}
 .muted{color:#57606a;font-size:13px}
 ol.steps{margin:8px 0 0;padding-left:22px} ol.steps li{margin:5px 0}
 a{color:#0969da}
 select{font:inherit;padding:8px 10px;border:1px solid #b8c0c8;border-radius:6px;
  background:#fff}
 .tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;
  font-size:11px;font-weight:600;background:#fff4d6;color:#7a4b00;
  border:1px solid #f0d9a8;vertical-align:middle}
 .hit.weak .t{color:#57606a;font-weight:500}
 .actions{display:flex;gap:8px;flex-wrap:wrap}
 @media (max-width:640px){
  body{padding:18px 12px 90px;font-size:15px}
  h1{font-size:18px} h2{margin-top:22px}
  /* 16px stops iOS Safari zooming the whole page when a box is tapped, which
     is what pushed the Find button off the screen on a phone */
  input[type=search],input[type=number],textarea,select,button,.btn{
   font-size:16px;min-height:44px}
  input[type=number]{width:100%}
  .row{gap:8px}
  .row > *{flex:1 1 100%;width:100%}
  .row label.muted{display:flex;justify-content:space-between;align-items:center}
  .row input[type=number]{width:96px;flex:0 0 96px}
  .actions > *{flex:1 1 auto}
  .hit{padding:11px 2px}
  .hit input{width:20px;height:20px;margin-top:1px}
  .hit .m{font-size:12px}
  .verdict{font-size:15px;padding:12px}
  code.bm{white-space:normal;word-break:break-all}
 }
</style><style>__EMBED_CSS__</style></head><body><div class="wrap">
<h1>Download Scribd documents</h1>
<div class="meta" id="meta">ready</div>

<h2>1 · find documents, right here</h2>
<div class="card primary">
  <div class="muted">This asks <b>Scribd's own search</b> — the same request its
  search page makes — so no search engine is involved and none of them can
  refuse this address. Type a few words, tick what you want, press download.</div>
  <div class="row">
    <input type="search" id="q" placeholder="physics 12th"
      autocomplete="off" spellcheck="false">
    <button id="find">Find</button>
    <span class="muted" id="said"></span>
  </div>
  <div class="row">
    <button id="more" class="ghost" hidden>Load more</button>
    <span class="muted" id="shown"></span>
  </div>
  <div id="hits"></div>
  <div class="row actions">
    <button class="ghost" id="markall">Tick all shown</button>
    <button class="ghost" id="untickall">Untick all</button>
    <span class="muted" id="picked">nothing ticked yet</span>
  </div>
  <div class="row">
    <label class="muted">pages <input type="number" id="ticklimit" value="0" min="0"
      title="0 = the whole document"></label>
    <label class="muted" title="how many pages are fetched at once">channels
      <select id="channels">
        <option value="8">8</option>
        <option value="12">12</option>
        <option value="16" selected>16</option>
        <option value="24">24</option>
      </select></label>
    <label class="muted" title="adds each page's real words, so the PDF can be
      searched and copied — one extra request per page"><input type="checkbox"
      id="textlayer"> searchable text</label>
  </div>
  <div class="row">
    <button id="ticked">Download ticked</button>
    <span class="muted">0 pages = the whole document</span>
  </div>
</div>

<h2 id="bmblock">2 · or send links from your browser with one bookmark</h2>
<div class="card alt" id="bmcard">
  <div class="muted">Still the fastest way when you are already searching
  Scribd: your browser finds the links, this panel only receives them.</div>
  <ol class="steps">
    <li>Show your bookmarks bar: <b>Ctrl+Shift+B</b> (Chrome/Edge).</li>
    <li>Drag the blue button below onto the bar. If dragging does nothing, use
        <b>Copy</b>, then make a bookmark and paste it as its address.</li>
    <li>Search Scribd normally in your browser, on the results page you want.</li>
    <li>Click the bookmark. This panel opens with <i>queued N link(s)</i> and the
        downloads start by themselves.</li>
  </ol>
  <div class="row">
    <a class="btn" id="drags" href="__BOOKMARKLET_ATTR__">Send links to this panel</a>
    <button class="ghost" id="copybm">Copy the bookmark</button>
    <span class="muted" id="bmsaid"></span>
  </div>
  <code class="bm" id="bm">__BOOKMARKLET_TEXT__</code>
</div>

<div class="verdict" id="verdict">idle</div>
<div class="row" id="stallrow" hidden>
  <button id="reset" class="ghost">Stop the stuck job</button>
  <span class="muted" id="stallsaid"></span>
</div>
<div id="file" class="muted"></div>
<pre id="log">(no output yet)</pre>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
let timer = null;

async function poll() {
  let s;
  try {
    s = await (await fetch('/status', {cache: 'no-store'})).json();
  } catch (e) {
    $('meta').textContent = 'the panel did not answer — retrying';
    return;
  }
  $('log').textContent = s.log.length ? s.log.join('\\n') : '(no output yet)';
  const p = s.progress;
  const q = s.queue || {pending: 0, done: 0, total: 0};
  const queueText = q.total > 1
    ? ` · book ${Math.min(q.done + 1, q.total)}/${q.total}`
      + (q.pending ? ` (${q.pending} waiting)` : '')
    : '';
  $('meta').textContent = `${s.state} · ${s.seconds}s${queueText} · page ${p.page}/${p.of}`
    + ` · ${p.ok} ok` + (p.skipped ? ` · ${p.skipped} retrying` : '')
    + ` · ${s.cookies} · v${s.version}`;
  const v = $('verdict');
  v.textContent = s.verdict ? s.verdict + (s.detail ? ' — ' + s.detail : '')
                            : (s.state === 'running' ? 'working…' : 'idle');
  v.className = 'verdict' + (s.verdict === 'PDF BUILT' ? ' ok'
                 : (s.verdict && s.verdict !== 'idle' ? ' bad' : ''));
  $('file').innerHTML = s.file
    ? `saved: <a href="/file">${esc(s.file.split('/').pop())}</a>
       · <a href="/logs">debug files</a>` : '';
  const running = s.state === 'running';
  $('ticked').textContent = running ? 'Add to queue' : 'Download ticked';
  $('stallrow').hidden = !s.stalled;
  if (s.stalled) {
    $('stallsaid').textContent = 'nothing has moved for '
      + Math.round(s.quiet || 0) + 's — the panel will step over it after '
      + Math.round((s.stall_after || 420) / 60) + ' min, or stop it now';
  }
  if (!running && timer) { clearInterval(timer); timer = null; }
}

async function start(payload) {
  const body = Object.assign({jobs: Number($('channels').value) || 16}, payload);
  const r = await fetch('/run', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    $('verdict').textContent = d.error || 'the panel refused that';
    if (d.busy) { $('stallrow').hidden = false; $('stallsaid').textContent = d.error; }
    // keep watching anyway: the job that is running above is still useful to see
    if (!timer) { poll(); timer = setInterval(poll, 1500); }
    return;
  }
  if (timer) clearInterval(timer);
  poll(); timer = setInterval(poll, 1500);
}

// what the current search has shown so far, so "load more" knows where it is
const search = {query: '', page: 0, total: 0, shown: 0, ids: new Set(), more: false};

function hitRow(hit) {
  const wrap = document.createElement('label');
  wrap.className = 'hit';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = hit.url;
  box.dataset.title = hit.title;
  const text = document.createElement('div');
  const extra = [hit.pages ? hit.pages + ' pages' : '', hit.views ? hit.views + ' views' : '',
                 hit.author || ''].filter(Boolean).join(' · ');
  if (hit.match === 'none') wrap.className = 'hit weak';
  text.innerHTML = `<div class="t">${esc(hit.title)}`
    + (hit.match === 'none' ? '<span class="tag">related, not a match</span>' : '')
    + `</div>
    <div class="m">${esc(hit.url)}${extra ? ' · ' + esc(extra) : ''}</div>`;
  wrap.append(box, text);
  box.onchange = countTicked;
  return wrap;
}

function countTicked() {
  const n = document.querySelectorAll('#hits input:checked').length;
  $('picked').textContent = n ? n + ' ticked' : 'nothing ticked yet';
}

function say(d) {
  const pages = d.page > 1 ? `page ${d.page} · ` : '';
  const count = d.total
    ? `showing ${search.shown} of ${d.total} match(es)`
    : `showing ${search.shown}`;
  $('shown').textContent = search.shown ? pages + count : '';
  $('more').hidden = !search.more;
  $('more').textContent = `Load more (page ${d.page + 1})`;
}

async function ask(page) {
  // if the words in the box changed, this is a new search, not a next page
  if (page > 1 && $('q').value.trim() !== search.query) return find();
  $('find').disabled = true;
  $('more').disabled = true;
  const first = page === 1;
  if (first) {
    $('said').textContent = 'asking Scribd…';
    $('hits').innerHTML = '';
    search.query = $('q').value.trim();
    search.page = 0;
    search.total = 0;
    search.shown = 0;
    search.ids = new Set();
    search.more = false;
    say({page: 1, total: 0});
    countTicked();
  }
  try {
    const r = await fetch('/find', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query: search.query, page}),
    });
    const d = await r.json();
    if (d.error) { $('said').textContent = d.error; return; }
    $('said').textContent = (d.notes && d.notes.length ? d.notes.join(' · ') : d.summary);
    let fresh = 0;
    for (const hit of d.hits || []) {
      const id = (hit.url.match(/\/(\d{3,})/) || [])[1] || hit.url;
      if (search.ids.has(id)) continue;          // a re-run must not double the list
      search.ids.add(id);
      $('hits').append(hitRow(hit));
      fresh += 1;
    }
    search.page = d.page || page;
    search.total = d.total || 0;
    search.shown += fresh;
    // more to come when Scribd says so, or when a full page came back and it
    // did not say how many there are at all
    search.more = (search.page < (d.max_page || 40)) && (
      search.total ? search.shown < search.total : (d.documents || 0) >= (d.per_page || 40));
    say({page: search.page, total: search.total});
  } catch (e) {
    $('said').textContent = 'the panel did not answer: ' + e;
  } finally {
    $('find').disabled = false;
    $('more').disabled = false;
    countTicked();
  }
}

function find() {
  if (!$('q').value.trim()) { $('said').textContent = 'type a few words first'; return; }
  ask(1);
}

$('find').onclick = find;
$('more').onclick = () => ask(search.page + 1);
$('q').onkeydown = (e) => { if (e.key === 'Enter') find(); };
$('ticked').onclick = () => {
  const boxes = [...document.querySelectorAll('#hits input:checked')];
  if (!boxes.length) { $('verdict').textContent = 'tick at least one document first'; return; }
  start({urls: boxes.map((b) => b.value),
         limit: Number($('ticklimit').value) || 0,
         text: $('textlayer').checked});
  $('verdict').textContent = 'queued ' + boxes.length + ' document(s) at '
    + (Number($('channels').value) || 16) + ' channels — progress below';
};

$('markall').onclick = () => {
  for (const box of document.querySelectorAll('#hits input')) box.checked = true;
  countTicked();
};
$('untickall').onclick = () => {
  for (const box of document.querySelectorAll('#hits input')) box.checked = false;
  countTicked();
};
$('reset').onclick = async () => {
  $('reset').disabled = true;
  try {
    const d = await (await fetch('/reset', {method: 'POST'})).json();
    $('stallsaid').textContent = d.stopped
      ? 'stopped — you can start a download now'
      : 'nothing was running';
    $('stallrow').hidden = true;
    poll();
  } catch (e) {
    $('stallsaid').textContent = 'the panel did not answer: ' + e;
  } finally {
    $('reset').disabled = false;
  }
};
$('copybm').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('bm').textContent);
    $('bmsaid').textContent = 'copied — paste it as a bookmark address';
  } catch (e) {
    $('bmsaid').textContent = 'copy failed: select the code line and press Ctrl+C';
  }
};
setTimeout(poll, 250);
</script></body></html>"""

def serve(port: int, out: str) -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            pass

        def _send(self, body: bytes, ctype: str, code: int = 200,
                  extra: dict | None = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for name, value in cors_headers(self.headers.get("Origin", "")).items():
                self.send_header(name, value)
            for name, value in (extra or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def _allowed(self, path: str) -> bool:
            """One gate in front of every route, so none can be forgotten."""
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if panel_gate(self.headers, query, self.headers.get("Cookie", "")):
                return True
            if path == "/health":
                return True                      # uptime checks stay open
            if path == "/file" or path.startswith("/file/") or path == "/logs":
                # a signed link (minted by the dashboard) opens one file, briefly
                wanted = (os.path.basename(path) if path.startswith("/file/")
                          else (query.get("name") or [""])[0])
                if wanted and token_ok(urllib.parse.unquote(wanted),
                                       (query.get("e") or [None])[0],
                                       (query.get("t") or [""])[0]):
                    return True
            what = ("application/json" if path not in ("/", "/send", "/logs")
                    else "text/html")
            if what == "application/json":
                self._send(json.dumps({"error": "this panel needs its key: send "
                                                "X-Panel-Key, or open ?key=…"}).encode(),
                           "application/json; charset=utf-8", 401)
            else:
                self._send(b"<h3>This panel is locked.</h3><p>Open it with "
                           b"?key=YOUR_KEY at the end of the address.</p>",
                           "text/html; charset=utf-8", 401)
            return False

        def do_OPTIONS(self) -> None:  # noqa: N802
            """Preflight for a dashboard that calls this panel from a browser."""
            self.send_response(204)
            for name, value in cors_headers(self.headers.get("Origin", "")).items():
                self.send_header(name, value)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
            if not self._allowed(path):
                return
            if path == "/status":
                self._send(json.dumps(JOB.snapshot()).encode(),
                           "application/json; charset=utf-8")
            elif path == "/health":
                # cheap enough for a dashboard to poll, and it says whether the
                # panel is locked so the other side can explain a 401 properly
                self._send(json.dumps({"ok": True, "version": VERSION,
                                       "locked": bool(PANEL_KEY),
                                       "state": JOB.state}).encode(),
                           "application/json; charset=utf-8")
            elif path == "/files":
                self._send(json.dumps({"files": panel_files(out)}).encode(),
                           "application/json; charset=utf-8")
            elif path in ("/file", "/file/") or path.startswith("/file/"):
                target = JOB.file
                if path.startswith("/file/"):
                    wanted = os.path.join(out, os.path.basename(path))
                    target = wanted if os.path.isfile(wanted) else ""
                if not target or not os.path.isfile(target):
                    self._send(b"no file yet", "text/plain", 404)
                    return
                with open(target, "rb") as handle:
                    body = handle.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Content-Disposition",
                                 f'attachment; filename="{os.path.basename(target)}"')
                self.end_headers()
                self.wfile.write(body)
            elif path == "/send":
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                urls = [item.strip() for item in query.get("url", []) if item.strip()]
                ok, message = queue_links(urls, 0, out)
                rows = "".join(f"<li>{html_escape(url)}</li>" for url in urls[:40])
                body = (SEND_PAGE
                        .replace("__HEADLINE__", html_escape(message))
                        .replace("__ROWS__", rows or "<li>nothing</li>")
                        .replace("__NOTE__", "the download is running — this "
                                 "page can be closed" if ok
                                 else "nothing started")).encode()
                self._send(body, "text/html; charset=utf-8", 200 if ok else 409)
            elif path == "/logs" or path.startswith("/logs/"):
                folder = os.path.join(out, "debug")
                if path == "/logs":
                    names = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
                    rows = "".join(f'<li><a href="/logs/{n}">{n}</a></li>' for n in names)
                    self._send(f"<h3>debug files</h3><ul>{rows}</ul>".encode(),
                               "text/html; charset=utf-8")
                    return
                name = os.path.basename(path)
                target = os.path.join(folder, name)
                if not os.path.isfile(target):
                    self._send(b"no such debug file", "text/plain", 404)
                    return
                with open(target, "rb") as handle:
                    body = handle.read()
                self._send(body, "text/plain; charset=utf-8")
            else:
                query = urllib.parse.parse_qs(
                    urllib.parse.urlparse(self.path).query)
                origin = (self.headers.get("X-Forwarded-Proto") and
                          self.headers.get("X-Forwarded-Host") and
                          f"{self.headers['X-Forwarded-Proto']}://"
                          f"{self.headers['X-Forwarded-Host']}") or \
                         (f"http://{self.headers.get('Host')}"
                          if self.headers.get("Host") else
                          f"http://localhost:{port}")
                code = bookmarklet(origin)
                embed = (query.get("embed") or [""])[0].lower() in ("1", "true", "yes")
                page = PAGE.replace("__EMBED_CSS__", EMBED_CSS if embed else "")
                extra = {"Set-Cookie": panel_cookie()} if PANEL_KEY else None
                self._send(page
                           .replace("__SAMPLE__", SAMPLE)
                           .replace("__BOOKMARKLET_TEXT__", html_escape(code))
                           .replace("__BOOKMARKLET_ATTR__", html_escape(code))
                           .encode(), "text/html; charset=utf-8", 200, extra)

        def do_POST(self) -> None:  # noqa: N802
            path = urllib.parse.urlparse(self.path).path
            if not self._allowed(path):
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception:  # noqa: BLE001
                payload = {}
            if path == "/find":
                query = str(payload.get("query") or "").strip()
                if not query:
                    self._send(json.dumps(
                        {"error": "type a few words to search for"}).encode(),
                        "application/json", 400)
                    return
                page = as_page(payload.get("page"))
                JOB.say(f"find: {query}" + (f" (page {page})" if page > 1 else ""))
                hits, note, info = find_page(query, page)
                JOB.say("find: " + note
                        + (f" · {info['total']} match(es)" if info.get("total") else ""))
                total = int(info.get("total") or 0)
                documents = int(info.get("documents") or 0)
                if hits and page == 1:
                    summary = f"{len(hits)} document(s) found"
                elif hits:
                    summary = f"+{len(hits)} more on page {page}"
                elif any(word in note for word in ("named no documents", "no more")):
                    summary = ("no documents match that" if page == 1
                               else "no more documents after this point")
                else:
                    summary = "the search did not answer"
                body = json.dumps({"hits": hits, "notes": [note],
                                   "summary": summary, "page": page,
                                   "total": total, "documents": documents,
                                   "max_page": FIND_MAX_PAGE,
                                   "per_page": FIND_PER_PAGE})
                self._send(body.encode(), "application/json; charset=utf-8")
                return
            if path == "/reset":
                # an admin escape hatch: stop a job that is not moving, so the
                # next download is not blocked by it
                stopped = JOB.stop(f"reset from the dashboard after "
                                   f"{int(JOB.quiet_for())}s without progress")
                JOB.say("reset: the running job was stopped" if stopped
                        else "reset: nothing was running")
                self._send(json.dumps({"ok": True, "stopped": stopped}).encode(),
                           "application/json")
                return
            if path != "/run":
                self._send(b'{"error":"unknown endpoint"}', "application/json", 404)
                return
            urls = payload.get("urls")
            if isinstance(urls, str):
                urls = [urls]
            if not isinstance(urls, list) or not urls:
                urls = [payload.get("url")] if payload.get("url") else []
            urls = [str(item).strip() for item in urls if str(item or "").strip()]
            if payload.get("links"):
                urls += links_from_text(str(payload.get("links")))
            urls = list(dict.fromkeys(urls))
            if not urls:
                self._send(b'{"error":"no Scribd document link in that text"}',
                           "application/json", 400)
                return
            limit = as_limit(payload.get("limit"))
            wants_text = bool(payload.get("text"))
            channels = as_channels(payload.get("jobs"))
            items = [{"url": url, "limit": limit, "text": wants_text,
                      "jobs": channels} for url in urls]
            started, gen, note = JOB.enqueue(items)
            if started:
                threading.Thread(target=run_queue, args=(gen, out, note),
                                 daemon=True).start()
            self._send(json.dumps({"ok": True, "queued": len(urls),
                                   "channels": channels,
                                   "started": started,
                                   "pending": JOB.pending()}).encode(),
                       "application/json")

    for line in prune_out(out):
        print(line, flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"open http://0.0.0.0:{port}/ — find documents, or paste a link",
          flush=True)
    print(f"cookies: {cookie_report(find_cookies())}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        server.server_close()

# ---------------------------------------------------------------------------
# selftest / entry
# ---------------------------------------------------------------------------
def selftest() -> str:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + kind + body
                + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF))

    def make_png(width: int, height: int, colour: int, pixels: bytes,
                 filter_kind: int = 0) -> bytes:
        channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour]
        stride = width * channels
        rows = []
        previous = bytes(stride)
        for row in range(height):
            line = pixels[row * stride:(row + 1) * stride]
            if filter_kind == 2:
                line = bytes((line[i] - previous[i]) & 0xFF for i in range(stride))
            rows.append(bytes([filter_kind]) + line)
            previous = pixels[row * stride:(row + 1) * stride]
        header = struct.pack(">IIBBBBB", width, height, 8, colour, 0, 0, 0)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
                + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))

    def make_jpeg(width: int, height: int, components: int = 3,
                  thumbnail: tuple[int, int] | None = None,
                  orientation: int = 0) -> bytes:
        """A JPEG header chain good enough for the size parser, with traps."""
        out = bytearray(b"\xff\xd8")
        if thumbnail or orientation:
            exif = bytearray(b"Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08")
            entries = 1
            exif += struct.pack(">H", entries)
            exif += struct.pack(">HHI", 0x0112, 3, 1)
            exif += struct.pack(">HH", orientation, 0)
            exif += struct.pack(">I", 0)
            payload = bytes(exif)
            out += b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
        if thumbnail:                    # a decoy frame in front of the real one
            tw, th = thumbnail
            out += b"\xff\xc0" + struct.pack(">H", 11) + bytes([8])
            out += struct.pack(">HH", th, tw) + bytes([3]) + b"\x00" * 6
        out += b"\xff\xc0" + struct.pack(">H", 11) + bytes([8])
        out += struct.pack(">HH", height, width) + bytes([components]) + b"\x00" * 6
        out += b"\xff\xda" + b"\x00\x08" + b"\x00" * 6 + b"\x00" * 32 + b"\xff\xd9"
        return bytes(out)

    rgb = bytes([255, 0, 0] * 2 + [0, 0, 255] * 2) * 2
    decoded = png_to_raw(make_png(4, 2, 2, rgb))
    assert decoded is not None and decoded[1:] == (4, 2, 3) and decoded[0] == rgb
    gray = bytes([0, 128, 255, 64] * 2)
    decoded = png_to_raw(make_png(4, 2, 0, gray))
    assert decoded is not None and decoded[1:] == (4, 2, 1) and decoded[0] == gray
    direct = png_for_pdf(make_png(4, 2, 2, rgb, filter_kind=2))
    assert direct is not None and "/Predictor 15" in direct["params"]
    assert zlib.decompress(direct["payload"])[0] == 2

    # ---- the JPEG size trap that made a 402-page book a strip of slivers ----
    real = make_jpeg(1200, 1600)
    assert jpeg_size(real) == (1200, 1600, 3)
    trapped = make_jpeg(1200, 1600, thumbnail=(772, 68))   # decoy in front
    assert jpeg_size(trapped) == (1200, 1600, 3), jpeg_size(trapped)
    tiny = make_jpeg(90, 120)
    assert jpeg_size(tiny) == (0, 0, 0)                    # nothing plausible
    assert jpeg_size(b"\xff\xd8\x00\x00") == (0, 0, 0)
    assert jpeg_size(b"<Error>") == (0, 0, 0)
    assert not plausible_page({"width": 772, "height": 68})
    assert not page_can_be_this_small(772, 68, 90_000)     # 13.7 bits/pixel
    assert page_can_be_this_small(1200, 1600, 90_000)      # 0.4 bits/pixel
    assert page_can_be_this_small(772, 68, 8_000)          # a real strip
    assert not plausible_page({"width": 100, "height": 130})
    assert plausible_page({"width": 1200, "height": 1600})
    assert plausible_page({"width": 1600, "height": 1200})   # a spread
    # ---- EXIF orientation ----
    assert jpeg_orientation(make_jpeg(1200, 1600, orientation=6)) == 6
    assert jpeg_orientation(make_jpeg(1200, 1600)) == 1
    assert jpeg_orientation(b"not a jpeg") == 1

    # ---- what arrived, and whether it is really a page --------------------
    frames, whole = jpeg_frames(real)
    assert frames == [(1200, 1600, 3)] and whole, frames
    assert jpeg_frames(trapped)[0][-1] == (1200, 1600, 3)   # the decoy is not it
    assert jpeg_frames(b"not a jpeg") == ([], False)
    cut = real[:-40]                                        # a transfer cut short
    assert jpeg_frames(cut)[0] == [(1200, 1600, 3)]
    assert jpeg_frames(cut)[1] is False
    assert scan_for_pdf(cut)["complete"] is False
    assert scan_for_pdf(real)["complete"] is True
    # a complete, page-shaped picture smaller than a scan is a page, not a fail
    preview_page = scan_for_pdf(make_jpeg(96, 130))
    assert preview_page and preview_page["preview"] is True, preview_page
    assert preview_page["width"] == 96 and "small preview" in preview_page["label"]
    assert scan_for_pdf(make_jpeg(60, 80)) is None           # that is a smudge
    assert scan_for_pdf(real)["preview"] is False
    # a decoy thumbnail in front of a full page never wins
    assert scan_for_pdf(make_jpeg(1200, 1600, thumbnail=(90, 120)))["preview"] is False
    # the reason line says what arrived instead of "not a page scan"
    assert "below the 200 px floor" in describe_image(make_jpeg(60, 80))
    assert "cut short" in describe_image(cut)
    assert "1200x1600 jpeg" in describe_image(real)
    assert "not an image at all" in describe_image(b"<Error>AccessDenied</Error>")
    assert "empty body" in describe_image(b"")
    # previews never shape the sheet, and they fill it instead of floating in it
    assert house_sheet([{"width": 1200, "height": 1600}] * 5
                       + [{"width": 96, "height": 130, "preview": True}]) == (900.0, 1200.0)
    wide_box = _placement({"width": 96, "height": 130, "rotate": 1, "preview": True},
                          (900.0, 1200.0))
    assert wide_box[1] == 1200.0, wide_box

    # ---- the sheet comes from the median, so one odd page cannot wreck it ----
    normal = [{"width": 1200, "height": 1600} for _ in range(9)]
    odd = normal + [{"width": 772, "height": 68}]
    assert median_page(odd) == (1200, 1600)
    assert median_page(normal) == (1200, 1600)
    assert house_sheet(normal) == (900.0, 1200.0)
    small = {"width": 300, "height": 400, "rotate": 1}
    box = _placement(small, (900.0, 1200.0))
    assert box[0] == 450.0 and box[1] == 600.0, box     # capped at 2x, centred
    assert box[2] == 225.0 and box[3] == 300.0, box
    mixed_pages = ([{"width": 1200, "height": 1600}] * 4
                   + [{"width": 1600, "height": 1200}] * 4)
    assert median_page(mixed_pages) in ((1200, 1600), (1600, 1200))
    assert median_page(mixed_pages) != (1600, 1600)   # no invented sheet size

    jpeg = make_jpeg(64, 32)
    page = scan_for_pdf(jpeg)
    assert page is None or page["width"] == 64       # 64 px is below the floor
    solid = make_jpeg(1200, 1600)
    built = scan_for_pdf(solid)
    assert built and built["width"] == 1200 and built["rotate"] == 1
    rotated = scan_for_pdf(make_jpeg(1200, 1600, orientation=6))
    assert rotated["rotate"] == 6
    assert scan_for_pdf(b"<Error><Code>AccessDenied</Code></Error>") is None

    # ---- cookies: only scribd, never the other sites in an export ----
    import tempfile
    with tempfile.TemporaryDirectory() as work:
        jar_path = os.path.join(work, "cookies.txt")
        stamp = int(time.time()) + 3600
        with open(jar_path, "w") as handle:
            handle.write(f".scribd.com\tTRUE\t/\tFALSE\t{stamp}\t_scribd_session\tabc123\n")
            handle.write(f"#HttpOnly_www.scribd.com\tTRUE\t/\tFALSE\t{stamp}\tscrbd\txyz\n")
            handle.write(f".html.scribdassets.com\tTRUE\t/\tFALSE\t{stamp}\ttok\tqq\n")
            handle.write(f".grok.com\tTRUE\t/\tFALSE\t{stamp}\tsession-id\tSECRET\n")
            handle.write(f".youtube.com\tTRUE\t/\tFALSE\t{stamp}\tSID\tSECRET2\n")
            handle.write(".scribd.com\tTRUE\t/\tFALSE\t1000\told\tgone\n")
        jar = scribd_only(jar_path)
        assert set(jar) == {"_scribd_session", "scrbd", "tok"}, jar
        assert "SECRET" not in "".join(jar.values())
        report = cookie_report(jar_path)
        assert "3 scribd cookie(s)" in report and "NOT sent" in report, report
        assert "SECRET" not in report
        assert cookie_report(os.path.join(work, "nope")) == (
            "no cookies loaded — anonymous")

        # ---- the token: a JS expression is never a token ----
        good = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.sig"
        placeholder = "navigator.userAgent.toLowerCase"
        plain = "puba93cb01f5c7d6a8163631bbd7ce20349"
        assert harvest_token(b'var t="x.jpg?token=' + good.encode() + b'"') == good
        assert harvest_token(b'?token=' + plain.encode()) == plain
        assert harvest_token(b'?token=' + placeholder.encode()) == ""
        assert harvest_token(b"nothing here") == ""
        holder = Token()
        assert holder.set(placeholder) is False and holder.get() == ""
        assert holder.set(good) is True and holder.get() == good
        named = ("https://html.scribdassets.com/abc/images/5-deadbeef.jpg"
                 "?token=" + placeholder)
        assert with_token(named, good).endswith("?token=" + good)
        assert with_token(named, "") == named            # nothing better to give
        assert strip_token(named).endswith("5-deadbeef.jpg")

        # ---- sheets keep the document's numbering ----
        assert sheet_list({1: "a", 3: "c"}, 3, True) == ["a", None, "c"]
        assert sheet_list({1: "a", 3: "c"}, 3, False) == ["a", "c"]

        # ---- build, then read the file back ----
        target = os.path.join(work, "d.pdf")
        tall = scan_for_pdf(make_jpeg(1200, 1600))
        wide = scan_for_pdf(make_jpeg(1600, 1200))
        ok, note = build_pdf([tall, None, wide, tall], target,
                             title="A (B)", author="me")
        assert ok and "placeholder" in note, note
        with open(target, "rb") as handle:
            written = handle.read()
        assert written.startswith(b"%PDF-1.4") and written.rstrip().endswith(b"%%EOF")
        assert b"/Count 4" in written and written.count(b"/Type /Page /Parent") == 4
        assert written.count(b"/DCTDecode") == 3
        assert b"page 2 - scan not available" in written and b"/Info" in written
        boxes = re.findall(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]", written)
        assert len(boxes) == 4 and len(set(boxes)) == 1, boxes
        # the wide page is centred inside the same sheet, never stretched
        assert b"/MediaBox [0 0 900.0 1200.0]" in written

        sound, report = verify_pdf(target, expect_pages=4, expect_images=3)
        assert sound, report                       # 2.3 failed here: counted 0
        assert "3 image stream(s)" in report, report
        assert verify_pdf(target, expect_pages=5, expect_images=3)[0] is False
        assert verify_bytes(written.replace(b"/Count 4", b"/Count 9"),
                          expect_pages=4, expect_images=3)[1].find("/Count says 9") >= 0
        cut = written.find(b"/Subtype /Image")
        marker = written.find(b"stream\n", cut) + len(b"stream\n")
        mangled = written[:marker] + b"\x00" + written[marker + 1:]
        broken, why = verify_bytes(mangled, expect_pages=4, expect_images=3)
        assert not broken and "DCTDecode" in why, why
        assert verify_pdf(os.path.join(work, "nope.pdf"))[0] is False

        # a page that was stored sideways is turned upright, not left lying down
        side = scan_for_pdf(make_jpeg(1200, 1600, orientation=6))
        assert side["rotate"] == 6
        spot = os.path.join(work, "side.pdf")
        assert build_pdf([side], spot)[0]
        with open(spot, "rb") as handle:
            text = handle.read()
        # a sideways scan is turned upright: 1200x1600 stored shows as 1600x1200
        assert b"/MediaBox [0 0 900.0 1200.0]" in text
        assert verify_pdf(spot, expect_pages=1, expect_images=1)[0]
        assert b"0 -675.0 900.0 0 0.0 937.5 cm" in text, text[-400:]

        # every rotation draws the whole box and no more: corners land on the box
        for number, sketch in ((1, "1 0 0 1"), (3, "3 0 0 3"), (6, "6 0 0 6"),
                               (8, "8 0 0 8")):
            box = (300.0, 400.0, 7.0, 11.0)
            matrix = _image_matrix({"rotate": number}, box)
            values = [float(v) for v in matrix.split()[:6]]
            a, b, c, d, e, f = values
            corners = set()
            for u, v in ((0, 0), (1, 0), (0, 1), (1, 1)):
                corners.add((round(a * u + c * v + e, 2), round(b * u + d * v + f, 2)))
            assert corners == {(7.0, 11.0), (307.0, 11.0), (7.0, 411.0),
                               (307.0, 411.0)}, (number, corners)

    # ---- names: taken from the document, never invented ----
    ctx = Ctx("https://www.scribd.com/document/750213011/Physics-12th")
    ctx.token.set(good)
    ctx.sources.merge(
        b'<script>var d={"page_count":402};'
        b'var u="https:\\/\\/html.scribdassets.com\\/abc123def456\\/pages\\/7-deadbeef.jsonp'
        b'?token=' + placeholder.encode() + b'";'
        b'var i="https:\\/\\/html.scribdassets.com\\/abc123def456\\/images\\/8-cafebabe.jpg'
        b'?token=' + placeholder.encode() + b'";</script>')
    assert page_count(b'{"page_count":402}', ctx.sources) == 402
    names = ctx.candidates_for(8)
    assert names[0] == ("https://html.scribdassets.com/abc123def456/images/"
                        "8-cafebabe.jpg?token=" + good), names[0]
    assert names[1] == "https://html.scribdassets.com/abc123def456/images/8-cafebabe.jpg"
    assert not any(n.endswith(".png") for n in names)      # no extension guessing
    assert not any("/pages/" in n for n in names)          # no thumbnail guessing

    page_html = (b'<html><head><meta property="og:title" '
                 b'content="Excel &amp; Succeed: Biology | Scribd">'
                 b'<title>ignored</title></head></html>')
    assert title_from_html(page_html, "u") == "Excel & Succeed Biology"
    assert title_from_html(b"<title>Plain Title - Scribd</title>", "u") == "Plain Title"
    assert safe_name('a/b:c*d?e"f<g>h|i', "x") == "abcdefghi"
    assert doc_id_of("https://www.scribd.com/document/704243478/Excel") == "704243478"
    assert doc_id_of("nonsense") == ""

    # ---- links: a pasted list, and the bookmarklet that fills it ----
    pasted = (
        "https://www.scribd.com/document/750213011/Physics-12th\n"
        "  https://www.scribd.com/document/750213011/Physics-12th?utm_source=x  \n"
        "https://www.scribd.com/presentation/804179430/Book-List#page=3\n"
        "https://example.com/not-scribd\n"
        "https://www.scribd.com/about\n"
        "see also: https://www.scribd.com/ebook/123456789/Some-Book,")
    links = links_from_text(pasted)
    assert links == ["https://www.scribd.com/document/750213011/Physics-12th",
                     "https://www.scribd.com/presentation/804179430/Book-List",
                     "https://www.scribd.com/ebook/123456789/Some-Book"], links
    assert links_from_text("") == []
    assert links_from_text("no links here") == []
    assert links_from_text("https://www.scribd.com/document/123")[0].endswith("/123")

    # the bookmarklet must point at THIS panel, never at scribd.com
    code = bookmarklet("http://195.123.189.187:25811")
    assert code.startswith("javascript:")
    assert '"http://195.123.189.187:25811/send?"' in code, code[:120]
    assert "scribd.com/send" not in code
    assert "/document/" in code and "/presentation/" in code
    assert "querySelectorAll" in code and "%20" not in code
    assert bookmarklet("http://box:8090/").count("/send?") == 1
    # and the page shows it escaped, so the quote does not break the attribute
    assert html_escape('<a href="x">&') == "&lt;a href=&quot;x&quot;&gt;&amp;"

    # ---- find: Scribd's own search answer, not an engine's html ----
    first = search_url("  physics   12th ")
    assert first.startswith("https://www.scribd.com/search/query?"), first
    assert "query=physics+12th" in first and "page=" not in first, first
    assert "page=2" in search_url("physics 12th", 2)
    assert search_url("physics 12th") == first

    answer = {"results": {"documents": {"content": {"documents": [
        {"id": 1, "title": "Physics 12th", "pageCount": 402, "views": "123K",
         "reader_url": "https://www.scribd.com/document/1/Physics-12th?utm=x",
         "authors": [{"name": "someone"}]},
        {"id": 2, "title": "  spaced   title ",
         "reader_url": "https://id.scribd.com/document/2/Spaced",
         "pageCount": "7"},
        {"id": 3, "title": "id but no link"},
        {"id": 4, "title": "elsewhere",
         "reader_url": "https://example.com/document/4"},
    ]}}}, "compilationId": "x"}
    found = [hit for hit in (hit_from(d) for d in documents_in(answer)) if hit]
    assert [hit["id"] for hit in found] == ["1", "2", "3"], found
    assert found[0]["url"] == "https://www.scribd.com/document/1/Physics-12th"
    assert found[0]["pages"] == 402 and found[0]["author"] == "someone"
    assert found[1]["title"] == "spaced title"
    assert found[2]["url"] == "https://www.scribd.com/document/3"  # id is enough
    # a reshaped answer still gives up its documents
    moved = {"payload": [{"node": {"list": [
        {"reader_url": "https://www.scribd.com/document/9/x", "title": "moved"}]}}]}
    assert documents_in(moved)[0]["title"] == "moved"
    assert documents_in({"nothing": 1}) == []
    assert documents_in([]) == []

    # the numbers Scribd sends with the answer: total, pages, which page
    assert count_in({"total_results_count": 1234}, "total_results_count") == 1234
    assert count_in({"total_results_count": "12"}, "total_results_count") == 12
    assert count_in({"total_results_count": -5}, "total_results_count") == 0
    assert count_in({"total_results_count": None}, "total_results_count") == 0
    assert count_in({"total_results_count": 10 ** 12}, "total_results_count") == 0
    assert count_in([], "total_results_count") == 0
    assert count_in({}, "missing") == 0
    assert as_page(2) == 2 and as_page("3") == 3
    assert as_page(0) == 1 and as_page(-9) == 1          # never page zero
    assert as_page(999) == FIND_MAX_PAGE                 # and never the whole index
    assert as_page(None) == 1 and as_page("x") == 1
    assert as_page(float("inf")) == 1                    # a browser could send this

    # ---- search relevance: the words that were typed come first --------
    loose = [
        {"id": "1", "title": "Advanced Engineering Mathematics", "url":
         "https://www.scribd.com/document/1/x", "pages": 400, "views": "", "author": ""},
        {"id": "2", "title": "Physics 12th — complete notes", "url":
         "https://www.scribd.com/document/2/x", "pages": 300, "views": "", "author": ""},
        {"id": "3", "title": "Physics for Scientists", "url":
         "https://www.scribd.com/document/3/x", "pages": 900, "views": "", "author": ""},
    ]
    ranked, weak = rank_hits(loose, "physics 12th")
    assert [hit["id"] for hit in ranked] == ["2", "3", "1"], ranked
    assert [hit["match"] for hit in ranked] == ["all", "some", "none"], ranked
    assert weak == 1 and ranked[0]["score"] > ranked[1]["score"], ranked
    # the exact phrase wins even when Scribd sent it last
    ranked, _ = rank_hits(list(reversed(loose)), "physics 12th")
    assert ranked[0]["id"] == "2", ranked
    # filler words do not count as a mismatch
    ranked, weak = rank_hits(loose[:1], "the book of mathematics")
    assert ranked[0]["match"] == "some" and weak == 0, ranked
    assert query_words("The Physics of 12th, part 2") == ["physics", "12th", "2"]
    assert query_words("   ") == []
    # an empty query never re-orders or marks anything
    ranked, weak = rank_hits(loose, "")
    assert [hit["id"] for hit in ranked] == ["1", "2", "3"] and weak == 0, ranked
    assert as_channels("24") == 24 and as_channels(99) == 24
    assert as_channels(0) == PANEL_JOBS and as_channels("x") == PANEL_JOBS
    assert as_channels(-4) == PANEL_JOBS and as_channels(None) == PANEL_JOBS

    # ---- the queue: one worker, and a second tap is added, not refused ----
    def item(url):
        return {"url": url, "limit": 0, "text": False, "jobs": 8}

    job = Job()
    started, gen, note = job.enqueue([item("https://www.scribd.com/document/1/a")])
    assert started and not note and job.state == "running", (started, gen, note)
    # the book is downloading: ticking another one must not be refused
    started2, gen2, _ = job.enqueue([item("https://www.scribd.com/document/2/b"),
                                     item("https://www.scribd.com/document/3/c")])
    assert not started2 and gen2 == gen, (started2, gen2)
    assert job.pending() == 3 and job.queue_total == 3
    first = job.next_item(gen)
    assert first["url"].endswith("/1/a") and job.current.endswith("/1/a")
    assert job.pending() == 2
    job.finish_item(gen, first, "PDF BUILT", "ok", "/out/one.pdf")
    assert job.queue_done == 1 and job.results[-1]["verdict"] == "PDF BUILT"
    # a stopped job is nobody's worker any more
    assert job.alive(gen)
    job.heartbeat = time.time() - STALL_SECONDS - 5
    assert job.stalled()
    started3, gen3, note3 = job.enqueue([item("https://www.scribd.com/document/4/d")])
    assert started3 and gen3 == gen + 1 and "taking over" in note3, note3
    assert not job.alive(gen) and job.alive(gen3)
    assert job.next_item(gen) is None             # the old worker gets nothing
    assert job.queue_total >= 1                   # the queued work survives
    # finishing the queue gives one verdict for the batch
    while True:
        nxt = job.next_item(gen3)
        if nxt is None:
            break
        job.finish_item(gen3, nxt, "PDF BUILT", "ok", "/out/more.pdf")
    job.close_queue(gen3)
    assert job.state == "done" and job.verdict == "PDF BUILT", job.snapshot()
    assert "document(s) built" in job.detail, job.detail
    # an explicit reset drops what is still waiting, and keeps the reason
    job2 = Job()
    _started, gen4, _ = job2.enqueue([item("https://www.scribd.com/document/5/e")])
    job2.enqueue([item("https://www.scribd.com/document/6/f")])
    assert job2.stop("reset from the dashboard after 900s without progress")
    assert job2.state == "done" and job2.verdict == "STOPPED"
    assert "900s" in job2.detail and not job2.alive(gen4)
    assert job2.pending() == 0 and "dropped from the queue" in job2.detail
    assert job2.stop("again") is False            # nothing left to stop
    assert job2.snapshot()["stalled"] is False
    assert job2.snapshot()["queue"]["total"] >= 2
    # the command line still begins its own job
    job3 = Job()
    assert job3.begin() == 1 and job3.state == "running"
    # a document may spend at most RETRY_BUDGET seconds being retried
    assert 0 < RETRY_BUDGET <= 300, RETRY_BUDGET

    # ---- the disk guard: a small plan must not fill up in silence -------
    keep_root = os.path.join(work, "keep")
    os.makedirs(keep_root, exist_ok=True)
    old_pdf = os.path.join(keep_root, "old.pdf")
    with open(old_pdf, "wb") as handle:
        handle.write(b"%PDF-1.4\n" + b"x" * 4000)
    long_ago = time.time() - 5 * 86400
    os.utime(old_pdf, (long_ago, long_ago))
    cache_dir = os.path.join(keep_root, "cache", "123")
    os.makedirs(cache_dir, exist_ok=True)
    with open(os.path.join(cache_dir, "0001-a.bin"), "wb") as handle:
        handle.write(b"x" * 100)
    os.utime(cache_dir, (long_ago, long_ago))
    fresh_pdf = os.path.join(keep_root, "new.pdf")
    with open(fresh_pdf, "wb") as handle:
        handle.write(b"%PDF-1.4\n" + b"y" * 4000)
    said = prune_out(keep_root)
    assert os.path.isfile(fresh_pdf), "the newest PDF must be kept"
    assert any("cache: dropped 123" in line for line in said), said
    assert not os.path.isdir(cache_dir), said
    # too many files: only the newest KEEP_FILES survive
    before = KEEP_FILES
    globals()["KEEP_FILES"] = 1
    try:
        said = prune_out(keep_root)
    finally:
        globals()["KEEP_FILES"] = before
    assert not os.path.isfile(old_pdf) and os.path.isfile(fresh_pdf), said
    assert any("older than the newest 1" in line for line in said), said
    # a hard cap removes the oldest first, and never the last one left
    before_mb = MAX_OUT_MB
    globals()["MAX_OUT_MB"] = 0
    try:
        said = prune_out(keep_root)
    finally:
        globals()["MAX_OUT_MB"] = before_mb
    assert os.path.isfile(fresh_pdf), "the last PDF is never deleted"
    assert folder_mb(keep_root) >= 0

    # ---- the panel page is usable on a phone and has no paste box -------
    assert "width=device-width" in PAGE
    assert "@media (max-width:640px)" in PAGE and "font-size:16px" in PAGE
    assert 'id="markall"' in PAGE and 'id="untickall"' in PAGE
    assert 'id="channels"' in PAGE and 'value="16" selected' in PAGE
    assert 'id="reset"' in PAGE and 'id="stallrow"' in PAGE
    assert 'id="links"' not in PAGE and "paste links" not in PAGE
    assert PAGE.count('id="ticked"') == 1 and "'/reset'" in PAGE
    assert "related, not a match" in PAGE
    # every element the page's script reaches for must exist in the page — a
    # removed card leaves $('links') behind and nothing else notices until a tap
    script = PAGE.split("<script>", 1)[1].split("</script>", 1)[0]
    wanted_ids = set(re.findall(r"\$\('([a-z]+)'\)", script))
    absent = sorted(name for name in wanted_ids if f'id="{name}"' not in PAGE)
    assert not absent, absent
    assert "markall" in wanted_ids and "channels" in wanted_ids
    # the handlers the page needs, in the order the script defines them
    for handler in ("$('find').onclick", "$('markall').onclick",
                    "$('untickall').onclick", "$('reset').onclick",
                    "$('ticked').onclick"):
        assert handler in script, handler

    def stub(payload, status=200, error=""):
        def ask(url):
            body = (payload if isinstance(payload, bytes)
                    else json.dumps(payload).encode())
            return {"status": status, "body": body, "headers": {}, "error": error}
        return ask

    hits, notes = find_documents("physics 12th", 1, ask=stub(answer))
    assert [hit["id"] for hit in hits] == ["1", "2", "3"], hits
    assert notes == ["page 1: 4 document(s), 3 new"], notes
    assert picked_hits(hits, "2") == [hits[1]]
    assert picked_hits(hits, "1-2") == hits[:2]
    assert picked_hits(hits, "3,1") == [hits[2], hits[0]]
    assert picked_hits(hits, "9") == [] and picked_hits(hits, "x") == []

    # a refusal is reported as a refusal, never dressed up as "no results"
    hits, notes = find_documents("physics", 1, ask=stub(b"nope", 403))
    assert hits == [] and "refused" in notes[0], notes
    hits, notes = find_documents("physics", 1, ask=stub(b"<html>app</html>"))
    assert hits == [] and "not search data" in notes[0], notes
    hits, notes = find_documents("physics", 1,
                                 ask=stub({}, 0, "connection refused"))
    assert hits == [] and "no answer" in notes[0], notes
    hits, notes = find_documents("   ", 1, ask=stub(answer))
    assert hits == [] and "type a few words" in notes[0], notes
    # one page at a time: the page number is sent, and the totals come back
    asked: list[str] = []

    def counting(payload):
        def ask(url):
            asked.append(url)
            return {"status": 200, "body": json.dumps(payload).encode(),
                    "headers": {}, "error": ""}
        return ask

    paged = dict(answer)
    paged["total_results_count"] = 3
    paged["page_count"] = 2
    hits, note, info = find_page("physics 12th", 2, counting(paged))
    assert asked[-1].endswith("page=2"), asked[-1]
    assert info == {"page": 2, "documents": 4, "total": 3, "pages": 2}, info
    assert len(hits) == 3, len(hits)
    assert note == ("4 document(s), 1 dropped (duplicate or not a Scribd document)"
                    ", 2 only loosely related"), note

    empty = {"results": {}, "total_results_count": 0, "page_count": 0}
    hits, note, info = find_page("nothing at all", 1, counting(empty))
    assert hits == [] and info["total"] == 0, (hits, info)
    assert "named no documents" in note, note
    hits, note, info = find_page("nothing at all", 3, counting(empty))
    assert note == "no more documents", note          # a later page is not a failure
    # no totals in the answer: still fine, the page just will not show a count
    hits, note, info = find_page("physics", 1, stub(answer))
    assert info["total"] == 0 and info["documents"] == 4, info

    # a page with nothing new stops the paging instead of hammering Scribd
    hits, notes = find_documents("physics", 3, ask=stub(answer))
    assert len(hits) == 3 and len(notes) == 2, notes
    assert notes[-1] == "page 2: 4 document(s), 0 new", notes

    # ---- the throttle breaker: a locked page and a throttled address ----
    spoken: list[str] = []
    before_say = JOB.say
    JOB.say = lambda text: spoken.append(text)
    ctx = Ctx("https://www.scribd.com/document/750213011/x", 4)
    assert ctx.refused(3) is False            # one page refused: not a throttle
    assert ctx.refused(3) is False            # the same page again: still not
    assert ctx.refused(4) is False            # a second page
    assert ctx.refused(5) is True             # three different pages: throttled
    assert 0 < ctx.rest_until - time.time() <= PAUSE_LADDER[0] + 0.5
    assert ctx.rest_until - time.time() > 1
    # while resting it keeps saying "rest", and the ladder must not climb
    assert ctx.refused(6) is True and ctx.rests == 1, ctx.rests
    ctx.rest_until = 0.0                      # the rest is over
    ctx.dead.add("some-name")
    for page in (7, 8, 9):
        last = ctx.refused(page)
    assert last is True and ctx.rests == 2, (last, ctx.rests)
    assert not ctx.dead, "names refused while throttled must not stay dead"
    # a good page resets the counting
    ctx.rest_until = 0.0
    ctx.answered()
    assert ctx.refused(10) is False and ctx.refused(11) is False
    assert ctx.refused(12) is True
    # the ladder is capped, and a run of good answers steps it back down
    ctx.rest_until = 0.0
    ctx.rests = 99
    ctx.refused(20), ctx.refused(21), ctx.refused(22)
    assert PAUSE_LADDER[-1] - 0.5 <= ctx.rest_until - time.time() <= PAUSE_LADDER[-1] + 0.5
    ctx.rests, ctx.reliefs, ctx.rest_until = 2, 0, 0.0
    for _ in range(8):
        ctx.answered()
    assert ctx.rests == 1, ctx.rests
    JOB.say = before_say
    assert any("throttling" in line for line in spoken), spoken
    assert len(spoken) == 4, spoken          # one line per rest, not one per 403

    # ---- the text layer: the words, not just the pictures -------------------
    assert html_to_text("<div>One</div><br><div>Two &amp; three</div>") == "One\nTwo & three"
    assert html_to_text("<p>a</p><p>b</p>").split("\n") == ["a", "b"]
    assert html_to_text("  <span>x</span>  ") == "x"
    assert html_to_text("") == "" and html_to_text(None) == ""
    assert "\n\n\n" not in html_to_text("<br><br><br><div>z</div>")
    page = b'window.page2_callback(["<div>First</div>", "<br>", "Second &#39;quote&#39;"]);'
    assert text_from_jsonp(page) == "First\nSecond 'quote'", text_from_jsonp(page)
    assert text_from_jsonp(b'window.page2_callback([1, null, "<b>ok</b>"]);') == "ok"
    assert text_from_jsonp(b"not a descriptor") == ""
    assert text_from_jsonp(b'window.page2_callback(["unterminated")') == ""
    assert text_from_jsonp(b"[not json") == ""
    # the descriptor shares the scan's <page>-<hash> pair, so it is derivable
    assert jsonp_from_image(
        "https://html.scribdassets.com/9675umbmgwcrttvn/images/2-90c206b2e6.jpg"
    ) == "https://html.scribdassets.com/9675umbmgwcrttvn/pages/2-90c206b2e6.jsonp"
    assert jsonp_from_image(
        "https://html.scribdassets.com/9675umbmgwcrttvn/images/2-90c206b2e6.jpg?token=x"
    ).endswith("/pages/2-90c206b2e6.jsonp")
    assert jsonp_from_image("https://www.scribd.com/document/1/x") == ""
    # a layer is only drawn where there is room, and it never prints
    layer = text_layer("Hello there\nSecond line", (900.0, 1200.0, 0.0, 0.0))
    assert b"3 Tr" in layer and b"(Hello there) Tj" in layer, layer
    assert b"im0" not in layer and b"Do" not in layer
    assert text_layer("Hello", (15.0, 15.0, 0.0, 0.0)) == b""
    assert text_layer("", (900.0, 1200.0, 0.0, 0.0)) == b""
    # brackets and backslashes must be escaped, latin-1 must survive
    tricky = text_layer("a (b) \\ c \u2014 caf\u00e9", (400.0, 100.0, 0.0, 0.0))
    assert b"\\(b\\)" in tricky and b"\\\\" in tricky, tricky
    assert b"caf\xe9" in tricky and b"\xe2\x80\x94" not in tricky, tricky
    # and the finished file carries it without breaking the sheet
    with tempfile.TemporaryDirectory() as spot:
        book = os.path.join(spot, "text.pdf")
        leaf = scan_for_pdf(make_jpeg(1200, 1600))
        ok, note = build_pdf([leaf, None], book, texts={1: "Mock page one\nline two"})
        assert ok and "searchable text" in note, note
        sound, report = verify_pdf(book, expect_pages=2, expect_images=1)
        assert sound, report                       # the layer must not break xref
        with open(book, "rb") as handle:
            written = handle.read()
        assert b"(Mock page one) Tj" in written
        # the placeholder sheet is untouched by the layer: one page has text
        assert note.count("1 page(s) with searchable text") == 1, note
        ok, note = build_pdf([leaf], book)
        assert ok and "searchable" not in note, note
        with open(book, "rb") as handle:
            assert b"Tj" not in handle.read()
        # a preview page is a legal sheet; a smudge is still a broken file
        ok, note = build_pdf([preview_page, leaf], book)
        assert ok, note
        with open(book, "rb") as handle:
            written = handle.read()
        assert verify_bytes(written, expect_pages=2, expect_images=2)[0]
        smudge = dict(preview_page)
        smudge["width"] = smudge["height"] = 40
        smudge["params"] = (preview_page["params"]
                            .replace("/Width 96", "/Width 40")
                            .replace("/Height 130", "/Height 40"))
        assert build_pdf([smudge, leaf], book)[0]
        sound, report = verify_pdf(book, expect_pages=2, expect_images=2)
        assert not sound and "only 40x40" in report, report

    # ---- the panel gate a dashboard has to come through ---------------------
    global PANEL_KEY, PANEL_ORIGINS
    saved_key, saved_origins = PANEL_KEY, PANEL_ORIGINS

    PANEL_KEY = ""                                   # open panel: as before
    assert panel_gate({}, {}) and panel_gate({"X-Panel-Key": "anything"}, {})

    PANEL_KEY = "s3cret"                             # keyed panel
    assert not panel_gate({}, {})
    assert not panel_gate({"X-Panel-Key": "nope"}, {})
    assert panel_gate({"X-Panel-Key": "s3cret"}, {})
    assert panel_gate({}, {"key": ["s3cret"]})
    assert not panel_gate({}, {"key": ["S3CRET"]})    # exact, not fuzzy
    assert panel_gate({}, {}, "theme=dark; scribd_panel_key=s3cret")
    assert not panel_gate({}, {}, "scribd_panel_key=other")
    cookie = panel_cookie()
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie, cookie
    assert "scribd_panel_key=s3cret" in cookie

    # ---- signed download links: one file, briefly, no key in the URL ----
    keep_signing, PANEL_KEY = PANEL_KEY, "k3y"
    try:
        soon = int(time.time()) + 600
        good = file_token("Doc (2).pdf", soon)
        assert len(good) == 64 and token_ok("Doc (2).pdf", soon, good)
        assert not token_ok("Doc (3).pdf", soon, good)          # another file
        assert not token_ok("Doc (2).pdf", soon + 1, good)      # another moment
        assert not token_ok("Doc (2).pdf", int(time.time()) - 5, good)   # expired
        assert not token_ok("Doc (2).pdf", soon, good[:-1] + ("0" if good[-1] != "0" else "1"))
        assert not token_ok("Doc (2).pdf", "soon", good)        # junk expiry
        assert not token_ok("Doc (2).pdf", None, good)
        assert not token_ok("Doc (2).pdf", soon, "")            # no signature
        # a signature dated years ahead is refused, so a leaked one dies
        assert not token_ok("Doc (2).pdf", int(time.time()) + 8 * 24 * 3600, good)
    finally:
        PANEL_KEY = keep_signing


    PANEL_ORIGINS = ["https://dash.example.vercel.app"]
    allowed = cors_headers("https://dash.example.vercel.app")
    assert allowed["Access-Control-Allow-Origin"] == "https://dash.example.vercel.app"
    assert "X-Panel-Key" in allowed["Access-Control-Allow-Headers"]
    assert cors_headers("https://evil.example") == {}   # never a wildcard
    assert cors_headers("") == {}
    PANEL_ORIGINS = []
    assert cors_headers("https://dash.example.vercel.app") == {}

    PANEL_KEY, PANEL_ORIGINS = saved_key, saved_origins

    # ---- the file list the dashboard reads, so it never guesses names ------
    with tempfile.TemporaryDirectory() as shelf:
        with open(os.path.join(shelf, "Book.pdf"), "wb") as handle:
            handle.write(b"x" * 12)
        with open(os.path.join(shelf, "notes.txt"), "wb") as handle:
            handle.write(b"not a pdf")
        rows = panel_files(shelf)
        assert [row["name"] for row in rows] == ["Book.pdf"], rows
        assert rows[0]["bytes"] == 12 and rows[0]["when"] > 0
        assert panel_files(os.path.join(shelf, "gone")) == []

    gate = Gate(rate=24.0, floor=8.0, ceiling=60.0)
    for _ in range(40):
        gate.complaint(403)
    assert 8.0 <= gate.rate < 20.0, gate.rate
    hard = Gate(rate=24.0, floor=8.0, ceiling=60.0)
    for _ in range(40):
        hard.complaint(429)
    assert abs(hard.rate - 8.0) < 0.01, hard.rate

    return ("selftest: every check passed — sheet maths, EXIF rotation, "
            "jpeg size traps, previews and cut transfers, pdf verify, text "
            "layer, panel key and CORS, cookies, token, names, pasted links, "
            "bookmarklet, scribd search, relevance, channels, the document "
            "queue, signed links, the disk guard, page wiring")

def main(argv: list[str]) -> int:
    global BASE
    urls: list[str] = []
    links_text = ""
    limit = 0
    out = OUT
    cookies = ""
    jobs = 12
    refresh = False
    name = ""
    check = True
    placeholder = True
    verify = True
    text = False
    probe = 0
    find_text = ""
    find_asked = False
    find_pages = 1
    pick = ""
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in ("--url", "--links", "--limit", "--out", "--cookies", "--base",
                   "--jobs", "--name", "--probe", "--find", "--pages",
                   "--pick") and index + 1 < len(argv):
            value = argv[index + 1]
            if arg == "--find":
                find_text = value.strip()
                find_asked = True
            elif arg == "--pages":
                find_pages = as_page(value)
            elif arg == "--pick":
                pick = value.strip()
            elif arg == "--url":
                urls.append(value.strip())
            elif arg == "--links":
                links_text += "\n" + value
            elif arg == "--limit":
                limit = as_limit(value)
            elif arg == "--out":
                out = value
            elif arg == "--cookies":
                cookies = value
            elif arg == "--name":
                name = value
            elif arg == "--probe":
                probe = as_limit(value, 0, FIND_MAX_PAGE)
            elif arg == "--jobs":
                jobs = as_page(value, 12)
                jobs = max(1, min(jobs, 32))
            else:
                BASE = value.rstrip("/")
            index += 2
            continue
        if arg == "--refresh":
            refresh = True
        elif arg == "--no-check":
            check = False
        elif arg == "--no-placeholder":
            placeholder = False
        elif arg == "--no-verify":
            verify = False
        elif arg in ("--text", "--text-layer"):
            text = True
        elif arg == "--selftest":
            print(selftest())
            return 0
        elif arg in ("-h", "--help"):
            print(__doc__)
            return 0
        elif arg == "--verify" and index + 1 < len(argv):
            sound, report = verify_pdf(argv[index + 1])
            print(("OK     " if sound else "BROKEN ") + report)
            return 0 if sound else 1
        elif arg.startswith("--base="):
            BASE = arg.split("=", 1)[1].rstrip("/")
        index += 1
    if cookies:
        os.environ["COOKIES"] = cookies
    if find_asked and not find_text:
        print('--find needs a few words: --find "physics 12th"')
        return 2
    if pick and not find_text:
        print('--pick only makes sense with --find "your words"')
        return 2
    if find_text:
        hits, notes = find_documents(find_text, find_pages)
        for note in notes:
            print(f"  {note}")
        if not hits:
            print("no documents found — nothing to download")
            return 1
        print_hits(hits)
        if not pick:
            print(f"{len(hits)} document(s) — add --pick 1,3 to download any of them")
            return 0
        chosen = picked_hits(hits, pick)
        if not chosen:
            print(f"nothing matches --pick {pick} (there are {len(hits)})")
            return 2
        print(f"downloading {len(chosen)} of {len(hits)} document(s)")
        urls += [hit["url"] for hit in chosen]
    if links_text.strip():
        urls += links_from_text(links_text)
    urls = [item for item in dict.fromkeys(urls) if item]
    if urls:
        run_job(urls, limit, out, jobs, refresh, name, check, placeholder, probe,
                verify, text)
        return 0 if JOB.verdict in ("PDF BUILT", "PDF PARTIAL", "PROBE DONE") else 1
    port = int(os.environ.get("SERVER_PORT") or os.environ.get("PORT") or 8090)
    serve(port, out)
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
