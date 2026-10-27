

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
