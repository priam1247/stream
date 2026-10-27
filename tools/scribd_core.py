#!/usr/bin/env python3
"""scribd_download.py — Scribd panel. Modular source.

The source is four files: scribd_download.py (this loader), scribd_core.py,
scribd_jobs.py and scribd_panel.py. The loader runs the three source files in
order in one shared namespace; tools/build_scribd_singlefile.py makes a
one-file deployment copy.

Turns Scribd documents into clean PDFs, one document page per sheet, with no
pip install and no Python framework.

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
not refuse it: the panel already reads Scribd pages to build the PDFs.
The old failure was asking Google/Bing/DuckDuckGo for `site:scribd.com`; this
asks Scribd directly, which is the same thing its own search box does. The one
honest caveat: /search/query is not a documented API — it is the endpoint the
site's own JavaScript calls. If Scribd changes it, the page says so in plain
words instead of pretending there are no results.

What 3.0 removed: SCANNING. Every page of every document is photographed.
  There used to be two loads and one request decided which: a document that
  answered with words was photographed, a document that named page images had
  those images fetched from Scribd. That choice was a guess about a document, and
  a wrong guess was a whole book that came out blank or failed outright. So the
  second load is gone — deleted, not switched off:
  1. No SCRIBD_SCANS, no SCRIBD_SHOTS_ONLY, no --scans. A switch that turns a
     route off leaves the route in the file, and the next reader cannot tell
     whether it runs. --scans now prints that it is gone and carries on.
  2. Gone with it: the name ladder that fetched a page as an image
     (primaries_for, candidates_for, descriptor, deep, attempt, grab), the page
     image cache, the cover-scan block, the parallel scan pool, the stand-in
     fingerprint list and the repeated-picture test, the size offenders and their
     refetch, and the preview/cut-short reports. 400 lines of a route nothing
     takes any more.
  3. What is kept is what a photograph needs: the viewer's own words for each
     page (laid underneath, invisible, so the PDF stays searchable), the image
     reader that turns a picture into a PDF stream, and the throttle breaker.
  4. One window per page: the browser opens each page's own address, measures
     that page's bounds in that window and photographs exactly those bounds, so
     no capture can carry a neighbour's edge. Pages are photographed with
     bounded concurrency and assembled in the document's order. Nothing is
     fetched twice and nothing is refetched, because there is no second copy of
     a photograph to ask for.

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
     (3 and 4 are history: 2.37 removed the retry rounds altogether. In every
     run since, a retry never once found a page that was missing, and the rounds
     cost a document up to a minute of standing still. A page nobody sends is
     photographed, or left out and named — never waited for. What remains of this
     list is the throttle breaker's short rests, which do help.)
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
  5. Nothing re-fetches in bulk, and nothing re-fetches at all: every page is a
     photograph cut at the column's own size, so there is no second copy of a
     page to go and ask for.

What 2.4 fixed in your COOKIES
  2.3 sent every cookie in the file to scribd.com (on one export: 46 scribd
  cookies plus 3794 cookies for 479 other sites). Now only scribd.com and
  scribdassets.com are sent, expired ones are dropped, and the log says how many
  were kept and how many other sites were left out. Values are never printed.

How a document is downloaded, plain HTTPS with your cookies:
  1. read the document page and the embed viewer
  2. photograph every page: one window per page, opened at that page's own
     address, the page's bounds measured in it and the clip exactly those
     bounds — checked against the picture that comes back
  3. read the document's own words for each page and lay them underneath its
     photograph, invisible, so the finished PDF is searchable and copyable
  4. assemble the pages in order — a picture goes in as its own filtered stream
     (predictor 15, no pixel loop) — then read the finished PDF back and
     validate it before calling it done

There is ONE load, and every document goes down it: a browser photographs what
the viewer shows. A converted upload (a docx, a pdf of text) and a scanned
upload are drawn by the same viewer, so the photograph is the page for both, and
no page of either is fetched from Scribd as an image. That second load is gone —
removed, not switched off: no environment word and no flag brings it back,
because two routes meant two ways to be wrong about a page, and which one ran
was decided by a guess. A page whose bounds cannot be measured, or whose
picture does not match them, is failed and named; a page no photograph reached
is asked for its words and drawn with them; a
page with neither is left out of the PDF and named in the verdict. Every url
tried for a failed page is recorded. A browser photographs a page nobody sent us
(--shots / SCRIBD_SHOTS), because a page nobody sent is still a page somebody
can see — and if that browser is not running, the engine starts it itself. Only
when no browser can exist at all is the page left out of the PDF and named. A
page is never grey: no sheet is ever drawn for a page that has nothing on it.

A document that is text rather than scans gets the same care: the viewer's own
look is photographed page by page whenever a browser runs or can be started,
and the words stay underneath as a hidden searchable layer. The retypeset words
sheet is the last resort for when no browser exists — the content survives, and
the PDF says which pages are which.

Options: --find "TEXT", --pages N, --pick 1,3, --url LINK (repeatable), --links "TEXT",
         --limit N, --out DIR, --cookies PATH, --base URL, --jobs N (default 12),
         --shots URL (a browser service that photographs a page we could not build),
         --text (put each page's words in the PDF, searchable and copyable),
         --name TITLE, --no-check, --no-placeholder, --no-verify,
         --verify FILE, --probe N, --selftest

Panel options (environment, all optional):
  PANEL_KEY / SCRIBD_PANEL_KEY   lock the panel (X-Panel-Key, ?key=, or cookie)
  PANEL_ORIGIN                   comma-separated browser origins allowed by CORS
  SERVER_PORT / PORT             port to listen on
  SCRIBD_SHOTS                   a browser service that photographs a page this
                                 panel could not build (troy-search's /shot);
                                 SCRIBD_SHOT_SCALE (default 1: standard
                                 quality, the page at the size the viewer draws
                                 it; 2 is the same sheet in the PDF at twice the
                                 detail and four times the bytes) and
                                 SCRIBD_SHOT_TIMEOUT (default 120) tune it.
                                 With none set, everything works as before — the
                                 addresses written into SHOT_HOSTS are asked in
                                 order (the browser egg's own assigned endpoint
                                 among them), the egg's host is swept once if
                                 none of them answers, and the answer is kept in
                                 tools/shooter-found.txt.
  SCRIBD_SCRAPE_DO               token for the scrape route asked after a 403;
                                 empty closes that door

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
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "3.5"
SAMPLE = "https://www.scribd.com/document/751945245"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
OUT = "downloads"
PANEL_PORT = int(os.environ.get("SCRIBD_PANEL_PORT") or 25811)
DOC_MARKERS = (b"docManager", b"page_count", b"document_detail", b"outer_page")
CHALLENGE = (b"just a moment", b"cf-chl", b"attention required")
# Scribd writes an asset name with a scheme, without one (`//html.scribdassets…`)
# and inside JSON (`https:\/\/…`). It is the same name in all three shapes, so
# the patterns accept all three and Names normalises them on the way in.
URL_HEAD = r"(?:https?:)?//"
IMAGE_RE = re.compile(
    URL_HEAD + r"[^\s\"'\\<>]+/images/(\d+)-[0-9A-Za-z]+\.(?:jpe?g|png|webp)"
    r"(?:\?[^\s\"'\\<>]*)?", re.IGNORECASE)
JSONP_RE = re.compile(
    URL_HEAD + r"[^\s\"'\\<>]+/pages/(\d+)-[0-9A-Za-z]+\.jsonp"
    r"(?:\?[^\s\"'\\<>]*)?", re.IGNORECASE)
ASSET_RE = re.compile(
    URL_HEAD + r"[^\s\"'\\<>()]+?/(?:images|pages)/\d+-[0-9A-Za-z]+"
    r"\.(?:jpe?g|png|webp|jsonp|json)(?:\?[^\s\"'\\<>()]*)?", re.IGNORECASE)
SCAN_RE = re.compile(r"\.(?:jpe?g|png|webp)(?:\?|$)", re.IGNORECASE)
TOKEN_RE = re.compile(r"[?&]token=([A-Za-z0-9._\-%]+)", re.IGNORECASE)
# The viewer writes the scan token in more than one shape. `?token=` was the
# original; newer builds write it as JSON (`"token":"…"`), as a camelCase key
# (`"imageToken":"…"`), or just leave the bare JWT in the page. A bare `eyJ…`
# blob is unambiguous: nothing else on a Scribd page looks like that.
TOKEN_SHAPES = (
    re.compile(r"[?&]token=([A-Za-z0-9._\-%]{16,})", re.IGNORECASE),
    re.compile(r"[\"'](?:token|imageToken|image_token|pageToken|accessToken|"
               r"access_token|viewerToken|readToken)[\"']\s*:\s*[\"']"
               r"([A-Za-z0-9._\-%]{16,})[\"']", re.IGNORECASE),
    re.compile(r"\btoken(?:=|%3D)([A-Za-z0-9._\-%]{16,})", re.IGNORECASE),
    # a bare JWT: three base64url segments, the first two of which are JSON
    re.compile(r"(?<![A-Za-z0-9_\-])(eyJ[A-Za-z0-9_\-]*\."
               r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)"),
)
VIEWER_WINDOWS = 6          # how many windows of the viewer page to walk
NO_HOPE_RESTS = 2           # rests before "nothing has ever arrived" is final
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
# How long one document in a bulk queue may spend getting nothing but refusals
# before it drops itself. Twenty seconds is long enough to prove the refusals
# are not a momentary throttle — three pages refused, or a rest already taken
# that changed nothing — and short enough that 38 waiting books do not spend
# the evening on one that will never come. Zero switches the queue impatience
# off — the drop — and every document then
# fights to the end even with a queue behind it, which is how 2.27 behaved.
QUEUE_DROP_AFTER = float(os.environ.get("SCRIBD_QUEUE_DROP_AFTER", "20"))
# Missing pages are NOT retried. A page Scribd refuses is refused for a reason,
# and round after round of the very same request has never once brought a page
# back — it only spends the reader's minutes and holds the queue behind it. What
# arrived is kept; a missing page is photographed if a browser is on hand, and
# otherwise left out of the PDF and named in the verdict. Never grey, never
# retried. The only rests left are the throttle breaker's, bounded by
# REST_BUDGET, and a document with a browser waiting rests less:
SHOT_REST_BUDGET = float(os.environ.get("SCRIBD_SHOT_REST_BUDGET", "12"))
# Resting is part of that budget and has its own cap, so a document whose pages
# are simply not served cannot spend minutes of the reader's time being polite
# to a refusal that never clears.
REST_BUDGET = float(os.environ.get("SCRIBD_REST_BUDGET", "60"))
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
PREVIEW_MIN_PX = 80                # below this a picture is a small preview
ABSOLUTE_MIN_PX = 16               # below this it is noise, not a page
ASPECT_RANGE = (0.4, 3.0)          # width / height

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
# One load: a browser photographs what the viewer shows, for every document.
# Fetching Scribd's own page images was the other load, and it is gone — not
# switched off, removed. There is no SCRIBD_SCANS, no SCRIBD_SHOTS_ONLY and no
# --scans: a switch that turns a route off leaves the route in the file, and the
# next reader cannot tell whether it runs.
_POOL = threading.local()

def rebase(url: str) -> str:
    if not BASE:
        return url
    parsed = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit(
        (urllib.parse.urlsplit(BASE).scheme, urllib.parse.urlsplit(BASE).netloc,
         parsed.path, parsed.query, ""))

def full_url(url: str) -> str:
    """A name always begins with https://, however the page wrote it.

    Scribd writes the same asset as `https://html…`, `//html…` and
    `https:\\/\\/html…`; the last is already `text_of()`'s job. The first two
    are normalised here so a name seen in one shape matches the same name seen
    in another, and so `fetch()` never has to guess a scheme.
    """
    url = (url or "").strip().strip("\"'")
    if not url:
        return ""
    if url.startswith("//"):
        return "https:" + url
    if url.startswith(("http://", "https://")):
        return url
    return ""


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

# The scrape route: a second door for the moments Scribd's front door refuses
# the address this panel runs on (a 403 that is about the address, not about the
# page). Direct requests stay first and carry the session; the route is asked
# only after a refusal, only for Scribd's own public hosts, never in local
# tests, and at most SCRAPE_BUDGET times per document so a blocked address
# cannot spend the route's quota forever. It carries NO cookies — the tokens a
# page needs ride inside the URL, and a session is not a thing to hand a
# third party. SCRIBD_SCRAPE_DO replaces the written-down token; an empty one
# ("SCRIBD_SCRAPE_DO=") closes the door altogether.
SCRAPE_DO = os.environ.get("SCRIBD_SCRAPE_DO",
                           "08f4411be1ab4315a77eabfa981d4f3f277af459e57").strip()
SCRAPE_REFUSED = (403, 429, 503)
SCRAPE_BUDGET = 40
SCRAPE_HOSTS = ("scribd.com", "scribdassets.com")
_scrape_left = [SCRAPE_BUDGET]
_scrape_lock = threading.Lock()
_scrape_said = [False]


def scrape_url(target: str) -> str:
    """The route's own address for one target page."""
    return ("https://api.scrape.do/?token=" + SCRAPE_DO +
            "&url=" + urllib.parse.quote(target, safe=""))


def _scrape_open(netloc: str) -> bool:
    """May this host be asked through the route at all?"""
    if not SCRAPE_DO:
        return False
    host = netloc.split("@")[-1].split(":")[0].lower()
    return any(host == wanted or host.endswith("." + wanted)
               for wanted in SCRAPE_HOSTS)


def _scrape_take() -> bool:
    """One unit of the per-document budget. -> still allowed."""
    with _scrape_lock:
        if _scrape_left[0] <= 0:
            return False
        _scrape_left[0] -= 1
        return True


def _scrape_get(target: str, timeout: float) -> dict | None:
    """One answer through the route, or None when the route itself failed."""
    if not _scrape_take():
        return None
    status, body, error = shot_get(scrape_url(target), timeout)
    if status == 200 and body:
        return {"status": 200, "body": body, "headers": {}, "error": "",
                "via": "scrape route"}
    with _scrape_lock:
        said = _scrape_said[0]
        _scrape_said[0] = True
    if not said:
        JOB.say(f"the scrape route could not help either — "
                f"{error or ('http ' + str(status))}"[:200])
    return None


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
        if status in SCRAPE_REFUSED and _scrape_open(parsed.netloc):
            through = _scrape_get(target, timeout)
            if through is not None:
                with _scrape_lock:
                    said = _scrape_said[0]
                    _scrape_said[0] = True
                if not said:
                    JOB.say(f"the front door answered {status} — the same page "
                            f"came through the scrape route instead")
                return through
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


def jsonp_for_page(url: str, number: int) -> str:
    """That page's descriptor, built on a pattern the document already names.

    A converted document may name an asset for one page only (page 1 keeps its
    scan). The other pages still have descriptors; their address is the same
    shape with another page number, so it can be built instead of guessed.
    """
    swapped = jsonp_from_image(url) or url
    return re.sub(r"/(pages|images)/\d+-", lambda m: f"/{m.group(1)}/{number}-",
                  swapped, count=1)


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

def jwt_claims(token: str) -> dict:
    """What a Scribd asset token says besides its expiry: the CDN folder
    (`format_uuid`) and the window of pages the CDN will actually serve
    (`page_min`, `page_max`, `enforce`).

    Read, not trusted: the payload is plain base64url json that Scribd hands to
    every anonymous viewer, and it is used for one decision only — which pages
    are worth asking for. A preview-limited document says so here, in its own
    token, before a single request is spent finding out the hard way.
    """
    parts = (token or "").split(".")
    if len(parts) < 2:
        return {}
    try:
        raw = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        claims = json.loads(raw.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return {}
    return claims if isinstance(claims, dict) else {}


def unlocked_range(claims: dict, total: int) -> tuple[int, int]:
    """The pages the CDN serves: all of them, unless the token enforces a
    preview window. Garbage in the claims means no window at all."""
    if not claims.get("enforce"):
        return 1, total
    try:
        low = max(1, int(claims.get("page_min") or 1))
        high = min(total, int(claims.get("page_max") or total))
    except (TypeError, ValueError):
        return 1, total
    return (low, high) if low <= high else (1, total)


def jsonp_variants_of(jsonp: str, token: str) -> list[str]:
    """The names to ask a descriptor by, no-token FIRST.

    The CDN's /pages/ path wants no token at all, and a token that has expired
    is not neutral: carrying it is a 403 that counts against the address. So
    the bare name goes first and the tokened one is the fallback, never the
    other way round.
    """
    out: list[str] = []
    for candidate in (strip_token(jsonp), with_token(jsonp, token)):
        if candidate and candidate not in out:
            out.append(candidate)
    return out


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

def harvest_token(body: bytes, where: str = "") -> str:
    """Find the scan token wherever it is written, and refuse the fake ones.

    v2.16 looks for four shapes, because the panel's log said
    `image token: none on the page` for scanned uploads while the same page in a
    browser served its scans: the token was in the body, just not as `?token=`.
    """
    scored: list[tuple[tuple[int, int], str, str]] = []
    seen: set[str] = set()
    text = text_of(body)
    for variant in (text, urllib.parse.unquote(text)):
        for index, shape in enumerate(TOKEN_SHAPES):
            for match in shape.finditer(variant):
                for candidate in (match.group(1), urllib.parse.unquote(match.group(1))):
                    candidate = candidate.strip("\"'")
                    if candidate in seen or not usable_token(candidate):
                        continue
                    seen.add(candidate)
                    scored.append((token_score(candidate), candidate, f"shape {index + 1}"))
    if not scored:
        return ""
    scored.sort(key=lambda row: row[0], reverse=True)
    best = scored[0]
    if where:
        JOB.say(f"image token: found in the {where} ({best[2]}, "
                f"{'jwt' if jwt_ok(best[1]) else 'plain'})")
    return best[1]

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

def redact(text: str, limit: int = 150) -> str:
    """A URL or body line safe to paste into a chat window.

    Probe output is meant to be shared — with a person, in an issue — so every
    token in it is replaced before printing. A cookie or a token in a screenshot
    is a leaked account; this is the one place that could happen by accident.
    """
    out = str(text or "")
    for shape in TOKEN_SHAPES:
        out = shape.sub(lambda m: m.group(0).replace(m.group(1), "REDACTED"), out)
    out = re.sub(r"([?&](?:key|access_key|sid)=)[A-Za-z0-9._%\-]{8,}",
                 r"\1REDACTED", out)
    out = " ".join(out.split())
    return out[:limit]


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
    its pages' words in `cache/` — which is what makes re-running a partial cheap,
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
    """The largest picture in the file that could be a page at all.

    v2.16 stopped excluding pages. A scanned upload often serves odd sizes —
    a 60x80 strip, a double-page spread far outside a page's aspect, a 349x383
    thumbnail — and a small or odd-looking page is still that page's content.
    A blank placeholder is strictly worse than a poor scan, so the rule is now:
    take the biggest frame that is not a 1-pixel smudge, whatever its shape.
    """
    best = (0, 0, 0)
    for width, height, components in frames:
        if min(width, height) < ABSOLUTE_MIN_PX:
            continue
        # prefer a page-shaped frame of the same area, but never insist
        if width * height > best[0] * best[1]:
            best = (width, height, components or 3)
    return best


def best_frame_any_shape(frames: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """The largest frame, page-shaped or not — the last resort before a blank."""
    usable = [frame for frame in frames if min(frame[0], frame[1]) >= ABSOLUTE_MIN_PX]
    if not usable:
        return 0, 0, 0
    return max(usable, key=lambda frame: frame[0] * frame[1])


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
    """One page picture -> {'payload','params','width','height','rotate','label'}.

    The picture is a browser's photograph of a page; nothing else feeds this any
    more.

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
                    # even an odd-shaped or tiny page beats a blank placeholder
                    width, height, components = best_frame_any_shape(frames)
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
    real = ([page for page in pages
             if not page.get("preview") and not page.get("shot")] or pages)
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

# Helvetica's own advance widths, in 1/1000 of the font size, for characters
# 32..126 — the Adobe AFM numbers. A guessed average either runs a line off the
# right edge of the sheet or leaves a third of it empty; these are the widths
# the reader's PDF viewer will actually use.
HELVETICA_WIDTHS = (
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
    278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
    584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
    833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
    278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
    500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
    500, 334, 260, 334, 584,
)
TEXT_CHAR_EM = 0.556          # a fallback for characters outside that table


def text_width(text: str, size: float) -> float:
    """How wide this string really is in Helvetica at this size, in points."""
    total = 0.0
    for char in text:
        code = ord(char)
        if 32 <= code <= 126:
            total += HELVETICA_WIDTHS[code - 32]
        elif char in "\u00a0\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u2022":
            total += 556
        else:
            total += TEXT_CHAR_EM * 1000
    return total / 1000.0 * size


def wrap_to_width(words: str, width: float, size: float) -> list[str]:
    """Break lines at spaces using the real widths, so nothing overflows."""
    lines: list[str] = []
    for paragraph in (words or "").replace("\r", "").split("\n"):
        paragraph = " ".join(paragraph.split())
        if not paragraph:
            continue                       # no blank lines: they only eat room
        current = ""
        for word in paragraph.split(" "):
            # one word wider than the line still has to be broken somewhere,
            # or it hangs over the right edge of the sheet
            while text_width(word, size) > width and len(word) > 1:
                if current:
                    lines.append(current)
                    current = ""
                cut = len(word)
                while cut > 1 and text_width(word[:cut], size) > width:
                    cut -= 1
                lines.append(word[:cut])
                word = word[cut:]
            candidate = f"{current} {word}".strip()
            if not current or text_width(candidate, size) <= width:
                current = candidate
                continue
            lines.append(current)
            current = word
        if current:
            lines.append(current)
    return lines
WINANSI_STAND_IN = {
    0x2010: "-", 0x2011: "-", 0x2012: "-", 0x2015: "-", 0x2212: "-",
    0x00A0: " ", 0x2007: " ", 0x2008: " ", 0x2009: " ", 0x200A: " ",
    0x200B: "", 0x200E: "", 0x200F: "", 0xFEFF: "",
    0x2044: "/", 0x2219: "\xb7", 0x00AD: "",
}


# Helvetica is base-14 WinAnsi, which is cp1252 — not Latin-1. The curly quotes,
# dashes and ellipsis a Word document is full of are cp1252 bytes, so a character
# is kept whenever cp1252 can spell it. Dropped, they turned "ZAM’KATIMU" into
# "ZAMKATIMU" and swallowed the dotted leaders of a contents page; written as
# the wrong byte, they became "?".
def can_winansi(char: str) -> bool:
    """Can Helvetica's WinAnsi encoding spell this character at all?"""
    try:
        char.encode("cp1252")
    except UnicodeEncodeError:
        return False
    return True


def pdf_visible_text(text: str) -> str:
    """Escape a string for a PDF literal, in the characters WinAnsi can spell.

    Brackets and backslashes must be escaped or the string ends the content
    stream early. Curly quotes, dashes and the ellipsis are kept exactly as
    written — the stream is written as cp1252, which is what WinAnsi means.
    """
    out: list[str] = []
    for char in text:
        if char in "()\\":
            out.append("\\" + char)
        elif 32 <= ord(char) <= 126:
            out.append(char)
        elif can_winansi(char):
            out.append(char)
        elif ord(char) in WINANSI_STAND_IN:
            out.append(WINANSI_STAND_IN[ord(char)])
        elif char == "\t":
            out.append(" ")
    return "".join(out)


TEXT_SIZES = (10.5, 9.5, 8.5, 7.5, 6.5, 5.5)


SHOT_BLANK_ROWS = 12.0


def looks_blank_shot(size: int, height: int) -> bool:
    """Is a photographed sheet nothing but paper?

    Bytes per row, not bytes per pixel — the browser side judges the very same
    PNG at the very same number, and a pixel measure moves with the width of the
    shot, so one page would look four times emptier at 2x than at 1x. Rows are
    stable: a white sheet compresses to a handful of bytes per row whatever its
    width, and a page with writing on it stays an order of magnitude above that.
    A page with one paragraph on it is sparse, not empty, and is kept in silence.
    """
    if size <= 0 or height <= 0:
        return False                       # nothing to judge by: keep the picture
    return size / height < SHOT_BLANK_ROWS


def sheet_scale(sheet: tuple[float, float]) -> float:
    """How big this sheet is against an A4 page, for sizes and margins.

    A Word document's page comes through at whatever the viewer's scan was —
    900x1200 pt is not rare — and 10.5 pt on a sheet that big looks like a
    footnote in the corner. Type is sized against the sheet, not against an
    absolute number, so a page reads the same at any page size.
    """
    return max(0.6, min(2.5, min(sheet[0] / 595.0, sheet[1] / 842.0)))


def text_body_page(words: str, sheet: tuple[float, float],
                   report: list[int] | None = None) -> tuple[bytes, int]:
    """A whole sheet of readable text — for a document page that is text.

    Not every Scribd document is a stack of scans. Plenty are converted
    documents: the viewer renders each page's *words* (HTML), and there is no
    image to download for most pages at all. Those pages used to come out as
    "scan not available" placeholders while the same document read perfectly in
    a browser — because the words were one request away and nothing asked.

    Two things make the sheet look like the page and not like a paragraph:
    the lines keep the vertical places the viewer gave them (a contents page
    stays a contents page), and the type is sized against the sheet.

    Returns (content stream, lines actually drawn). `report`, if given, gets a
    1 appended when the page's spacing or type had to be squeezed to fit the
    sheet — squeezed, never cut: every line the document has gets drawn.
    """
    scale = sheet_scale(sheet)
    margin = 46.0 * scale
    usable_w = max(40.0, sheet[0] - 2 * margin)
    usable_h = max(40.0, sheet[1] - 2 * margin)
    if not words_plain(words).strip():
        return b"", 0
    lines, places = decode_page_lines(words)
    lines = [line.rstrip() for line in lines]
    if not any(line.strip() for line in lines):
        return b"", 0

    body = ["BT 0 0 0 rg"]
    drawn = 0

    if places is not None and len([line for line in lines if line.strip()]) >= 2:
        # the viewer placed these lines: draw them where it placed them
        gaps = sorted({round(b - a, 4) for a, b in zip(places, places[1:])
                       if b - a > 0.0005})
        step = (gaps[len(gaps) // 2] * usable_h) if gaps else usable_h / len(lines)
        size = max(4.0 * scale, min(12.0 * scale, step / 1.30))
        # a contents line is one line: shrink the type until the longest one
        # fits the sheet instead of breaking its dots across two
        widest = max((text_width(pdf_visible_text(line), 1.0) for line in lines),
                     default=0.0)
        if widest:
            size = min(size, usable_w / widest)
        size = max(3.5 * scale, size)
        top = sheet[1] - margin - size
        entries: list[tuple[float, int, str]] = []
        for line, place in zip(lines, places):
            if not line.strip():
                continue
            # the row of a contents page is spaced with spaces; keep them
            pieces = ([line] if text_width(line, size) <= usable_w
                      else wrap_to_width(line, usable_w, size))
            entries += [(place, offset, piece)
                        for offset, piece in enumerate(pieces)]
        # Every line the viewer placed gets drawn. A page whose last line sits
        # below this sheet used to lose it (and everything after it) to a cut;
        # now the whole column squeezes proportionally instead — the lines keep
        # their order and their relative places, the page keeps its words.
        drops = [place * (usable_h - size) + offset * size * 1.30
                 for place, offset, _ in entries]
        allowed = usable_h - size
        deepest = max(drops) if drops else 0.0
        k = min(1.0, allowed / deepest) if deepest > allowed else 1.0
        if k < 0.80:
            # squeeze the type a little before squeezing the spacing hard
            size = max(3.5 * scale, size * k / 0.80)
            drops = [place * (usable_h - size) + offset * size * 1.30
                     for place, offset, _ in entries]
            deepest = max(drops) if drops else 0.0
            allowed = usable_h - size
            k = min(1.0, allowed / deepest) if deepest > allowed else 1.0
        if k < 1.0 and report is not None:
            report.append(1)
        for (_place, _offset, piece), drop in zip(entries, drops):
            y = top - drop * k
            body.append(f"/F1 {size:.2f} Tf 1 0 0 1 {margin:.2f} {y:.2f} Tm "
                        f"({pdf_visible_text(piece)}) Tj")
            drawn += 1
        body.append("ET")
        return "\n".join(body).encode("cp1252", "replace"), drawn

    chosen = TEXT_SIZES[-1] * scale
    leading = chosen * 1.32
    flow: list[str] = []
    for base in TEXT_SIZES:
        size = round(base * scale, 2)
        leading = round(size * 1.32, 2)
        flow = wrap_to_width("\n".join(lines), usable_w, size)
        chosen = size
        if len(flow) * leading <= usable_h:
            break
    # a page with no placement keeps normal line spacing from the top: that is
    # what a browser does with plain paragraphs too. The corner-of-the-sheet
    # look was never the spacing — it was the type, sized against the sheet now.
    room = max(1, int(usable_h / leading))
    if len(flow) > room:
        # tighten the leading until every line fits: the lines are the page,
        # and dropping the last ones to keep the spacing pretty was the old bug
        leading = usable_h / len(flow)
        room = len(flow)
        if report is not None:
            report.append(1)
    drawn_lines = flow[:room]
    top = sheet[1] - margin - chosen
    body.append(f"/F1 {chosen:.2f} Tf")
    for index, line in enumerate(drawn_lines):
        if not line:
            continue
        body.append(f"1 0 0 1 {margin:.2f} {top - index * leading:.2f} Tm "
                    f"({pdf_visible_text(line)}) Tj")
    drawn = len([line for line in drawn_lines if line])
    body.append("ET")
    return "\n".join(body).encode("cp1252", "replace"), drawn


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
    return "\n".join(body).encode("cp1252", "replace")


def build_pdf(pages: list[dict | None], path: str, title: str = "",
              author: str = "", uniform: bool = True,
              texts: dict[int, str] | None = None,
              text_pages: dict[int, str] | None = None) -> tuple[bool, str]:
    """pages: [{'payload','params','width','height','rotate'}|None] in sheet order.

    None with words in `text_pages` becomes a readable text sheet. None with
    nothing — no photograph, no words — is OMITTED: the sheet is not drawn and
    the note says how many went missing. A grey placeholder sheet is never drawn,
    because a book that silently contains grey leaves is worse than a book that
    says which pages it could not get.
    uniform=False gives every sheet the MediaBox of the page on it.
    """
    real = [page for page in pages if page]
    text_pages = {number: words for number, words in (text_pages or {}).items()
                  if (words or "").strip()}
    if not real and not text_pages:
        return False, "no pages to write"
    house = house_sheet(real) if real else (595.0, 842.0)   # A4 for a text doc
    texts = texts or {}
    with_text = 0
    from_text = 0
    short: list[int] = []
    missing: list[int] = []

    objects: list[bytes] = [b"", b"", b""]     # 1 catalog, 2 pages, 3 font
    objects[2] = (b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
                  b"/Encoding /WinAnsiEncoding >>")
    kids: list[int] = []

    for index, page in enumerate(pages, start=1):
        if page is None and text_pages.get(index):
            sheet = house
            cut: list[int] = []
            content, drawn = text_body_page(text_pages[index], sheet, cut)
            if drawn:
                from_text += 1
            if cut:
                short.append(index)
            objects.append(b"<< /Length " + str(len(content)).encode()
                           + b" >>\nstream\n" + content + b"\nendstream")
            content_num = len(objects)
            objects.append(
                (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {sheet[0]} {sheet[1]}]"
                 f" /Resources << /ProcSet [/PDF /Text] /Font << /F1 3 0 R >> >>"
                 f" /Contents {content_num} 0 R >>").encode())
            kids.append(len(objects))
            continue

        if page is None:
            # Nothing arrived for this page from any source. It is left out
            # and named in the note: a grey sheet is not a page and not an
            # answer, and readers deserve the truth in words, not in leaves.
            missing.append(index)
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
        layer = text_layer(words_plain(texts.get(index, "")), box) if texts else b""
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
    blanks = sum(1 for position, page in enumerate(pages, start=1)
                 if page is None and not text_pages.get(position))
    return True, (f"{len(kids)} sheet(s), {len(out) / 1_000_000:.2f} MB"
                  + (f", {from_text} page(s) from the document's text"
                     if from_text else "")
                  + (f", {blanks} page(s) omitted — no photograph, no "
                     f"words" if blanks else "")
                  + (f", {with_text} page(s) with searchable text" if texts
                     and with_text else "")
                  + (f", {len(short)} page(s) squeezed to fit the sheet "
                   f"(nothing dropped)"
                     if short else ""))

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
