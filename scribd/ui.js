'use strict';
/** The panel's own page: search Scribd, tick results, download what you ticked. */

const UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scribd panel</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  background:#0b0d12;color:#e7ebf3}
header{display:flex;gap:12px;align-items:center;padding:14px 18px;border-bottom:1px solid #1e2430;
  position:sticky;top:0;background:#0b0d12;z-index:5}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.2px}
h1 span{color:#7d8aa3;font-weight:400}
main{max-width:980px;margin:0 auto;padding:18px}
form{display:flex;gap:8px}
input[type=search],input[type=text]{flex:1;padding:10px 12px;border-radius:8px;border:1px solid #263041;
  background:#11151d;color:inherit;font:inherit}
button{padding:10px 14px;border-radius:8px;border:1px solid #2b6df6;background:#2b6df6;color:#fff;
  font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;border-color:#2b3446;color:#c3ccdc;font-weight:500}
button:disabled{opacity:.5;cursor:not-allowed}
.note{color:#8d99ad;font-size:13px;margin:10px 0}
ul{list-style:none;margin:0;padding:0}
li{display:flex;gap:12px;align-items:flex-start;padding:11px 12px;border:1px solid #1c2330;
  border-radius:10px;margin-bottom:8px;background:#0f131b}
li label{display:flex;gap:11px;align-items:flex-start;flex:1;cursor:pointer}
li input[type=checkbox]{margin:4px 0 0;width:17px;height:17px;accent-color:#2b6df6}
.t{font-weight:600}
.m{color:#8d99ad;font-size:13px}
.bar{height:4px;background:#1c2330;border-radius:99px;overflow:hidden;margin:12px 0}
.bar i{display:block;height:100%;width:0;background:#2b6df6;transition:width .3s}
pre{background:#0f131b;border:1px solid #1c2330;border-radius:10px;padding:12px;overflow:auto;
  font-size:12.5px;color:#9fb0c7;max-height:190px;margin:0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0}
.pill{font-size:12px;padding:3px 9px;border-radius:99px;border:1px solid #263041;color:#9fb0c7}
.pill.ok{border-color:#1f6f45;color:#63d69b}
.pill.bad{border-color:#7a2a2a;color:#f18b8b}
a{color:#7fb0ff}
</style></head><body>
<header><h1>Scribd <span>· search, tick, download</span></h1>
  <span class="pill" id="conn">checking…</span></header>
<main>
  <form id="search">
    <input type="search" id="q" placeholder="Search Scribd by words (e.g. algebra textbook)" autocomplete="off">
    <button type="submit">Search</button>
  </form>
  <div class="note" id="summary">Type a few words, then tick what you want.</div>
  <div class="row">
    <button id="run" disabled>Download ticked</button>
    <button class="ghost" id="reset">Reset</button>
    <span class="pill" id="picked">0 ticked</span>
  </div>
  <div class="bar"><i id="bar"></i></div>
  <ul id="hits"></ul>
  <h3 style="font-size:13px;color:#8d99ad;margin:20px 0 8px">Finished PDFs</h3>
  <ul id="files"></ul>
  <pre id="log"></pre>
</main>
<script>
const $=(id)=>document.getElementById(id);
let hits=[], picked=new Set(), busy=false;
const post=(u,b)=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})})
  .then(async r=>({ok:r.ok,status:r.status,body:await r.json().catch(()=>null)}));
async function health(){
  try{const r=await fetch('/health');const j=await r.json();
    $('conn').textContent=j.state==='running'?'capturing…':'ready';
    $('conn').className='pill '+(r.ok?'ok':'bad');}catch(e){$('conn').textContent='offline';$('conn').className='pill bad';}
}
function render(){
  const list=$('hits');list.innerHTML='';
  if(!hits.length){list.innerHTML='<li class="m">No results yet.</li>';}
  for(const h of hits){
    const li=document.createElement('li');
    const label=document.createElement('label');
    const box=document.createElement('input');box.type='checkbox';box.checked=picked.has(h.id);
    box.onchange=()=>{box.checked?picked.add(h.id):picked.delete(h.id);sync();};
    const div=document.createElement('div');
    div.innerHTML='<div class="t"></div><div class="m"></div>';
    div.querySelector('.t').textContent=h.title||'(untitled)';
    div.querySelector('.m').textContent=[h.pages?h.pages+' pages':null,h.author||null,
      h.views?h.views+' views':null].filter(Boolean).join(' · ');
    label.append(box,div);li.append(label);list.append(li);
  }
  sync();
}
function sync(){
  $('picked').textContent=picked.size+' ticked';
  $('run').disabled=!picked.size||busy;
}
$('search').onsubmit=async(e)=>{
  e.preventDefault();
  const q=$('q').value.trim(); if(!q) return;
  $('summary').textContent='Searching…';
  const r=await post('/find',{query:q});
  if(!r.ok||!r.body){$('summary').textContent=(r.body&&r.body.error)||'Search failed.';return;}
  hits=r.body.hits||[];picked.clear();render();
  $('summary').textContent=r.body.summary||((hits.length)+' result(s)');
};
$('run').onclick=async()=>{
  const docs=hits.filter(h=>picked.has(h.id)).map(h=>({id:h.id,url:h.url,title:h.title,pages:h.pages}));
  if(!docs.length)return;
  busy=true;sync();
  const r=await post('/run',{documents:docs});
  if(!r.ok){$('log').textContent=(r.body&&r.body.error)||'Could not start.';busy=false;sync();return;}
  $('log').textContent='Queued '+docs.length+' document(s)…';
  poll();
};
$('reset').onclick=async()=>{await post('/reset');picked.clear();$('log').textContent='Reset.';refresh();};
async function refresh(){
  try{
    const r=await fetch('/files');const j=await r.json();
    const ul=$('files');ul.innerHTML='';
    const list=(j&&j.files)||[];
    if(!list.length)ul.innerHTML='<li class="m">No PDFs stored yet.</li>';
    for(const f of list){
      const li=document.createElement('li');
      const name=f.name||f.file||String(f);
      const a=document.createElement('a');
      a.href='/file/'+encodeURIComponent(name);a.textContent=name;
      const m=document.createElement('div');m.className='m';
      m.textContent=[f.bytes?Math.round(f.bytes/1024)+' KiB':null,f.age||f.mtime||null].filter(Boolean).join(' · ');
      const d=document.createElement('div');d.append(a,m);li.append(d);ul.append(li);
    }
  }catch(e){/* storage box down */}
}
async function poll(){
  try{
    const r=await fetch('/status');const j=await r.json();
    const p=j.progress||{};
    const total=p.of||0;
    $('bar').style.width=total?Math.round((p.page/total)*100)+'%':'0%';
    $('log').textContent=(j.log||[]).join('\\n')||j.detail||'';
    if(j.state==='running'){$('conn').textContent='capturing…';$('conn').className='pill';setTimeout(poll,1500);return;}
    busy=false;sync();
    $('bar').style.width=j.verdict==='PDF BUILT'?'100%':'0%';
    $('conn').textContent=j.verdict==='PDF BUILT'?'done':(j.verdict||'ready');
    $('conn').className='pill '+(j.verdict==='PDF BUILT'?'ok':(j.verdict?'bad':''));
    if(j.detail)$('summary').textContent=j.detail;
    refresh();
  }catch(e){busy=false;sync();}
}
health();refresh();setInterval(health,15000);
</script></body></html>`;

module.exports = { UI_HTML };
