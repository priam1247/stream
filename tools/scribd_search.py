#!/usr/bin/env python3
"""scribd_search.py — find Scribd documents from your own PC, send them to the panel.

One file, standard library only (Python 3.8+), nothing to install.

    python scribd_search.py                     # a small search page on your PC
    python scribd_search.py "physics 12th"      # search in the terminal, print links
    python scribd_search.py "physics 12th" --pick 1,3 --panel http://IP:PORT
    python scribd_search.py --selftest          # offline check of this file

WHY THIS RUNS ON YOUR PC AND NOT ON THE PANEL
---------------------------------------------
Scribd's own search page is a JavaScript app, so its HTML has no results in it.
The next best thing is the search engines, which have already indexed
scribd.com: `site:scribd.com <keyword>`. A server on a hosting provider is very
often blocked by them (that is measured — the old panel diagnostics printed
"Search engines are blocked from this IP as well"), while a home connection is
not. So the search happens here, on your machine, and only the links travel to
the panel. The panel does what it is good at: fetch the pages and build the PDF.

WHAT IT DOES
------------
1. asks the engines in order, reporting each answer (DuckDuckGo html, DuckDuckGo
   lite, Bing, Mojeek, then Scribd itself)
2. tidies the results: title, document id, link; duplicates merged
3. you tick what you want and press "Send to panel"
4. it forwards those links to the panel's /send endpoint, and the panel starts
   downloading — exactly as if you had clicked the bookmarklet

The forwarding is done by this file, not by your browser, so it works without
any CORS setup and without opening a second tab by hand.

Set the panel once: the page remembers it, or pass --panel / ?panel=URL.
"""
from __future__ import annotations

import base64
import gzip
import html as html_module
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
DEFAULT_PANEL = os.environ.get("SCRIBD_PANEL", "").rstrip("/")
DEFAULT_PORT = int(os.environ.get("SEARCH_PORT") or 8095)

# name, url, method, wrap the query in site:scribd.com
ENGINES = (
    ("duckduckgo", "https://html.duckduckgo.com/html/", "POST", True),
    ("duckduckgo-lite", "https://lite.duckduckgo.com/lite/", "POST", True),
    ("bing", "https://www.bing.com/search?q={query}&count=30", "GET", True),
    ("mojeek", "https://www.mojeek.com/search?q={query}", "GET", True),
    ("scribd", "https://www.scribd.com/search?query={query}", "GET", False),
)
GENERIC = {"", "save", "download", "read more", "read", "scribd", "upload",
           "share", "open", "view", "preview", "see all", "more",
           "add to library", "sign in", "sign up"}

ANCHOR_RE = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.I | re.S)
HREF_RE = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.I)
TITLE_RE = re.compile(r"""(?:title|aria-label)\s*=\s*["']([^"']{3,300})["']""", re.I)
TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
ESCAPED_SLASHES_RE = re.compile(r"\\+/")
DOC_IN_URL_RE = re.compile(
    r"scribd\.com/(document|doc|presentation|spreadsheet|ebook|audiobook|magazine)"
    r"/(\d{3,})(?:/([^/?#\"'&\s<>]*))?", re.I)
BING_WRAP_RE = re.compile(r"[?&]u=a1([A-Za-z0-9_\-]+)", re.I)


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def plain(text: str) -> str:
    """Tags out, entities in, whitespace collapsed."""
    raw = TAG_RE.sub(" ", text or "")
    raw = html_module.unescape(raw)
    return SPACE_RE.sub(" ", raw).strip()


def unescape_slashes(text: str) -> str:
    """Scribd writes urls inside JS as https:\\/\\/… — put them back."""
    return ESCAPED_SLASHES_RE.sub("/", (text or "").replace("&amp;", "&"))


def unwrap_link(href: str) -> str:
    """A search engine redirect -> the url it points at.

    DuckDuckGo wraps results as //duckduckgo.com/l/?uddg=<encoded>, Bing as
    /ck/a?...&u=a1<base64>. Anything else comes back as it went in.
    """
    href = (href or "").strip().replace("&amp;", "&")
    if href.startswith("//"):
        href = "https:" + href
    if "duckduckgo.com/l/" in href:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query)
        href = (query.get("uddg") or [""])[0] or href
    elif "/ck/a" in href:
        found = BING_WRAP_RE.search(href)
        if found:
            raw = found.group(1).replace("-", "+").replace("_", "/")
            try:
                href = base64.b64decode(raw + "=" * (-len(raw) % 4)).decode(
                    "utf-8", "replace")
            except Exception:  # noqa: BLE001
                pass
    return urllib.parse.unquote(href)


def normalise_panel(value: str) -> str:
    """`195.1.2.3:25811`, `http://host/`, `host` -> one clean base url."""
    text = (value or "").strip().rstrip("/")
    if not text:
        return ""
    if not re.match(r"^https?://", text, re.I):
        text = "http://" + text
    parsed = urllib.parse.urlsplit(text)
    host = (parsed.hostname or "").lower()
    # a real panel address has a dot, an explicit port, or is localhost: a bare
    # word like "nonsense" is a typo, and saying so is better than a DNS error
    if not host or not ("." in host or ":" in parsed.netloc or host == "localhost"):
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def as_count(value, default: int = 1, low: int = 1, high: int = 5) -> int:
    """A small whole number from anything a browser or a shell might send."""
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        number = default
    return max(low, min(number, high))


# ---------------------------------------------------------------------------
# reading a results page
# ---------------------------------------------------------------------------
def parse_results(html: str, engine: str = "") -> list[dict]:
    """Document links in one engine's page: anchors first, then raw urls.

    Titles are scored, never invented: an anchor's own text wins, then its
    title/aria-label, then the slug. Generic words like "Save" are thrown away
    so they cannot become a document title.
    """
    hits: list[dict] = []
    seen: dict[str, dict] = {}

    def add(kind: str, doc_id: str, slug: str, title: str) -> None:
        title = plain(title)
        if title.lower() in GENERIC:
            title = ""
        if doc_id in seen:
            current = seen[doc_id]
            if title and len(title) > len(current["title"]):
                current["title"] = title
            if slug and not current["slug"]:
                current["slug"] = slug
                current["url"] = f"https://www.scribd.com/{kind}/{doc_id}/{slug}"
            return
        fallback = plain(slug.replace("-", " ").replace("_", " "))
        hit = {"doc_id": doc_id, "kind": kind, "slug": slug,
               "title": title or fallback or f"scribd {doc_id}",
               "url": f"https://www.scribd.com/{kind}/{doc_id}/{slug or 'doc'}",
               "engine": engine}
        seen[doc_id] = hit
        hits.append(hit)

    for anchor in ANCHOR_RE.finditer(unescape_slashes(html or "")):
        attrs, body = anchor.group(1), anchor.group(2)
        href = HREF_RE.search(attrs)
        if not href:
            continue
        match = DOC_IN_URL_RE.search(unwrap_link(href.group(1)))
        if not match:
            continue
        kind = "document" if match.group(1).lower() == "doc" else match.group(1).lower()
        title = ""
        labelled = TITLE_RE.search(attrs)
        if labelled:
            title = labelled.group(1)
        if not title:
            text = plain(body)
            title = text if len(text) <= 250 else ""
        add(kind, match.group(2), (match.group(3) or "").strip("/"), title)

    for match in DOC_IN_URL_RE.finditer(
            urllib.parse.unquote(unescape_slashes(html or ""))):
        kind = "document" if match.group(1).lower() == "doc" else match.group(1).lower()
        add(kind, match.group(2), (match.group(3) or "").strip("/"), "")

    return hits


# ---------------------------------------------------------------------------
# asking the engines
# ---------------------------------------------------------------------------
def http_get(url: str, data: bytes = None, timeout: float = 20.0) -> tuple[int, bytes, str]:
    """(status, body, error) — gzip handled, one honest attempt."""
    headers = {"User-Agent": UA,
               "Accept": "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9",
               "Accept-Encoding": "gzip, deflate"}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            raw = answer.read()
            status = answer.status
            encoding = (answer.headers.get("Content-Encoding") or "").lower()
    except urllib.error.HTTPError as exc:
        raw = exc.read() if hasattr(exc, "read") else b""
        status = exc.code
        encoding = ""
    except Exception as exc:  # noqa: BLE001
        return 0, b"", f"{type(exc).__name__}: {exc}"[:120]
    if encoding == "gzip":
        try:
            raw = gzip.decompress(raw)
        except OSError:
            pass
    return status, raw, ""


def ask_engine(name: str, url: str, method: str, site_only: bool, query: str,
               page: int = 1) -> tuple[list[dict], str]:
    """One engine, one page of results -> (hits, one line saying what happened)."""
    words = f"site:scribd.com {query}".strip() if site_only else query
    if method == "POST":
        fields = {"q": words}
        if page > 1:
            fields["s"] = str((page - 1) * 30)
        status, body, error = http_get(url, urllib.parse.urlencode(fields).encode())
    else:
        target = url.format(query=urllib.parse.quote_plus(words))
        if page > 1:
            target += ("&" if "?" in target else "?") + f"page={page}"
        status, body, error = http_get(target)
    if error:
        return [], f"{name}: {error}"
    if status != 200:
        hint = " (that engine refuses this address)" if status in (202, 403, 429, 503) else ""
        return [], f"{name}: HTTP {status}{hint}"
    hits = parse_results(body.decode("utf-8", "replace"), engine=name)
    if not hits:
        size = len(body) / 1000
        return [], f"{name}: HTTP 200, {size:.0f} kB, no document links"
    return hits, f"{name}: {len(hits)} link(s)"


def find_links(query: str, engines=ENGINES, pages: int = 1,
               limit: int = 0) -> tuple[list[dict], list[str]]:
    """Every engine in turn until `limit` documents are found.

    Returns the hits and one line per engine tried, in the order tried, so the
    page can show what answered and what refused.
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
            hits, note = ask_engine(name, url, method, site_only, text, page)
            notes.append(note)
            fresh = [hit for hit in hits if hit["doc_id"] not in seen]
            for hit in fresh:
                seen.add(hit["doc_id"])
                found.append(hit)
            if not hits:
                break
    return (found[:limit] if limit else found), notes


def summary(hits: list[dict], notes: list[str]) -> str:
    text = (f"{len(hits)} document(s) found" if hits else "no documents found")
    blocked = [note for note in notes
               if "refuses this address" in note or "HTTP 0" in note
               or "HTTP 5" in note or "HTTP 4" in note]
    if blocked:
        text += f" · {len(blocked)} engine(s) could not be asked"
    return text


# ---------------------------------------------------------------------------
# handing the links to the panel
# ---------------------------------------------------------------------------
def reply_line(body: bytes) -> str:
    """The useful line out of the panel's answer, not its stylesheet.

    /send replies with a tiny page whose headline is the whole message
    ("queued 2 link(s)"), so read that heading; if there is none, strip the
    style/script blocks before flattening the rest.
    """
    text = (body or b"").decode("utf-8", "replace")
    heading = re.search(r"<h[1-3][^>]*>(.*?)</h[1-3]>", text, re.I | re.S)
    if heading:
        return plain(heading.group(1))[:200]
    text = re.sub(r"<(style|script)\b.*?</\1>", " ", text, flags=re.I | re.S)
    return plain(text)[:200]


def send_to_panel(panel: str, urls: list[str], timeout: float = 30.0) -> tuple[bool, str]:
    """GET {panel}/send?url=…&url=… — the panel starts downloading."""
    base = normalise_panel(panel)
    if not base:
        return False, "no panel address — set it in the box (e.g. http://1.2.3.4:25811)"
    wanted = [url for url in dict.fromkeys(urls or []) if url]
    if not wanted:
        return False, "nothing to send"
    query = "&".join("url=" + urllib.parse.quote(url, safe="") for url in wanted[:40])
    address = base + "/send?" + query
    status, body, error = http_get(address, timeout=timeout)
    if error:
        return False, (f"could not reach the panel at {base} ({error}). Is it running, "
                       "and is the address right?")
    text = reply_line(body)
    if status == 200:
        return True, text or f"sent {len(wanted)} link(s)"
    if status == 409:
        return False, "the panel is already downloading something — try again in a moment"
    return False, f"the panel answered HTTP {status}: {text[:120]}"


# ---------------------------------------------------------------------------
# the page
# ---------------------------------------------------------------------------
PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>find Scribd documents</title>
<style>
 body{font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:#fbfbfa;color:#1f2328;margin:0;padding:26px 18px 60px}
 .wrap{max-width:900px;margin:0 auto}
 h1{font-size:19px;margin:0 0 4px}
 .meta{color:#57606a;font-size:13px;margin-bottom:16px}
 input[type=text],input[type=url]{width:100%;box-sizing:border-box;font:inherit;
  padding:10px;border:1px solid #b8c0c8;border-radius:6px;background:#fff}
 .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}
 button{font:inherit;padding:9px 16px;border-radius:6px;border:1px solid #1f6feb;
  background:#1f6feb;color:#fff;cursor:pointer}
 button.ghost{background:#fff;color:#1f6feb}
 button:disabled{opacity:.45;cursor:default}
 #hits{background:#fff;border:1px solid #d0d7de;border-radius:8px;margin:12px 0;
  max-height:420px;overflow:auto}
 #hits:empty{display:none}
 .hit{display:flex;gap:10px;align-items:baseline;padding:9px 12px;
  border-bottom:1px solid #eaeef2}
 .hit:last-child{border-bottom:0}
 .hit .t{flex:1}
 .hit .id{color:#8c959f;font-size:12px}
 .say{background:#fff;border:1px solid #d0d7de;border-left:5px solid #9a6700;
  padding:12px 14px;white-space:pre-wrap;margin:12px 0}
 .ok{border-left-color:#1a7f37} .bad{border-left-color:#b42318}
 .muted{color:#57606a;font-size:13px}
 a{color:#0969da}
 fieldset{border:1px solid #d0d7de;border-radius:8px;padding:12px 14px;margin:0}
 legend{font-size:13px;color:#57606a;padding:0 6px}
</style></head><body><div class="wrap">
<h1>Find Scribd documents</h1>
<div class="meta">Searching runs here, on your PC. Only the links go to the panel,
which does the downloading.</div>

<div class="row"><input type="text" id="q" placeholder="e.g. physics 12th question bank"></div>
<div class="row">
  <button id="find">Search</button>
  <label class="muted">result pages <input type="text" id="pages" value="1"
    style="width:42px;display:inline-block;padding:4px 6px"></label>
  <span class="muted" id="engines"></span>
</div>

<div id="hits"></div>

<fieldset>
  <legend>panel</legend>
  <div class="row" style="margin:0">
    <input type="url" id="panel" placeholder="http://your-panel-address:25811"
      value="__PANEL__">
    <button id="send" disabled>Send ticked to the panel</button>
    <button class="ghost" id="all">tick all / none</button>
    <a id="openpanel" class="muted" href="#" target="_blank" rel="noreferrer">open the panel</a>
  </div>
</fieldset>

<div class="say" id="say">nothing sent yet</div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
let hits = [];

try { const saved = localStorage.getItem('panel'); if (saved) $('panel').value = saved; } catch (e) {}
function remember() {
  try { localStorage.setItem('panel', $('panel').value); } catch (e) {}
  $('openpanel').href = $('panel').value.replace(/\\/$/, '');
}
$('panel').addEventListener('input', remember);
remember();

function render() {
  $('hits').innerHTML = hits.map((h, i) => `
    <label class="hit">
      <input type="checkbox" data-i="${i}" checked>
      <span class="t">${esc(h.title)}</span>
      <a href="${esc(h.url)}" target="_blank" rel="noreferrer">open</a>
      <span class="id">${esc(h.doc_id)} · ${esc(h.engine || '')}</span>
    </label>`).join('');
  $('send').disabled = !hits.length;
  $('send').textContent = hits.length
    ? `Send ticked to the panel (${hits.length})` : 'Send ticked to the panel';
}

function ticked() {
  return [...document.querySelectorAll('#hits input[type=checkbox]')]
    .filter((box) => box.checked).map((box) => hits[+box.dataset.i].url);
}

$('find').onclick = async () => {
  const query = $('q').value.trim();
  if (!query) { $('say').textContent = 'type what you are looking for first'; return; }
  $('find').disabled = true;
  $('engines').textContent = 'asking the engines…';
  try {
    const answer = await fetch('/search', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query, pages: Number($('pages').value) || 1}),
    });
    const data = await answer.json();
    hits = data.hits || [];
    render();
    $('engines').textContent = (data.notes || []).join(' · ');
    $('say').className = 'say' + (hits.length ? ' ok' : ' bad');
    $('say').textContent = (data.summary || '') +
      (hits.length ? '' : ' — try fewer words, or use the bookmarklet on the panel page');
  } catch (error) {
    $('say').className = 'say bad';
    $('say').textContent = 'search failed: ' + error;
  } finally {
    $('find').disabled = false;
  }
};

$('send').onclick = async () => {
  const urls = ticked();
  if (!urls.length) { $('say').textContent = 'nothing ticked'; return; }
  $('send').disabled = true;
  $('say').className = 'say';
  $('say').textContent = 'sending…';
  try {
    const answer = await fetch('/send', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({panel: $('panel').value, urls}),
    });
    const data = await answer.json();
    $('say').className = 'say ' + (data.ok ? 'ok' : 'bad');
    $('say').textContent = data.message +
      (data.ok ? ' — watch it on the panel' : '');
    remember();
  } catch (error) {
    $('say').className = 'say bad';
    $('say').textContent = 'could not talk to this helper: ' + error;
  } finally {
    $('send').disabled = false;
  }
};

$('all').onclick = () => {
  const boxes = [...document.querySelectorAll('#hits input[type=checkbox]')];
  const anyUnchecked = boxes.some((box) => !box.checked);
  boxes.forEach((box) => { box.checked = anyUnchecked; });
};

$('q').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('find').click();
});
</script></body></html>"""


def serve(port: int, panel: str) -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            pass

        def send(self, body: bytes, ctype: str, code: int = 200) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            path = urllib.parse.urlparse(self.path).path
            if path == "/health":
                self.send(b"ok", "text/plain; charset=utf-8")
                return
            wanted = urllib.parse.parse_qs(
                urllib.parse.urlparse(self.path).query).get("panel", [""])[0]
            shown = (normalise_panel(wanted) or normalise_panel(panel)
                     or normalise_panel(DEFAULT_PANEL))
            self.send(PAGE.replace("__PANEL__", html_module.escape(shown, quote=True))
                      .encode("utf-8"), "text/html; charset=utf-8")

        def do_POST(self) -> None:  # noqa: N802
            path = urllib.parse.urlparse(self.path).path
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except Exception:  # noqa: BLE001
                payload = {}
            if path == "/search":
                query = str(payload.get("query") or "").strip()
                pages = as_count(payload.get("pages"), 1, 1, 5)
                if not query:
                    self.send(json.dumps({"hits": [], "notes": [],
                                          "summary": "no query"}).encode(),
                              "application/json; charset=utf-8", 400)
                    return
                hits, notes = find_links(query, pages=pages)
                print(f"search: {query!r} -> {len(hits)} document(s)", flush=True)
                for note in notes:
                    print("   " + note, flush=True)
                self.send(json.dumps({"hits": hits, "notes": notes,
                                      "summary": summary(hits, notes)}).encode(),
                          "application/json; charset=utf-8")
                return
            if path == "/send":
                panel_address = str(payload.get("panel") or panel or DEFAULT_PANEL)
                urls = payload.get("urls")
                if isinstance(urls, str):
                    urls = [urls]
                elif not isinstance(urls, list):
                    urls = [payload.get("url")] if payload.get("url") else []
                urls = [str(u).strip() for u in urls if str(u or "").strip()]
                ok, message = send_to_panel(panel_address, urls)
                print(f"send: {message}", flush=True)
                self.send(json.dumps({"ok": ok, "message": message}).encode(),
                          "application/json; charset=utf-8", 200 if ok else 400)
                return
            self.send(b'{"error":"unknown endpoint"}', "application/json", 404)

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"open http://127.0.0.1:{port}/ — search, tick, send to the panel", flush=True)
    if not (panel or DEFAULT_PANEL):
        print("panel address not set yet — type it in the page (it is remembered)",
              flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        server.server_close()


# ---------------------------------------------------------------------------
# terminal use, selftest, entry
# ---------------------------------------------------------------------------
def run_cli(query: str, panel: str, pick: str, pages: int, limit: int) -> int:
    hits, notes = find_links(query, pages=pages, limit=limit)
    for note in notes:
        print("  " + note, flush=True)
    if not hits:
        print(f"NO RESULTS — {summary(hits, notes)}", flush=True)
        return 1
    for number, hit in enumerate(hits, start=1):
        print(f"{number:3d}. {hit['title'][:80]}")
        print(f"     {hit['url']}")
    chosen = hits
    if pick:
        numbers = {int(part) for part in re.findall(r"\d+", pick)}
        chosen = [hit for number, hit in enumerate(hits, start=1) if number in numbers]
        if not chosen:
            print(f"--pick found no numbered result in 1..{len(hits)}", flush=True)
            return 1
    if not panel:
        print(f"{len(chosen)} link(s) — no --panel given, so nothing was sent",
              flush=True)
        return 0
    ok, message = send_to_panel(panel, [hit["url"] for hit in chosen])
    print(("SENT — " if ok else "NOT SENT — ") + message, flush=True)
    return 0 if ok else 1


def selftest() -> str:
    ddg = (
        '<a class="result__a" href="//duckduckgo.com/l/?uddg='
        'https%3A%2F%2Fwww.scribd.com%2Fdocument%2F750213011%2FPhysics-12th">'
        "Physics 12th question bank</a>"
        '<a class="result__a" href="//duckduckgo.com/l/?uddg='
        'https%3A%2F%2Fwww.scribd.com%2Fdocument%2F750213011%2FPhysics-12th">Save</a>'
        '<a class="result__a" href="https://www.scribd.com/presentation/804179430/'
        'Book-List">CBSE book list 2024</a>'
        '<a href="https://www.scribd.com/about">About</a>')
    hits = parse_results(ddg, engine="duckduckgo")
    assert [hit["doc_id"] for hit in hits] == ["750213011", "804179430"], hits
    assert hits[0]["title"] == "Physics 12th question bank"
    assert hits[0]["url"] == "https://www.scribd.com/document/750213011/Physics-12th"
    assert hits[1]["kind"] == "presentation"

    wrapped = base64.urlsafe_b64encode(
        b"https://www.scribd.com/document/123456789/Some-Book").decode().rstrip("=")
    bing = ('<li><a href="https://www.bing.com/ck/a?!&&p=x&u=a1' + wrapped +
            '&ntb=1">Some Book &amp; Notes</a></li>')
    bing_hits = parse_results(bing, engine="bing")
    assert len(bing_hits) == 1 and bing_hits[0]["doc_id"] == "123456789"
    assert bing_hits[0]["title"] == "Some Book & Notes", bing_hits[0]

    # lite-style markup: same anchors, different classes, no title attribute
    lite = ('<a rel="nofollow" href="https://html.duckduckgo.com/l/?uddg='
            'https%3A%2F%2Fwww.scribd.com%2Febook%2F555555%2FNovel">A Novel</a>')
    assert parse_results(lite)[0]["doc_id"] == "555555"

    # a page that only writes urls as text (cite lines, escaped JS)
    assert parse_results("<cite>https://www.scribd.com/document/999999/ExceL</cite>"
                         )[0]["doc_id"] == "999999"
    assert parse_results('<script>var u="https:\\/\\/www.scribd.com\\/document'
                         '\\/123123\\/x";</script>')[0]["doc_id"] == "123123"
    assert parse_results("<a href='/about'>About</a>") == []
    assert parse_results("") == []

    # titles are never invented from generic words
    generic = parse_results('<a href="https://www.scribd.com/document/777777/x-y">'
                            "Save</a>")
    assert generic[0]["title"] == "x y", generic[0]

    assert unwrap_link("https://www.scribd.com/document/1/x").endswith("/document/1/x")
    assert unwrap_link("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa") == (
        "https://example.com/a")

    assert normalise_panel("1.2.3.4:25811") == "http://1.2.3.4:25811"
    assert normalise_panel("http://1.2.3.4:25811/") == "http://1.2.3.4:25811"
    assert normalise_panel("https://panel.example.com") == "https://panel.example.com"
    assert normalise_panel("  ") == ""
    assert normalise_panel("nonsense") == ""

    # engines are asked in order, and a refusal is reported, not hidden
    calls: list[str] = []

    def stub_ask(name, url, method, site_only, query, page=1):
        calls.append(name)
        if name == "duckduckgo":
            return [], "duckduckgo: HTTP 202 (that engine refuses this address)"
        if name == "bing":
            return ([{"doc_id": "555", "kind": "document", "slug": "found",
                      "title": "Found it",
                      "url": "https://www.scribd.com/document/555/found",
                      "engine": name}], "bing: 1 link(s)")
        return [], f"{name}: HTTP 200, 3 kB, no document links"

    real = globals()["ask_engine"]
    globals()["ask_engine"] = stub_ask
    try:
        found, notes = find_links("physics", pages=1)
        ordered = list(calls)
        calls.clear()
        limited, _ = find_links("physics", pages=1, limit=1)
    finally:
        globals()["ask_engine"] = real
    assert [hit["doc_id"] for hit in found] == ["555"], found
    # with no limit every engine is asked (more results for the user) ...
    assert ordered == ["duckduckgo", "duckduckgo-lite", "bing", "mojeek",
                       "scribd"], ordered
    assert found[0]["doc_id"] == "555"               # ... and duplicates collapse
    assert len(found) == 1, found
    # ... with a limit it stops as soon as it has enough
    assert [hit["doc_id"] for hit in limited] == ["555"]
    assert calls[:3] == ["duckduckgo", "duckduckgo-lite", "bing"], calls
    assert "mojeek" not in calls, calls
    assert "could not be asked" in summary(found, notes)
    assert summary([], ["bing: HTTP 200, 3 kB, no document links"]) == (
        "no documents found")
    assert find_links("   ") == ([], ["no query"])

    # the panel hand-off, against a tiny server that behaves like /send
    received: list[str] = []

    class Panel(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/send":
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            received.extend(urllib.parse.parse_qs(parsed.query).get("url", []))
            body = (b"<html><head><style>body{font:15px ui-monospace}"
                    b"</style></head><body><h3>queued 2 link(s)</h3></body></html>")
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    panel = ThreadingHTTPServer(("127.0.0.1", 0), Panel)
    threading.Thread(target=panel.serve_forever, daemon=True).start()
    address = f"127.0.0.1:{panel.server_address[1]}"
    try:
        ok, message = send_to_panel(address, ["https://www.scribd.com/document/1/a",
                                              "https://www.scribd.com/document/2/b",
                                              "https://www.scribd.com/document/1/a"])
        assert ok, message
        assert "queued 2 link(s)" in message, message
        assert received == ["https://www.scribd.com/document/1/a",
                            "https://www.scribd.com/document/2/b"], received
        bad, why = send_to_panel("127.0.0.1:1", ["https://www.scribd.com/document/3/c"])
        assert not bad and "could not reach the panel" in why, why
        empty, note = send_to_panel(address, [])
        assert not empty and "nothing to send" in note, note
        nothing, reason = send_to_panel("", ["x"])
        assert not nothing and "no panel address" in reason, reason
    finally:
        panel.shutdown()
        panel.server_close()

    return ("selftest: every check passed — result parsing, redirect unwrapping, "
            "engine order, panel hand-off")


def main(argv: list[str]) -> int:
    global DEFAULT_PANEL
    query = ""
    panel = ""
    pick = ""
    pages = 1
    limit = 0
    port = DEFAULT_PORT
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in ("--panel", "--pick", "--pages", "--limit", "--port") and \
                index + 1 < len(argv):
            value = argv[index + 1]
            if arg == "--panel":
                panel = value
            elif arg == "--pick":
                pick = value
            elif arg == "--pages":
                pages = as_count(value, 1, 1, 5)
            elif arg == "--limit":
                limit = as_count(value, 0, 0, 1000)
            else:
                port = as_count(value, DEFAULT_PORT, 1, 65535)
            index += 2
            continue
        if arg == "--selftest":
            print(selftest())
            return 0
        if arg in ("-h", "--help"):
            print(__doc__)
            return 0
        if not arg.startswith("-"):
            query = arg
        index += 1
    chosen_panel = normalise_panel(panel) or normalise_panel(DEFAULT_PANEL)
    if query:
        return run_cli(query, chosen_panel, pick, pages, limit)
    serve(port, chosen_panel)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
