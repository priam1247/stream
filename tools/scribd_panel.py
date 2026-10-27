"""Scribd panel — search, HTTP routes, embedded UI and command-line main.

Loaded by scribd_download.py after scribd_shots.py. The offline selftest is in
scribd_selftest.py, which also holds the final __main__ guard. Annotations are
compiled with PEP 563 by the loader.
"""



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
    // v2.16: keep "Load more" while there are results and pages left. It used
    // to disappear whenever Scribd sent no total, which is exactly when a person
    // still wants it — a page that adds nothing says so instead.
    search.more = fresh > 0 && search.page < (d.max_page || 40) &&
      (search.total ? search.shown < search.total : true);
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
    # said at boot, not at the first document: whether a page nobody sends can be
    # photographed is the one thing worth knowing before you press download. Said
    # from its own thread, because the browser is a second server on a second
    # host, and asking it must not keep this panel's door shut while it answers.
    threading.Thread(target=boot_shots_report, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        server.server_close()


# ---------------------------------------------------------------------------
# command-line entry (selftest lives in scribd_selftest.py)
# ---------------------------------------------------------------------------
def main(argv: list[str]) -> int:
    global BASE
    urls: list[str] = []
    links_text = ""
    limit = 0
    out = OUT
    cookies = ""
    jobs = 12
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
                   "--pick", "--shots") and index + 1 < len(argv):
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
            elif arg == "--shots":
                set_shots(value)
            else:
                BASE = value.rstrip("/")
            index += 2
            continue
        if arg == "--no-check":
            check = False
        elif arg == "--no-placeholder":
            placeholder = False
        elif arg == "--no-verify":
            verify = False
        elif arg in ("--text", "--text-layer"):
            text = True
        elif arg == "--shots-only":
            pass                      # there is only one route now: photographs
        elif arg == "--scans":
            # Removed, not switched off. Say so once and carry on with the route
            # there is, rather than aborting a job somebody started.
            print("--scans is gone: every page of every document is "
                  "photographed, and nothing brings scanning back.")
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
        elif arg.startswith("--shots="):
            set_shots(arg.split("=", 1)[1])
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
        run_job(urls, limit, out, jobs, name=name, check=check,
                placeholder=placeholder, probe_page=probe, verify=verify,
                text=text)
        return 0 if JOB.verdict in ("PDF BUILT", "PDF PARTIAL", "PROBE DONE") else 1
    # 25811 is the port this panel is reached on; an egg that sets SERVER_PORT
    # still wins, and a bare `python scribd_download.py` now binds the right one
    port = int(os.environ.get("SERVER_PORT") or os.environ.get("PORT")
               or PANEL_PORT)
    serve(port, out)
    return 0
