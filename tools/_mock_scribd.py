#!/usr/bin/env python3
"""Local stand-in for Scribd, to test the panel end to end without the network.

  GET /document/<id>   document html naming 2 pages
  GET /embeds/<id>     the viewer shell
  GET /images/...      a small synthetic page scan (some pages can be a low-res
                       copy, or a transfer cut in half)
  GET /pages/...jsonp  one page's words, the way Scribd sends them
  GET /services/oembed title/author
  GET /search/query    Scribd's own search answer (2 documents, then nothing)
"""
import json
import os
import struct
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8910
PAGES = int(os.environ.get("MOCK_PAGES", "2"))
# MOCK_THROTTLE_AFTER=n: after n page scans, refuse everything for a while, the
# way the real CDN does when a job goes too fast. MOCK_THROTTLE_FOR=seconds.
THROTTLE_AFTER = int(os.environ.get("MOCK_THROTTLE_AFTER", "0"))
THROTTLE_FOR = float(os.environ.get("MOCK_THROTTLE_FOR", "5"))
# MOCK_TEXT_DOC=1: a converted document, like most Scribd uploads — page 1 has a
# scan, every other page is TEXT the viewer renders. No image exists for those
# pages, which is what used to produce 37 "scan not available" sheets.
# MOCK_TEXT_DOC=2: the harder shape — the page names ONE asset in total (page
# 1's scan) and nothing at all for the other pages. Their descriptor addresses
# have to be built from the one that is named.
TEXT_DOC = os.environ.get("MOCK_TEXT_DOC", "") in ("1", "2")
ONE_ASSET = os.environ.get("MOCK_TEXT_DOC", "") == "2"
# MOCK_NO_DESCRIPTORS=1: every /pages/*.jsonp answers 403, like a document whose
# per-page descriptors are not served at all. Then the viewer's own page is the
# only place the words exist — the shape that produced the 37 blank sheets.
NO_DESCRIPTORS = os.environ.get("MOCK_NO_DESCRIPTORS", "") == "1"
# MOCK_VIEWER_WINDOW=n: the viewer page hands out n pages per answer and the
# rest only when asked with ?start_page=…, the way the real viewer does for a
# long document. 0 = all pages at once.
VIEWER_WINDOW = int(os.environ.get("MOCK_VIEWER_WINDOW", "0"))
# MOCK_VIEWER_EMPTY=1: the viewer page is a JavaScript shell with no text in the
# HTML at all, so there is nothing to read and nothing may be invented.
VIEWER_EMPTY = os.environ.get("MOCK_VIEWER_EMPTY", "") == "1"
# MOCK_DELAY_MS=n: make every page answer take n milliseconds, so a test can
# look at a job while it is genuinely still running
DELAY_MS = float(os.environ.get("MOCK_DELAY_MS", "0"))
# MOCK_LOCK_PAGE=n: this page is always 403, never recovers (a locked page)
LOCK_PAGE = int(os.environ.get("MOCK_LOCK_PAGE", "0"))
# MOCK_LOCK_PAGES="3,7,9": several locked pages, the way a scan-only document
# behaves when Scribd will not serve some of its pages to this account
LOCK_PAGES = {int(part) for part in
              os.environ.get("MOCK_LOCK_PAGES", "").replace(" ", "").split(",")
              if part.isdigit()}
if LOCK_PAGE:
    LOCK_PAGES.add(LOCK_PAGE)
# MOCK_SMALL_PAGES="3,5": those pages are only served as a 96x130 preview
SMALL_PAGES = {int(part) for part in
               os.environ.get("MOCK_SMALL_PAGES", "").replace(" ", "").split(",")
               if part.isdigit()}
# MOCK_CUT_PAGES="4": those pages arrive cut in half, with no end-of-image
CUT_PAGES = {int(part) for part in
             os.environ.get("MOCK_CUT_PAGES", "").replace(" ", "").split(",")
             if part.isdigit()}
# MOCK_JUNK_PAGES="2": those pages answer with a picture far too small to be one
JUNK_PAGES = {int(part) for part in
              os.environ.get("MOCK_JUNK_PAGES", "").replace(" ", "").split(",")
              if part.isdigit()}
STATE = {"scans": 0, "until": 0.0}
LOCK = threading.Lock()


def refused_now() -> bool:
    """Count this scan, and say whether the throttle window is open."""
    with LOCK:
        now = time.time()
        if STATE["until"] and now < STATE["until"]:
            return True
        if STATE["until"]:
            STATE["until"] = 0.0            # the window closed
        STATE["scans"] += 1
        if THROTTLE_AFTER and STATE["scans"] > THROTTLE_AFTER:
            STATE["until"] = now + THROTTLE_FOR
            STATE["scans"] = 0
            return True
    return False

def fake_jpeg(width=1200, height=1600, fill=6000):
    out = bytearray(b"\xff\xd8")
    out += b"\xff\xc0" + struct.pack(">H", 11) + bytes([8])
    out += struct.pack(">HH", height, width) + bytes([3]) + b"\x00" * 6
    out += b"\xff\xda" + b"\x00\x08" + b"\x00" * 6
    out += bytes((index * 7) % 256 for index in range(fill))
    out += b"\xff\xd9"
    return bytes(out)


def page_text_lines(number, doc_id=0):
    """The words of one mock page — short for a scan, long for a text page."""
    if TEXT_DOC:
        lines = [f"KUSANTHULA BUKU LA NTHONDO — page {number}",
                 "Ndondomeko ya buku ili ndi yotalikirapo pa nkhani za nthondo ndi "
                 "mmene anthu amapezera chithandizo ku chipatala cha boma."]
        lines += [f"Mutu wa nkhani {line} pa tsamba {number}: mawu oti "
                  f"needle{number} amapezeka mmenemo." for line in range(1, 7)]
        lines.append("Zolembedwa ndi a NTHONDO SUMMARY, kukonza kwa 2026.")
        return lines
    return [f"Mock page {number}", f"This is line two of page {number}",
            f"Search for the word needle{number} to find this page"]


def page_jsonp(doc_id, number):
    """Scribd sends each page's text as window.pageN_callback([…]) of html."""
    lines = page_text_lines(number, doc_id)
    return ('window.page%d_callback(["%s"]);'
            % (number, "<br>".join(f"<div>{line}</div>" for line in lines))).encode()


def embed_page(doc_id, number):
    """One page of the embed viewer, with the chrome a real one has.

    A browser reading a Scribd document reads this: each page is an HTML block
    whose text is already in it. For a converted document it is the only place
    the words exist, so the mock has to produce it or the shape is not tested.
    """
    lines = page_text_lines(number, doc_id)
    body = "".join(f"<p>{line}</p>" for line in lines)
    picture = ""
    if (not TEXT_DOC) or number == 1:
        picture = (f'<img src="//html.scribdassets.com/h{doc_id}/images/'
                   f'{number}-aa{doc_id}.jpg">')
    return (f'<div id="page-{number}" class="outer_page" '
            f'data-page-number="{number}">'
            f'<div class="newpage"><div class="text_layer">{body}</div>'
            f'{picture}'
            f'<div class="ad"><a href="https://www.scribd.com/oauth/signup">'
            f'Download to read ad-free</a></div>'
            f'<div class="share">Share this document · Copy link</div>'
            f'<div class="pagenum">{number}</div>'
            f'</div></div>')


def embed_html(doc_id, start=1):
    if VIEWER_EMPTY:
        return (b'<!doctype html><html><body><div id="viewer"></div>'
                b'<script>window.boot=function(){}</script></body></html>')
    first = max(1, start)
    last = PAGES if not VIEWER_WINDOW else min(PAGES, first + VIEWER_WINDOW - 1)
    return (f'<!doctype html><html><head><title>embed</title></head><body>'
            f'<div class="document_scroll_container">'
            + "".join(embed_page(doc_id, number)
                      for number in range(first, last + 1))
            + '</div></body></html>').encode()


def document_html(doc_id):
    """The document page. In TEXT_DOC mode it names page descriptors only.

    A converted document has no `/images/` URL for most pages at all: the viewer
    renders their text. That is the shape that produced 37 grey placeholder
    sheets, so the mock has to be able to reproduce it.
    """
    names = ""
    for number in range(1, PAGES + 1):
        # a converted document: page 1 usually still has a scan, every other
        # page is words only
        scan = (not TEXT_DOC) or number == 1
        if ONE_ASSET and number > 1:
            continue                 # the page prints no address for it at all
        kind, ext = ("images", "jpg") if scan else ("pages", "jsonp")
        url = (f"https://html.scribdassets.com/h{doc_id}/{kind}/"
               f"{number}-aa{doc_id}.{ext}")
        names += 'var p%d="%s";' % (number, url.replace("/", "\\/"))
    return (f'<!doctype html><html><head>'
            f'<meta property="og:title" content="Doc {doc_id} | Scribd">'
            f'</head><body><script>var d={{"page_count":{PAGES}}};'
            f'{names}</script></body></html>').encode()


def search_answer(query, page):
    """The shape Scribd really returns: results.documents.content.documents.

    Two pages, so "Load more" can be tested: page 1 has a duplicate and an
    off-site link (both must be dropped), page 2 has two more documents, and
    the totals say there are four documents on two pages.
    """
    documents = []
    if page == 1:
        documents = [
            {"id": 900001, "title": f"{query} question bank", "pageCount": 2,
             "views": "1.2K", "releasedAt": "2025-01-01",
             "reader_url": "https://www.scribd.com/document/900001/Question-Bank",
             "authors": [{"id": 1, "name": "someone"}]},
            {"id": 900001, "title": "duplicate of the first",
             "pageCount": 2,
             "reader_url": "https://www.scribd.com/document/900001/Question-Bank"},
            {"id": 900002, "title": f"{query} notes", "pageCount": 2,
             "views": "40",
             "reader_url": "https://www.scribd.com/document/900002/Notes",
             "authors": [{"id": 2, "name": "someone else"}]},
            {"id": 900003, "title": "not scribd",
             "reader_url": "https://example.com/document/900003"},
        ]
    elif page == 2:
        documents = [
            {"id": 900004, "title": f"{query} past paper", "pageCount": 2,
             "views": "9K",
             "reader_url": "https://www.scribd.com/document/900004/Past-Paper"},
            {"id": 900005, "title": f"{query} revision", "pageCount": 2,
             "reader_url": "https://www.scribd.com/document/900005/Revision"},
        ]
    return {"compilationId": "mock", "content_type": "documents",
            "current_page": page, "page_count": 2, "total_results_count": 4,
            "resultRangeStart": 1 + (page - 1) * 40,
            "results": {"documents": {"content": {"documents": documents}}}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send(self, body, code=200, ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/search/query":
            query = urllib.parse.parse_qs(self.path.split("?")[1])
            words = (query.get("query") or [""])[0]
            if "refused" in words.lower():
                self.send(b"no", 403, "text/plain")
                return
            page = int((query.get("page") or ["1"])[0])
            self.send(json.dumps(search_answer(words, page)).encode(),
                      ctype="application/json")
        elif path.startswith("/document/"):
            self.send(document_html(path.split("/")[2]))
        elif path.startswith("/embeds/"):
            query = urllib.parse.parse_qs(self.path.split("?")[1]) \
                if "?" in self.path else {}
            start = int((query.get("start_page") or ["1"])[0])
            self.send(embed_html(path.split("/")[2], start))
        elif path.startswith("/services/oembed"):
            self.send(b'{"title":"Doc","author_name":"someone"}',
                      ctype="application/json")
        elif "/pages/" in path and path.endswith(".jsonp"):
            if NO_DESCRIPTORS:
                self.send(b"<Error><Code>AccessDenied</Code></Error>", 403,
                          "application/xml")
                return
            name = path.rsplit("/", 1)[-1].split("-")[0]
            number = int(name) if name.isdigit() else 1
            self.send(page_jsonp(0, number), ctype="application/javascript")
        elif "/images/" in path:
            if DELAY_MS:
                time.sleep(DELAY_MS / 1000.0)
            page = path.rsplit("/", 1)[-1].split("-")[0]
            if TEXT_DOC and page != "1":
                # a converted document has no scan for that page: exactly what
                # Scribd answers, and what used to become a grey placeholder
                self.send(b"<Error><Code>AccessDenied</Code></Error>", 403,
                          "application/xml")
                return
            if page.isdigit() and int(page) in LOCK_PAGES:
                self.send(b"<html>not for you</html>", 403)
            elif refused_now():
                self.send(b"<html>too many requests</html>", 403)
            else:
                number = int(page) if page.isdigit() else 0
                if number in JUNK_PAGES:
                    self.send(fake_jpeg(60, 80, fill=400), ctype="image/jpeg")
                elif number in CUT_PAGES:
                    self.send(fake_jpeg()[:900], ctype="image/jpeg")   # no EOI
                elif number in SMALL_PAGES:
                    self.send(fake_jpeg(96, 130, fill=900), ctype="image/jpeg")
                else:
                    self.send(fake_jpeg(), ctype="image/jpeg")
        else:
            self.send(b"not found", 404, "text/plain")


if __name__ == "__main__":
    print(f"mock scribd on {PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
