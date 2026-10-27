import { PANEL, VERSION } from "./config.js";


// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------
const CONFIG = JSON.stringify({ panel: PANEL }).replace(/</g, "\\u003c");
export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>search Scribd, send to the panel</title>
<style>
 body{font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:#fbfbfa;color:#1f2328;margin:0;padding:26px 18px 70px}
 .wrap{max-width:900px;margin:0 auto}
 h1{font-size:19px;margin:0 0 2px}
 .meta{color:#57606a;font-size:13px;margin-bottom:16px}
 .card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin-bottom:14px}
 .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 input[type=search],input[type=url]{flex:1 1 240px;min-width:170px;font:inherit;
  padding:9px 10px;border:1px solid #b8c0c8;border-radius:6px;background:#fff}
 button{font:inherit;padding:9px 16px;border-radius:6px;border:1px solid #1f6feb;
  background:#1f6feb;color:#fff;cursor:pointer}
 button.ghost{background:#fff;color:#1f6feb}
 button:disabled{opacity:.45;cursor:default}
 .muted{color:#57606a;font-size:13px}
 .hit{display:flex;gap:10px;padding:8px 2px;border-bottom:1px solid #eaeef2;cursor:pointer}
 .hit:last-child{border-bottom:0}
 .hit input{margin-top:5px}
 .hit .t{font-weight:600}
 .hit .m{color:#57606a;font-size:12.5px;word-break:break-all}
 .hit .e{color:#8250df;font-size:12px}
 #notes{margin-top:10px;white-space:pre-wrap;font-size:12.5px;color:#57606a}
 .verdict{margin-top:12px;padding:11px 13px;border-left:5px solid #9a6700;background:#fff;
  border-radius:4px;white-space:pre-wrap}
 .ok{border-left-color:#1a7f37}.bad{border-left-color:#b42318}
</style></head><body><div class="wrap">
<h1>Find Scribd documents, send them to the panel</h1>
<div class="meta" id="meta">v${VERSION} · starting…</div>

<div class="card">
  <div class="row">
    <input type="search" id="q" placeholder="physics 12th" autocomplete="off">
    <button id="find">Search</button>
    <label class="muted"><input type="checkbox" id="useBrowser"> use the browser too</label>
  </div>
  <div id="hits"></div>
  <div class="row" style="margin-top:10px">
    <button id="send" class="ghost">Send ticked to the panel</button>
    <span class="muted" id="picked">nothing ticked yet</span>
  </div>
  <div id="notes"></div>
</div>

<div class="card">
  <div class="muted">Panel address — the downloader, e.g. <code>http://195.123.189.187:25811</code></div>
  <div class="row" style="margin-top:8px">
    <input type="url" id="panel" placeholder="http://YOUR-PANEL:PORT">
    <button class="ghost" id="save">Remember</button>
    <span class="muted" id="saved"></span>
  </div>
</div>

<div class="verdict" id="verdict">idle</div>
</div>
<script>
const CONFIG = ${CONFIG};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;')
  .replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

$('panel').value = localStorage.getItem('panel') || CONFIG.panel;

function collect() {
  return [...document.querySelectorAll('#hits input:checked')].map((b) => ({
    url: b.value, title: b.dataset.title,
  }));
}

function count() {
  const n = collect().length;
  $('picked').textContent = n ? n + ' ticked' : 'nothing ticked yet';
}

function row(hit) {
  const label = document.createElement('label');
  label.className = 'hit';
  const box = document.createElement('input');
  box.type = 'checkbox'; box.value = hit.url; box.dataset.title = hit.title || '';
  const body = document.createElement('div');
  const extra = [hit.pages ? hit.pages + ' pages' : '', hit.views ? hit.views + ' views' : '',
                 hit.author || ''].filter(Boolean).join(' · ');
  body.innerHTML = '<div class="t">' + esc(hit.title || hit.url) + '</div>'
    + '<div class="m">' + esc(hit.url) + (extra ? ' · ' + esc(extra) : '') + '</div>'
    + '<div class="e">' + esc(hit.engine || '') + '</div>';
  label.append(box, body);
  box.onchange = count;
  return label;
}

async function find() {
  const query = $('q').value.trim();
  if (!query) { $('verdict').textContent = 'type a few words first'; return; }
  $('find').disabled = true;
  $('verdict').textContent = 'searching…';
  $('verdict').className = 'verdict';
  $('notes').textContent = '';
  $('hits').innerHTML = '';
  count();
  try {
    const r = await fetch('/search', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query, mode: $('useBrowser').checked ? 'auto' : 'fetch'}),
    });
    const d = await r.json();
    if (d.error) { $('verdict').textContent = d.error; return; }
    (d.hits || []).forEach((hit) => $('hits').append(row(hit)));
    $('notes').textContent = (d.notes || []).join('\\n');
    const refused = (d.notes || []).filter((n) => n.includes('refused') || n.includes('challenge'));
    $('verdict').textContent = d.hits.length
      ? d.hits.length + ' document(s) found (' + d.mode + ')'
      : (refused.length ? 'nothing found — and this address was refused by: '
          + refused.map((n) => n.split(':')[0]).join(', ')
        : 'nothing found — ' + (d.notes || []).slice(-1)[0]);
    $('verdict').className = 'verdict' + (d.hits.length ? ' ok' : ' bad');
  } catch (e) {
    $('verdict').textContent = 'the search service did not answer: ' + e;
  } finally {
    $('find').disabled = false;
    count();
  }
}

async function send() {
  const picked = collect();
  if (!picked.length) { $('verdict').textContent = 'tick at least one document first'; return; }
  const panel = $('panel').value.trim();
  if (!panel) { $('verdict').textContent = 'put the panel address in first'; return; }
  localStorage.setItem('panel', panel);
  $('send').disabled = true;
  $('verdict').textContent = 'sending ' + picked.length + ' link(s) to ' + panel + ' …';
  try {
    const r = await fetch('/send', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({panel, urls: picked.map((p) => p.url)}),
    });
    const d = await r.json();
    $('verdict').textContent = (d.ok ? 'SENT — ' : 'NOT SENT — ') + d.message;
    $('verdict').className = 'verdict' + (d.ok ? ' ok' : ' bad');
  } catch (e) {
    $('verdict').textContent = 'the search service did not answer: ' + e;
  } finally {
    $('send').disabled = false;
  }
}

async function facts() {
  try {
    const d = await (await fetch('/diag')).json();
    $('meta').textContent = 'v' + d.version + ' · node ' + d.node
      + ' · browser ' + (d.browser.ready ? 'ready' : 'not used: ' + d.browser.note)
      + ' · panel ' + (d.panel ? (d.panel.health === 'ok' ? 'reachable' : d.panel.health) : 'not set');
  } catch (e) { $('meta').textContent = 'v${VERSION} · ' + e; }
}

$('find').onclick = find;
$('q').onkeydown = (e) => { if (e.key === 'Enter') find(); };
$('send').onclick = send;
$('save').onclick = () => {
  localStorage.setItem('panel', $('panel').value.trim());
  $('saved').textContent = 'remembered in this browser';
  facts();
};
facts();
</script></body></html>`;
