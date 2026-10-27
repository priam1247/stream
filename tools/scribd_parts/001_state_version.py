#!/usr/bin/env python3
"""scribd_download.py — Scribd panel. Version 3.1 (split source).

The source is split into tools/scribd_parts/*.py — one fragment per top-level
function or class. tools/scribd_download.py loads them in MANIFEST.json order;
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
