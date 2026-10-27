#!/usr/bin/env python3
"""Scribd panel — configuration, cookies, network, tokens, links and helpers.

The source is six files, each roughly 1,000-1,500 lines, grouped by
responsibility. scribd_download.py is the loader; the others are
scribd_pages.py, scribd_jobs.py, scribd_shots.py, scribd_panel.py and
scribd_selftest.py. The loader runs them in order in one shared namespace;
tools/build_scribd_singlefile.py makes a one-file deployment copy.

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
