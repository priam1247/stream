#!/usr/bin/env python3
"""scribd_download.py — ONE file, standard library only.  Version 2.5

Find Scribd documents by keyword, then download them as PDFs. No browser, no pip.

    python scribd_download.py                        # serves the page (panel mode)
    python scribd_download.py --search "physics 12th"          # just list the links
    python scribd_download.py --search "physics 12th" --download   # find + download
    python scribd_download.py --url LINK             # one shot, whole document
    python scribd_download.py --url LINK --limit 5   # first 5 pages only
    python scribd_download.py --url LINK --probe 4   # every url and every answer
    python scribd_download.py --verify FILE.pdf      # check a finished PDF
    python scribd_download.py --selftest             # offline check of this file

Panel mode: set PY_FILE to this file, restart, open the server address. The page
has three ways in:
  1. type a keyword -> Find -> tick the results -> Download
  2. paste a document link -> Download
  3. from your own browser, click the bookmarklet on a Scribd search page: it
     sends every document link on that page to /send, and the panel queues them

Nothing about the search needs Chromium. Scribd's own search page is a JS app
and has no results in its HTML, so the keyword goes to the search engines that
have already indexed scribd.com (`site:scribd.com <keyword>`): DuckDuckGo html,
DuckDuckGo lite, Bing, Mojeek, then Scribd's own search page. Each engine's
answer is reported in the log — "no results" can never be confused with "this
address was blocked", and every engine is asked without your cookies. If the
engines refuse this IP, the bookmarklet route still works, because then the
search happens in your browser and only the links travel.

What 2.4/2.5 fix in the OUTPUT (2.3 is kept everywhere else)
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
  Search engines are asked with no cookies at all.

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

Options: --search QUERY, --results N (default 10), --search-pages N (default 1),
         --pick 1,3, --download (with --search), --limit N, --out DIR,
         --cookies PATH, --base URL, --jobs N (default 12), --refresh,
         --name TITLE, --no-check, --no-placeholder, --no-verify,
         --verify FILE, --probe N, --selftest

Cookies are read, never printed. Files stay on this machine.
"""

from __future__ import annotations

import base64
import datetime
import gzip
import http.client
import json
import os
import re
import socket
import struct
import sys
import threading
import time
import urllib.parse
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "2.5"
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
OTHER_HOSTS = ("html.scribd.com", "html2-f.scribdassets.com",
               "html3-f.scribdassets.com", "html4-f.scribdassets.com")
# a page scan is never smaller than this, and never this lopsided
MIN_PAGE_PX = 200
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
# search — a keyword to Scribd document links, no browser needed
# ---------------------------------------------------------------------------
# Scribd's own search page is a JavaScript app, so its HTML has no results in
# it. What does answer over plain HTTP is the search engines, which have already
# indexed scribd.com: `site:scribd.com <keyword>`. Each engine below is tried in
# turn; the first that answers with links wins, and every engine's answer is
# reported, so "no results" can never be confused with "we were blocked".
SEARCH_ENGINES = (
    # name, url, method, prefix the query with site:scribd.com ?
    ("duckduckgo", "https://html.duckduckgo.com/html/", "POST", True),
    ("duckduckgo-lite", "https://lite.duckduckgo.com/lite/", "POST", True),
    ("bing", "https://www.bing.com/search?q={query}&count=50", "GET", True),
    ("mojeek", "https://www.mojeek.com/search?q={query}", "GET", True),
    ("scribd", "https://www.scribd.com/search?query={query}", "GET", False),
)
GENERIC_LABELS = {
    "", "save", "download", "read more", "read", "scribd", "upload", "share",
    "open", "view", "preview", "see all", "more", "add to library", "sign in",
}
ANCHOR_RE = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.I | re.S)
HREF_ATTR_RE = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.I)
TITLE_ATTR_RE = re.compile(r"""(?:title|aria-label)\s*=\s*["']([^"']{3,300})["']""", re.I)
TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
DOC_IN_URL_RE = re.compile(
    r"scribd\.com/(document|doc|presentation|spreadsheet|ebook|audiobook|magazine)"
    r"/(\d{3,})(?:/([^/?#\"'&\s<>]*))?", re.I)
BING_WRAP_RE = re.compile(r"[?&]u=a1([A-Za-z0-9_\-]+)", re.I)


def _plain(text: str) -> str:
    """Tags out, entities in, whitespace collapsed."""
    raw = TAG_RE.sub(" ", text or "")
    for a, b in (("&amp;", "&"), ("&quot;", '"'), ("&#39;", "'"), ("&#x27;", "'"),
                 ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " ")):
        raw = raw.replace(a, b)
    return SPACE_RE.sub(" ", raw).strip()


def html_escape(text) -> str:
    raw = str(text if text is not None else "")
    for a, b in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"), ('"', "&quot;")):
        raw = raw.replace(a, b)
    return raw


def unwrap_link(href: str) -> str:
    """Turn a search engine's redirect into the url it points at.

    DuckDuckGo wraps results as //duckduckgo.com/l/?uddg=<encoded>, and Bing as
    /ck/a?...&u=a1<base64>. Both are decoded here; a plain url comes back as it
    went in.
    """
    href = (href or "").strip().replace("&amp;", "&")
    if href.startswith("//"):
        href = "https:" + href
    if "duckduckgo.com/l/" in href:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query)
        href = (query.get("uddg") or [""])[0] or href
    elif "/ck/a" in href:
        match = BING_WRAP_RE.search(href)
        if match:
            raw = match.group(1).replace("-", "+").replace("_", "/")
            try:
                href = base64.b64decode(raw + "=" * (-len(raw) % 4)).decode(
                    "utf-8", "replace")
            except Exception:  # noqa: BLE001
                pass
    return urllib.parse.unquote(href)


def _hit_from_url(url: str) -> tuple[str, str, str] | None:
    match = DOC_IN_URL_RE.search(url or "")
    if not match:
        return None
    kind = "document" if match.group(1).lower() == "doc" else match.group(1).lower()
    slug = (match.group(3) or "").strip("/")
    return kind, match.group(2), slug


def parse_search_links(html: str, engine: str = "") -> list[dict]:
    """Document links out of one search engine page, in page order, unique.

    Two passes: anchors first (they carry titles), then any document url written
    anywhere in the page — a `<cite>` line, a JSON blob, an escaped url — so a
    page that renders links as text still counts. Titles never invent words: an
    anchor's own text wins, then its title attribute, then the url slug.
    """
    hits: list[dict] = []
    seen: dict[str, dict] = {}

    def add(kind: str, doc_id: str, slug: str, title: str) -> None:
        title = _plain(title)
        if title.lower() in GENERIC_LABELS:
            title = ""
        if doc_id in seen:
            if title and len(title) > len(seen[doc_id]["title"]):
                seen[doc_id]["title"] = title
            if slug and not seen[doc_id]["slug"]:
                seen[doc_id]["slug"] = slug
                seen[doc_id]["url"] = f"https://www.scribd.com/{kind}/{doc_id}/{slug}"
            return
        hit = {"doc_id": doc_id, "kind": kind, "slug": slug,
               "title": title or _plain(slug.replace("-", " ").replace("_", " "))
                        or f"scribd {doc_id}",
               "url": f"https://www.scribd.com/{kind}/{doc_id}/{slug or 'doc'}",
               "engine": engine}
        seen[doc_id] = hit
        hits.append(hit)

    for anchor in ANCHOR_RE.finditer(html or ""):
        attrs, body = anchor.group(1), anchor.group(2)
        href_match = HREF_ATTR_RE.search(attrs)
        if not href_match:
            continue
        found = _hit_from_url(unwrap_link(href_match.group(1)))
        if not found:
            continue
        kind, doc_id, slug = found
        title = ""
        title_match = TITLE_ATTR_RE.search(attrs)
        if title_match:
            title = title_match.group(1)
        if not title:
            title = _plain(body)
            if len(title) > 250:
                title = ""
        add(kind, doc_id, slug, title)

    for match in DOC_IN_URL_RE.finditer(urllib.parse.unquote(text_of(html))):
        kind = "document" if match.group(1).lower() == "doc" else match.group(1).lower()
        add(kind, match.group(2), (match.group(3) or "").strip("/"), "")

    return hits


def post_form(url: str, fields: dict, timeout: float = 20.0) -> dict:
    """A form POST with the same pool/redirect handling as fetch()."""
    target = rebase(url)
    body = urllib.parse.urlencode(fields).encode()
    headers = {"User-Agent": UA,
               "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9",
               "Accept-Encoding": "gzip, deflate",
               "Content-Type": "application/x-www-form-urlencoded",
               "Content-Length": str(len(body))}
    for _hop in range(3):
        parsed = urllib.parse.urlsplit(target)
        scheme = parsed.scheme or "https"
        netloc = parsed.netloc
        path = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
        for attempt in (0, 1):
            connection = _connection(scheme, netloc, timeout)
            try:
                connection.request("POST", path, body=body, headers=headers)
                response = connection.getresponse()
                raw = response.read()
                status = response.status
                location = response.getheader("Location") or ""
                answer = {k.lower(): v for k, v in response.getheaders()}
                break
            except Exception as exc:  # noqa: BLE001
                _forget(scheme, netloc)
                if attempt:
                    return {"status": 0, "body": b"", "headers": {},
                            "error": repr(exc)[:160]}
                status, raw, location, answer = 0, b"", "", {}
        if status in (301, 302, 303, 307, 308) and location:
            target = urllib.parse.urljoin(target, location)
            body = b""
            headers.pop("Content-Length", None)
            continue
        return {"status": status,
                "body": _decompress(raw, (answer.get("content-encoding") or "").lower()),
                "headers": answer, "error": ""}
    return {"status": 0, "body": b"", "headers": {}, "error": "too many redirects"}


def engine_ask(name: str, url: str, method: str, site_only: bool, query: str,
               page: int, timeout: float = 20.0) -> tuple[list[dict], str]:
    """One engine, one page. Returns (hits, one honest line about the answer)."""
    words = (f"site:scribd.com {query}" if site_only else query).strip()
    if method == "POST":
        fields = {"q": words}
        if page > 1:
            fields["s"] = str((page - 1) * 30)
        got = post_form(url, fields, timeout=timeout)
    else:
        target = url.format(query=urllib.parse.quote_plus(words))
        if page > 1:
            target += ("&" if "?" in target else "?") + f"page={page}"
        got = fetch(target, None, timeout=timeout)
    if got.get("error"):
        return [], f"{name}: {got['error'][:90]}"
    if got["status"] != 200:
        hint = ""
        if got["status"] in (202, 403, 429, 503):
            hint = " (blocked or throttled here)"
        return [], f"{name}: HTTP {got['status']}{hint}"
    hits = parse_search_links(got["body"].decode("utf-8", "replace"), engine=name)
    if not hits:
        shell = b"<script" in got["body"] and len(got["body"]) < 900_000
        return [], (f"{name}: HTTP 200, {len(got['body']) / 1000:.0f} kB, no links"
                    + (" (a JavaScript page — it needs no browser for the other engines)"
                       if shell else ""))
    return hits, f"{name}: {len(hits)} link(s)"


def find_links(query: str, *, pages: int = 1, limit: int = 0, log=None,
               engines=SEARCH_ENGINES) -> tuple[list[dict], list[str]]:
    """Ask each search engine in turn until `limit` documents are found.

    Returns the hits and one line per engine tried, in the order tried, so the
    caller can show what answered and what refused.
    """
    text = (query or "").strip()
    if not text:
        return [], ["no query"]
    notes: list[str] = []
    found: list[dict] = []
    seen: set[str] = set()
    for name, url, method, site_only in engines:
        if limit and len(found) >= limit:
            break
        for page in range(1, max(1, pages) + 1):
            if limit and len(found) >= limit:
                break
            hits, note = engine_ask(name, url, method, site_only, text, page)
            notes.append(note)
            if log:
                log(note)
            fresh = [hit for hit in hits if hit["doc_id"] not in seen]
            for hit in fresh:
                seen.add(hit["doc_id"])
                found.append(hit)
            if not hits:
                break
    return (found[:limit] if limit else found), notes


def search_sentence(hits: list[dict], notes: list[str]) -> str:
    """One line for the verdict: what was found, and whether we were blocked."""
    blocked = [n for n in notes if "HTTP 202" in n or "HTTP 403" in n
               or "HTTP 429" in n or "HTTP 503" in n or "error" in n.lower()]
    if hits:
        text = f"{len(hits)} document(s) found"
    else:
        text = "no documents found"
    if blocked:
        text += f" · {len(blocked)} engine(s) blocked this address"
    return text

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
    walked: list[tuple[int, int, int]] = []
    index = 2
    limit = min(len(data), 4_000_000)
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
        if marker in (0xD9, 0xDA):            # end of image, or scan data starts
            break
        length = struct.unpack(">H", data[index + 2:index + 4])[0]
        if length < 2:
            break
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if index + 10 <= limit:
                height, width = struct.unpack(">HH", data[index + 5:index + 9])
                components = data[index + 9]
                if width and height:
                    walked.append((width, height, components))
        index += 2 + length
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

def scan_for_pdf(data: bytes) -> dict | None:
    """One page scan -> {'payload','params','width','height','rotate','label'}."""
    if data[:2] == b"\xff\xd8":
        width, height, components = jpeg_size(data)
        if width and not page_can_be_this_small(width, height, len(data)):
            # a page-sized file cannot really be a 772x68 picture: the header
            # read is wrong, so ask a decoder before believing either number
            wide, tall, guess = pillow_size(data)
            width, height, components = ((wide, tall, guess)
                                         if page_can_be_this_small(wide, tall, len(data))
                                         else (0, 0, 0))
        if not (width and plausible_page({"width": width, "height": height})):
            # the header chain said nothing usable, or said something no page
            # could be: ask a real decoder before throwing a good scan away
            wide, tall, guess = pillow_size(data)
            if wide and tall and plausible_page({"width": wide, "height": tall}):
                width, height, components = wide, tall, guess
            elif not width:
                return None
        space = {1: "/DeviceGray", 3: "/DeviceRGB", 4: "/DeviceCMYK"}.get(
            components, "/DeviceRGB")
        return {"payload": data, "width": width, "height": height,
                "rotate": jpeg_orientation(data),
                "params": (f"/Width {width} /Height {height} /ColorSpace {space} "
                           "/BitsPerComponent 8 /Filter /DCTDecode /Interpolate true"),
                "label": f"{width}x{height} jpeg, {len(data) / 1000:.0f} kB"}
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        direct = png_for_pdf(data)
        if direct:
            return direct
        decoded = png_to_raw(data)
        if decoded:
            pixels, width, height, components = decoded
            return _raw_page(pixels, width, height, components,
                             f"{width}x{height} png")
        return pillow_page(data)          # 16-bit / interlaced, if Pillow is here
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return pillow_page(data)
    return pillow_page(data)

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
    """The one sheet every page is scaled into: the median page, in points."""
    width, height = median_page(pages)
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
    # pixels are invented, so a genuinely small page stays crisp and centred
    fit = min(sheet[0] / natural_w, sheet[1] / natural_h, 2.0)
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

def build_pdf(pages: list[dict | None], path: str, title: str = "",
              author: str = "", uniform: bool = True) -> tuple[bool, str]:
    """pages: [{'payload','params','width','height','rotate'}|None] in sheet order.

    None is a labelled placeholder sheet, so PDF page N always equals document
    page N. uniform=False gives every sheet the MediaBox of its own scan.
    """
    real = [page for page in pages if page]
    if not real:
        return False, "no pages to write"
    house = house_sheet(real)

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
        content = ("q " + _image_matrix(page, box) + " /Im0 Do Q").encode()
        objects.append(b"<< /Length " + str(len(content)).encode()
                       + b" >>\nstream\n" + content + b"\nendstream")
        content_num = len(objects)
        objects.append(
            (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {sheet[0]} {sheet[1]}]"
             f" /Resources << /ProcSet [/PDF /ImageB /ImageC /Text]"
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
                  + (f", {blanks} placeholder" if blanks else ""))

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
                if wide < MIN_PAGE_PX or tall < MIN_PAGE_PX:
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
class Job:
    def __init__(self) -> None:
        self.lock = threading.Lock()
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

    def say(self, text: str) -> None:
        with self.lock:
            self.lines.append(text)
            del self.lines[:-400]
        print(text, flush=True)

    def set_progress(self, **kwargs) -> None:
        with self.lock:
            self.progress.update(kwargs)

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
        self.total = 0
        self.title = ""
        self.author = ""

    def note(self, text: str) -> None:
        with self.notes_lock:
            if text not in self.notes:
                self.notes.append(text)

    def record(self, number: int, url: str, status: int) -> None:
        with self.trace_lock:
            self.trace.setdefault(number, []).append(f"{status:>3}  {url}")
            self.tried.setdefault(number, set()).add(url)

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

    def cache_path(self, number: int) -> str:
        source = self.sources.get(number)
        stem = (source.get("image") or source.get("jsonp") or str(number)).split("?")[0]
        stem = re.sub(r"[^0-9A-Za-z]+", "-", stem.rsplit("/", 1)[-1])[:48]
        return os.path.join(self.cache_dir, f"{number:04d}-{stem}.bin")

    def attempt(self, url: str, tries: int) -> tuple[dict | None, str, int]:
        reason = "no attempt"
        delay = 0.7
        status = 0
        for attempt in range(tries):
            self.gate.acquire()
            got = fetch(url, self.jar, referer=self.document_url, timeout=25)
            status = got["status"]
            if status == 200 and looks_like_image(got["body"]):
                built = scan_for_pdf(got["body"])
                if built:
                    self.gate.clean_answer()
                    built["url"] = url
                    built["bytes"] = len(got["body"])
                    built["raw"] = got["body"]
                    return built, "", status
                kind = self.reject(got["body"])
                return None, (f"HTTP 200, {len(got['body']) / 1000:.0f} kB "
                              f"{kind} that is not a page scan"), status
            if got["error"]:
                reason = got["error"]
            else:
                reason = http_reason(got)
                self.gate.complaint(status)
                if status == 403:
                    return None, reason, status     # deterministic: no backoff
                if status not in RETRY_STATUS:
                    return None, reason, status
            if attempt < tries - 1:
                time.sleep(retry_after(got["headers"]) or delay)
                delay = min(6.0, delay * 1.8)
        return None, reason, status

    def grab(self, number: int, force: bool = False,
             wide: bool = False) -> tuple[int, dict | None, str]:
        path = self.cache_path(number)
        if not force and not self.refresh and os.path.isfile(path):
            try:
                with open(path, "rb") as handle:
                    data = handle.read()
            except OSError:
                data = b""
            built = scan_for_pdf(data)
            if built and plausible_page(built):
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
                built, reason, status = self.attempt(url, tries)
                self.record(number, url, status)
                if built and plausible_page(built):
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
        self.note(f"page {number}: {len(seen)} name(s) tried, all refused ({reason})")
        return number, None, f"page {number}: {reason}"

def run_job(url: str | list[str], limit: int = 0, out: str = OUT, jobs: int = 12,
            refresh: bool = False, name: str = "", check: bool = True,
            placeholder: bool = True, probe_page: int = 0,
            verify: bool = True) -> None:
    urls = [str(item).strip() for item in
            (url if isinstance(url, (list, tuple)) else [url])
            if str(item or "").strip()]
    with JOB.lock:
        JOB.state = "running"
        JOB.lines.clear()
        JOB.verdict = ""
        JOB.detail = ""
        JOB.file = ""
        JOB.title = ""
        JOB.url = urls[0] if urls else ""
        JOB.out = out
        JOB.started = time.time()
        JOB.ended = 0.0
        JOB.progress = {"page": 0, "of": 0, "ok": 0, "skipped": 0, "blank": 0}
    os.makedirs(out, exist_ok=True)
    try:
        if not urls:
            with JOB.lock:
                JOB.verdict = "BAD LINK"
                JOB.detail = "no link given"
        elif probe_page:
            _probe(urls[0], probe_page)
        elif len(urls) > 1:
            _batch(urls, limit, out, jobs, refresh, check, placeholder, verify)
        else:
            _download(urls[0], limit, out, jobs, refresh, name, check, placeholder,
                      verify)
    except Exception as exc:  # noqa: BLE001
        JOB.say(f"crashed: {exc!r}")
        with JOB.lock:
            JOB.verdict = "FAILED"
            JOB.detail = repr(exc)[:180]
    finally:
        with JOB.lock:
            JOB.state = "done"
            JOB.ended = time.time()
        JOB.say("")
        JOB.say(f"== {JOB.verdict} — {JOB.detail}")

def _batch(urls: list[str], limit: int, out: str, jobs: int = 12,
           refresh: bool = False, check: bool = True, placeholder: bool = True,
           verify: bool = True) -> None:
    """Several documents, one after another, with one honest verdict at the end.

    Each link goes through exactly the same _download path as a single link, so
    a batch can never behave differently from the one-document case.
    """
    total = len(urls)
    built = partial = broken = 0
    lines: list[str] = []
    last_file = ""
    for index, link in enumerate(urls, start=1):
        JOB.say("")
        JOB.say(f"=== document {index} of {total}: {link}")
        with JOB.lock:
            JOB.url = link
        try:
            _download(link, limit, out, jobs, refresh, "", check, placeholder,
                      verify)
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
                      f" rot {built.get('rotate', 1)}" if built else "  unreadable")
        JOB.say(f"  {mark} {got['status']:>3} {size / 1000:8.1f} kB  {candidate[:150]}"
                + (detail or (f"   {http_reason(got)}" if mark == "     " else "")))
    with JOB.lock:
        JOB.verdict = "PROBE DONE"
        JOB.detail = f"page {number}"

def _download(url: str, limit: int, out: str, jobs: int = 12,
              refresh: bool = False, name: str = "", check: bool = True,
              placeholder: bool = True, verify: bool = True) -> None:
    ctx = Ctx(url, jobs)
    ctx.refresh = refresh
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

    for round_number, pause in ((1, 1.0), (2, 3.0)):
        if not failed:
            break
        JOB.say(f"retry {round_number}: {len(failed)} page(s)")
        time.sleep(pause)
        still: list[int] = []
        for number in sorted(failed):
            _n, built, message = ctx.grab(number, force=True, wide=True)
            if built:
                collected[number] = built
                JOB.say(f"page {number}: recovered on retry")
            else:
                still.append(number)
        failed = still
        JOB.set_progress(ok=len(collected), skipped=len(failed))

    # ---- one document, one page size ------------------------------------
    # The size is the MEDIAN of the scans, so a single odd page cannot shape the
    # book. Pages that miss it are refetched once; if most pages miss it, the
    # document simply has mixed page sizes and every sheet keeps its own.
    reference = (0, 0)
    if collected:
        reference = median_page(list(collected.values()))
    mixed = False
    if check and reference[0] and len(collected) >= 8:
        offenders = [
            number for number, page in collected.items()
            if abs(page["width"] / reference[0] - 1) > SIZE_TOLERANCE
            or abs(page["height"] / reference[1] - 1) > SIZE_TOLERANCE]
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
        for number in sorted(failed)[:3]:
            lines = ctx.trace.get(number, [])
            names = len(ctx.tried.get(number, ()))
            JOB.say(f"page {number}: {names} name(s) tried, "
                    f"every one refused ({len(lines)} request(s))")
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
                              uniform=uniform)
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
        JOB.detail = (f"{note_text} · {len(collected)} of {ctx.total} page(s) real"
                      + (f" · {len(failed)} placeholder" if failed else "")
                      + (" · verified" if verify else ""))
    if failed:
        JOB.say("placeholder pages: " + ", ".join(str(n) for n in failed[:60])
                + (" …" if len(failed) > 60 else ""))
        JOB.say("why, page by page: downloads/debug/failed-pages.txt")
        JOB.say("to see every name and answer for one of them: --probe <page>")
    JOB.say(f"written: {target}")

# ---------------------------------------------------------------------------
# page
# ---------------------------------------------------------------------------
SEND_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<title>links queued</title><style>
body{font:15px/1.6 ui-monospace,Menlo,Consolas,monospace;background:#fbfbfa;
 color:#1f2328;max-width:760px;margin:40px auto;padding:0 18px}
li{margin:3px 0} a{color:#0969da} .muted{color:#57606a}
</style></head><body>
<h3>__HEADLINE__</h3>
<ol>__ROWS__</ol>
<p class="muted">__NOTE__</p>
<p><a href="/">back to the panel</a></p>
</body></html>"""


def queue_links(urls: list[str], limit: int, out: str) -> tuple[bool, str]:
    """Start a download of these links, unless a job is already running."""
    with JOB.lock:
        busy = JOB.state == "running"
    if busy:
        return False, "a download is already running — try again when it finishes"
    if not urls:
        return False, "no document links in that request"
    threading.Thread(target=run_job, args=(list(urls), limit, out), daemon=True).start()
    return True, f"queued {len(urls)} link(s)"


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>find and download Scribd documents</title>
<style>
 body{font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:#fbfbfa;color:#1f2328;margin:0;padding:26px 18px 70px}
 .wrap{max-width:1000px;margin:0 auto}
 h1{font-size:19px;margin:0 0 4px}
 h2{font-size:14px;margin:22px 0 8px;color:#57606a;font-weight:600;
  text-transform:uppercase;letter-spacing:.04em}
 .meta{color:#57606a;font-size:13px;margin-bottom:16px}
 input[type=text]{width:100%;box-sizing:border-box;font:inherit;padding:10px;
  border:1px solid #b8c0c8;border-radius:6px;background:#fff}
 input[type=number]{width:86px;font:inherit;padding:8px;border:1px solid #b8c0c8;
  border-radius:6px;background:#fff}
 .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0}
 button{font:inherit;padding:9px 16px;border-radius:6px;border:1px solid #1f6feb;
  background:#1f6feb;color:#fff;cursor:pointer}
 button.ghost{background:#fff;color:#1f6feb}
 button:disabled{opacity:.45;cursor:default}
 .verdict{background:#fff;border:1px solid #d0d7de;border-left:5px solid #9a6700;
  padding:13px 15px;margin:16px 0;white-space:pre-wrap;font-size:16px}
 .ok{border-left-color:#1a7f37} .bad{border-left-color:#b42318}
 pre{background:#0d1117;color:#e6edf3;padding:14px;border-radius:8px;
  overflow:auto;max-height:420px;font-size:12.5px;line-height:1.45;margin:0}
 .muted{color:#57606a;font-size:13px}
 a{color:#0969da}
 #hits{background:#fff;border:1px solid #d0d7de;border-radius:8px;
  max-height:380px;overflow:auto;margin:10px 0}
 #hits:empty{display:none}
 .hit{display:flex;gap:10px;align-items:baseline;padding:8px 12px;
  border-bottom:1px solid #eaeef2;cursor:pointer}
 .hit:last-child{border-bottom:0}
 .hit .t{flex:1}
 .hit .id{color:#8c959f;font-size:12px}
 code.bookmarklet{display:block;background:#0d1117;color:#e6edf3;padding:10px;
  border-radius:6px;font-size:11.5px;overflow:auto;white-space:nowrap}
</style></head><body><div class="wrap">
<h1>Find and download Scribd documents</h1>
<div class="meta" id="meta">ready</div>

<h2>1 · find documents by keyword</h2>
<div class="row"><input type="text" id="q" placeholder="e.g. physics 12th question bank"></div>
<div class="row">
  <label class="muted">result pages <input type="number" id="pages" value="1" min="1" max="10"></label>
  <button id="findbtn">Find</button>
  <button id="dl" class="ghost" disabled>Download ticked</button>
  <span class="muted" id="engines"></span>
</div>
<div id="hits"></div>

<h2>2 · or paste a link yourself</h2>
<div class="row"><input type="text" id="url" value="__SAMPLE__"></div>
<div class="row">
  <label class="muted">pages <input type="number" id="limit" value="0" min="0" title="0 = the whole document"></label>
  <button id="go">Download</button>
  <span class="muted">0 = the whole document · try 5 first</span>
</div>

<h2>3 · or push links from your own browser</h2>
<div class="muted">Open a Scribd search in Chrome, then click this bookmark. It sends
every document link on the page here and starts the download:</div>
<div class="row"><code class="bookmarklet" id="bm">…</code>
  <button class="ghost" id="copybm">Copy</button></div>

<div class="verdict" id="verdict">idle</div>
<div id="file" class="muted"></div>
<pre id="log">(no output yet)</pre>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
let timer = null;
let hits = [];

function render() {
  const box = $('hits');
  box.innerHTML = hits.map((h, i) => `
    <label class="hit">
      <input type="checkbox" data-i="${i}" checked>
      <span class="t">${esc(h.title)}</span>
      <a href="${esc(h.url)}" target="_blank" rel="noreferrer">open</a>
      <span class="id">${esc(h.doc_id)}</span>
    </label>`).join('');
  $('dl').disabled = !hits.length;
  $('dl').textContent = hits.length ? `Download ticked (${hits.length})` : 'Download ticked';
}

function ticked() {
  return [...document.querySelectorAll('#hits input:checked')]
    .map((cb) => hits[+cb.dataset.i].url);
}

async function poll() {
  const s = await (await fetch('/status', {cache: 'no-store'})).json();
  $('log').textContent = s.log.length ? s.log.join('\\n') : '(no output yet)';
  const p = s.progress;
  $('meta').textContent = `${s.state} · ${s.seconds}s · page ${p.page}/${p.of}`
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
  $('go').disabled = running;
  $('dl').disabled = running || !hits.length;
  if (!running && timer) { clearInterval(timer); timer = null; }
}

async function start(urls) {
  if (!urls.length) return;
  const r = await fetch('/run', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({urls, limit: Number($('limit').value) || 0}),
  });
  if (!r.ok) { $('verdict').textContent = (await r.json()).error; return; }
  if (timer) clearInterval(timer);
  poll(); timer = setInterval(poll, 1500);
}

$('findbtn').onclick = async () => {
  const query = $('q').value.trim();
  if (!query) return;
  $('findbtn').disabled = true;
  $('engines').textContent = 'asking the search engines…';
  try {
    const r = await fetch('/find', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query, pages: Number($('pages').value) || 1}),
    });
    const data = await r.json();
    hits = data.hits || [];
    render();
    $('engines').textContent = (data.notes || []).join(' · ') || data.error || '';
    if (!hits.length) $('verdict').textContent = 'NO RESULTS — ' + (data.error || 'nothing answered with links');
  } finally {
    $('findbtn').disabled = false;
  }
};
$('dl').onclick = () => start(ticked());
$('go').onclick = () => {
  const url = $('url').value.trim();
  if (url) start([url]);
};
$('copybm').onclick = async () => {
  try { await navigator.clipboard.writeText($('bm').textContent);
        $('copybm').textContent = 'copied'; } catch (e) {}
};

// The bookmarklet: take every document link on the page you are looking at and
// hand the links to this panel, which does the downloading.
$('bm').textContent =
  "javascript:(()=>{const o=location.origin+'/send?';"
  + "const u=[...document.querySelectorAll('a[href*=\\\"/document/\\\"]')]"
  + ".map(a=>a.href.split('?')[0]).filter((v,i,s)=>s.indexOf(v)===i).slice(0,40);"
  + "if(!u.length){alert('no document links on this page');return}"
  + "location.href=o+u.map(x=>'url='+encodeURIComponent(x)).join('&')})()";

setTimeout(poll, 250);
</script></body></html>"""

def serve(port: int, out: str) -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            pass

        def _send(self, body: bytes, ctype: str, code: int = 200) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
            if path == "/status":
                self._send(json.dumps(JOB.snapshot()).encode(),
                           "application/json; charset=utf-8")
            elif path == "/health":
                self._send(b"ok", "text/plain")
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
                self._send(PAGE.replace("__SAMPLE__", SAMPLE).encode(),
                           "text/html; charset=utf-8")

        def do_POST(self) -> None:  # noqa: N802
            path = urllib.parse.urlparse(self.path).path
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception:  # noqa: BLE001
                payload = {}
            if path == "/find":
                query = str(payload.get("query") or "").strip()
                if not query:
                    self._send(b'{"error":"no query"}', "application/json", 400)
                    return
                pages = max(1, min(int(payload.get("pages") or 1), 10))
                try:
                    hits, notes = find_links(
                        query, pages=pages,
                        log=lambda line: JOB.say("search: " + line))
                except Exception as exc:  # noqa: BLE001
                    self._send(json.dumps(
                        {"hits": [], "notes": [],
                         "error": f"{type(exc).__name__}: {exc}"[:200]}).encode(),
                        "application/json; charset=utf-8", 500)
                    return
                with JOB.lock:
                    JOB.verdict = "FOUND" if hits else "NO RESULTS"
                    JOB.detail = search_sentence(hits, notes)
                self._send(json.dumps(
                    {"hits": hits, "notes": notes,
                     "summary": search_sentence(hits, notes)}).encode(),
                    "application/json; charset=utf-8")
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
            if not urls:
                self._send(b'{"error":"no url"}', "application/json", 400)
                return
            with JOB.lock:
                busy = JOB.state == "running"
            if busy:
                self._send(b'{"error":"already running"}', "application/json", 409)
                return
            limit = int(payload.get("limit") or 0)
            threading.Thread(target=run_job, args=(urls, limit, out),
                             daemon=True).start()
            self._send(json.dumps({"ok": True, "queued": len(urls)}).encode(),
                       "application/json")

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"open http://0.0.0.0:{port}/ — paste a link, press Download", flush=True)
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

    # ---- search: keyword -> links, and never a silent "no results" ----
    ddg_html = (
        '<a class="result__a" href="//duckduckgo.com/l/?uddg='
        'https%3A%2F%2Fwww.scribd.com%2Fdocument%2F750213011%2FPhysics-12th">'
        "Physics 12th question bank</a>"
        '<a class="result__a" href="//duckduckgo.com/l/?uddg='
        'https%3A%2F%2Fwww.scribd.com%2Fdocument%2F750213011%2FPhysics-12th">'
        "Save</a>"
        '<a class="result__a" href="https://www.scribd.com/presentation/804179430/'
        'Book-List">CBSE book list 2024</a>'
        '<a href="https://www.scribd.com/about">About</a>')
    hits = parse_search_links(ddg_html, engine="duckduckgo")
    assert [hit["doc_id"] for hit in hits] == ["750213011", "804179430"], hits
    assert hits[0]["title"] == "Physics 12th question bank", hits[0]
    assert hits[0]["url"] == ("https://www.scribd.com/document/750213011/Physics-12th")
    assert hits[1]["kind"] == "presentation" and hits[1]["doc_id"] == "804179430"

    wrapped = base64.urlsafe_b64encode(
        b"https://www.scribd.com/document/123456789/Some-Book").decode().rstrip("=")
    bing_html = ('<li><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1'
                 + wrapped + '&ntb=1">Some Book &amp; Notes</a></li>')
    bing_hits = parse_search_links(bing_html, engine="bing")
    assert len(bing_hits) == 1 and bing_hits[0]["doc_id"] == "123456789", bing_hits
    assert bing_hits[0]["title"] == "Some Book & Notes", bing_hits[0]

    # a page that only writes the url as text still counts (cite lines, JSON)
    cite_only = ('<div><cite>https://www.scribd.com/document/999999/ExceL-Formulas'
                 '</cite></div>')
    assert parse_search_links(cite_only)[0]["doc_id"] == "999999"
    # and an escaped url, the way Scribd writes them inside its own scripts
    assert parse_search_links('<script>var u="https:\\/\\/www.scribd.com'
                              '\\/document\\/123123\\/x";</script>')[0]["doc_id"] == "123123"
    assert parse_search_links("<a href='/about'>About</a>") == []
    assert parse_search_links("") == []
    assert unwrap_link("https://www.scribd.com/document/1/x").endswith("/document/1/x")
    assert unwrap_link("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa") == (
        "https://example.com/a")
    assert html_escape('<a href="x">&') == "&lt;a href=&quot;x&quot;&gt;&amp;"

    # engines are tried in order and every answer is reported, so "nothing
    # found" can be told apart from "every engine refused this address"
    real_ask = globals()["engine_ask"]
    calls: list[str] = []

    def stub_ask(name, url, method, site_only, query, page, timeout=20.0):
        calls.append(name)
        if name == "duckduckgo":
            return [], "duckduckgo: HTTP 202 (blocked or throttled here)"
        if name == "bing":
            return ([{"doc_id": "555", "kind": "document", "slug": "found",
                      "title": "Found it",
                      "url": "https://www.scribd.com/document/555/found",
                      "engine": name}], "bing: 1 link(s)")
        return [], f"{name}: HTTP 200, 3 kB, no links"

    globals()["engine_ask"] = stub_ask
    try:
        found, notes = find_links("physics", pages=1, limit=5)
        ordered = list(calls)
        calls.clear()
        one, _ = find_links("physics", pages=1, limit=1)
    finally:
        globals()["engine_ask"] = real_ask
    assert [hit["doc_id"] for hit in found] == ["555"], found
    assert ordered[:3] == ["duckduckgo", "duckduckgo-lite", "bing"], ordered
    assert [hit["doc_id"] for hit in one] == ["555"]
    assert calls[:3] == ["duckduckgo", "duckduckgo-lite", "bing"], calls
    assert "mojeek" not in calls, calls            # stops once it has what it needs
    assert any("202" in note for note in notes), notes
    assert search_sentence(found, notes).startswith("1 document(s) found")
    blocked_only = search_sentence([], ["duckduckgo: HTTP 403 (blocked)"])
    assert "no documents found" in blocked_only and "blocked" in blocked_only
    assert find_links("   ") == ([], ["no query"])

    gate = Gate(rate=24.0, floor=8.0, ceiling=60.0)
    for _ in range(40):
        gate.complaint(403)
    assert 8.0 <= gate.rate < 20.0, gate.rate
    hard = Gate(rate=24.0, floor=8.0, ceiling=60.0)
    for _ in range(40):
        hard.complaint(429)
    assert abs(hard.rate - 8.0) < 0.01, hard.rate

    return ("selftest: every check passed — sheet maths, EXIF rotation, "
            "jpeg size traps, pdf verify, cookies, token, names, search parsing")

def main(argv: list[str]) -> int:
    global BASE
    url = ""
    limit = 0
    out = OUT
    cookies = ""
    jobs = 12
    refresh = False
    name = ""
    check = True
    placeholder = True
    verify = True
    probe = 0
    search = ""
    results = 10
    search_pages = 1
    pick = ""
    download_after = False
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in ("--url", "--limit", "--out", "--cookies", "--base",
                   "--jobs", "--name", "--probe", "--search", "--results",
                   "--search-pages", "--pick") and index + 1 < len(argv):
            value = argv[index + 1]
            if arg == "--search":
                search = value
            elif arg == "--results":
                results = max(1, int(value))
            elif arg == "--search-pages":
                search_pages = max(1, int(value))
            elif arg == "--pick":
                pick = value
            elif arg == "--url":
                url = value
            elif arg == "--limit":
                limit = int(value)
            elif arg == "--out":
                out = value
            elif arg == "--cookies":
                cookies = value
            elif arg == "--name":
                name = value
            elif arg == "--probe":
                probe = int(value)
            elif arg == "--jobs":
                jobs = max(1, min(int(value), 32))
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
        elif arg == "--download":
            download_after = True
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
        index += 1
    if cookies:
        os.environ["COOKIES"] = cookies
    if search:
        hits, notes = find_links(search, pages=search_pages, limit=results,
                                 log=lambda line: print("search: " + line, flush=True))
        if not hits:
            print(f"NO RESULTS — {search_sentence(hits, notes)}", flush=True)
            return 1
        for number, hit in enumerate(hits, start=1):
            print(f"{number:3d}. {hit['title'][:84]}")
            print(f"     {hit['url']}")
        wanted = hits
        if pick:
            numbers = {int(part) for part in re.findall(r"\d+", pick)}
            wanted = [hit for number, hit in enumerate(hits, start=1)
                      if number in numbers]
            if not wanted:
                print(f"--pick selected nothing (results 1-{len(hits)})", flush=True)
                return 1
        stem = safe_name(search, "search").replace(" ", "-").lower()
        os.makedirs(out, exist_ok=True)
        listing = os.path.join(out, f"search-{stem}.txt")
        with open(listing, "w", encoding="utf-8") as handle:
            for hit in wanted:
                handle.write(hit["url"] + "\n")
        print(f"{len(wanted)} link(s) saved to {listing}", flush=True)
        if not download_after:
            print("nothing downloaded — add --download to fetch them", flush=True)
            return 0
        if len(wanted) > 1 and not name:
            name = stem
        run_job([hit["url"] for hit in wanted], limit, out, jobs, refresh, "",
                check, placeholder, 0, verify)
        return 0 if JOB.verdict in ("PDF BUILT", "PDF PARTIAL") else 1
    if url:
        run_job(url, limit, out, jobs, refresh, name, check, placeholder, probe,
                verify)
        return 0 if JOB.verdict in ("PDF BUILT", "PROBE DONE") else 1
    port = int(os.environ.get("SERVER_PORT") or os.environ.get("PORT") or 8090)
    serve(port, out)
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
