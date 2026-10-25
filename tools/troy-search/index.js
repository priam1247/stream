/**
 * troy-search — find Scribd documents from the JS box, send the links to the
 * download panel. One file. Depends only on what you already have:
 *
 *     @sparticuz/chromium, puppeteer-core
 *
 * Run:
 *     node index.js                       # a small page on http://0.0.0.0:8096/
 *     node index.js --selftest            # offline check, no network
 *     node index.js "physics 12th"        # search in the terminal, print links
 *     node index.js "physics 12th" --pick 1,3 --panel http://IP:25811
 *
 * Why it tries plain HTTP before the browser: measured on a cloud runner in
 * October 2026, DuckDuckGo's html page answered plain Python with 10 real
 * Scribd links, and refused a real headless Chromium (HTTP 403) on the same
 * page, from the same address, four minutes later. The browser is the part that
 * gets recognised. So the browser is the fallback here, not the engine — and
 * every answer, from every engine, in every mode, is reported as it came.
 *
 * Searches are wrapped as  site:scribd.com <your words>  and every link found
 * is checked against Scribd's own document pattern before it travels. The panel
 * only ever receives links: it does the downloading, this file does the finding.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.0";
const PORT = Number(process.env.PORT || 8096);
const PANEL = (process.env.SCRIBD_PANEL || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_SEND = 40;

// the same pattern the panel accepts, so nothing we send can be rejected there
const DOC_LINK =
  /https?:\/\/(?:[a-z0-9-]+\.)*scribd\.com\/(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)\/\d{3,}(?:\/[^\s"'<>]*)?/gi;
const DOC_ID = /\/(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)\/(\d+)/i;

// ---------------------------------------------------------------------------
// finding links — shared by both modes, so both are judged by one rule
// ---------------------------------------------------------------------------
export function documentLinks(text) {
  const seen = new Map();
  for (const raw of String(text || "").matchAll(DOC_LINK)) {
    let url = raw[0].split("?")[0].split("#")[0].replace(/[.,;)]+$/, "");
    if (!/^https?:/i.test(url)) url = "https:" + url.replace(/^\/+/, "//");
    const id = (url.match(DOC_ID) || [])[1];
    if (!id || seen.has(id)) continue;
    seen.set(id, url);
  }
  return [...seen.values()];
}

export function parseAnchors(html, base = "") {
  const found = [];
  const seen = new Set();
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchor)) {
    const href = unwrap(match[1], base);
    const title = strip(match[2]);
    for (const url of documentLinks(href)) {
      const id = (url.match(DOC_ID) || [])[1];
      if (!id || seen.has(id)) continue;   // a result page links one book many times
      seen.add(id);
      found.push({ url, title });
    }
  }
  return found;
}

/** DuckDuckGo hides its links behind /l/?uddg=…, Bing behind ck/a?u=a1<base64>. */
export function unwrap(href, base = "") {
  let url = htmlDecode(href).trim();
  const ddg = url.match(/[?&]uddg=([^&]+)/);
  if (ddg) return decodeURIComponent(ddg[1]);
  const bing = url.match(/[?&]u=a1([^&]+)/);
  if (bing) {
    try {
      return Buffer.from(decodeURIComponent(bing[1]), "base64").toString("utf8");
    } catch {
      return url;
    }
  }
  if (url.startsWith("//")) return "https:" + url;
  if (base && url.startsWith("/")) {
    try {
      return new URL(url, base).toString();
    } catch {
      return url;
    }
  }
  return url;
}

function strip(html) {
  return htmlDecode(String(html || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function htmlDecode(text) {
  return String(text || "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Scribd's own search answer: results.documents.content.documents[]. */
export function parseScribdJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  let node = data;
  for (const key of ["results", "documents", "content", "documents"]) {
    node = node && typeof node === "object" ? node[key] : undefined;
  }
  const list = Array.isArray(node) ? node : [];
  const hits = [];
  for (const doc of list) {
    if (!doc || typeof doc !== "object") continue;
    const url = String(doc.reader_url || doc.url || "");
    const id = String(doc.id || (url.match(DOC_ID) || [])[1] || "");
    if (!id) continue;
    hits.push({
      url: documentLinks(url)[0] || `https://www.scribd.com/document/${id}`,
      title: strip(doc.title || "") || `document ${id}`,
      pages: Number(doc.pageCount) || 0,
      views: String(doc.views || ""),
      author:
        (Array.isArray(doc.authors) && doc.authors[0] && doc.authors[0].name) ||
        (doc.author && doc.author.name) ||
        "",
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// engines — every one of them is tried, and every answer is kept
// ---------------------------------------------------------------------------
export const ENGINES = [
  {
    name: "scribd",
    mode: "fetch",
    kind: "json",
    url: (q) =>
      "https://www.scribd.com/search/query?query=" +
      encodeURIComponent(q).replace(/%20/g, "+") +
      "&verbatim=true&ct_lang=0",
  },
  {
    name: "duckduckgo",
    mode: "fetch",
    url: (q) =>
      "https://html.duckduckgo.com/html/?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+"),
  },
  {
    name: "duckduckgo-lite",
    mode: "fetch",
    url: (q) =>
      "https://lite.duckduckgo.com/lite/?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+"),
  },
  {
    name: "bing",
    mode: "fetch",
    url: (q) =>
      "https://www.bing.com/search?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+") +
      "&count=30",
  },
  {
    name: "mojeek",
    mode: "fetch",
    url: (q) =>
      "https://www.mojeek.com/search?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+"),
  },
  {
    name: "scribd",
    mode: "browser",
    url: (q) => "https://www.scribd.com/search?query=" + encodeURIComponent(q),
  },
  {
    name: "duckduckgo",
    mode: "browser",
    url: (q) =>
      "https://html.duckduckgo.com/html/?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+"),
  },
  {
    name: "bing",
    mode: "browser",
    url: (q) =>
      "https://www.bing.com/search?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+"),
  },
];

export function engineOrder(mode) {
  if (mode === "browser") return ENGINES.filter((engine) => engine.mode === "browser");
  if (mode === "fetch") return ENGINES.filter((engine) => engine.mode === "fetch");
  // auto: plain http first — measured to be the one that is not refused
  return [...ENGINES.filter((engine) => engine.mode === "fetch"),
          ...ENGINES.filter((engine) => engine.mode === "browser")];
}

/** Say what an HTTP status means for this address, in words a person can act on. */
export function refusal(status, body = "") {
  const low = String(body || "").toLowerCase();
  if (low.includes("captcha") || low.includes("just a moment") ||
      low.includes("client challenge") || low.includes("unusual traffic")) {
    return `HTTP ${status} challenge/captcha page — this address is being asked to prove it is human`;
  }
  if ([401, 403, 429, 503].includes(status)) {
    return `HTTP ${status} — this address was refused`;
  }
  if (!status) return "no answer (the request failed)";
  return `HTTP ${status}`;
}

async function fetchText(url, timeoutMs = 25000) {
  try {
    const answer = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const body = await answer.text();
    return { status: answer.status, body, error: "" };
  } catch (exc) {
    const cause = exc && exc.cause ? (exc.cause.code || exc.cause.message || "") : "";
    const text = String((exc && exc.message) || exc);
    return { status: 0, body: "", error: (cause ? `${text}: ${cause}` : text).slice(0, 200) };
  }
}

export async function searchWithFetch(query, ask = fetchText) {
  const hits = [];
  const notes = [];
  const seen = new Set();
  for (const engine of ENGINES.filter((item) => item.mode === "fetch")) {
    const got = await ask(engine.url(query));
    if (got.status !== 200) {
      notes.push(`${engine.name}: ` + (got.status
        ? refusal(got.status, got.body)
        : `no answer (${got.error || "the request failed"})`));
      continue;
    }
    const found = engine.kind === "json"
      ? parseScribdJson(got.body)
      : parseAnchors(got.body, engine.url(query));
    let fresh = 0;
    for (const hit of found) {
      const id = (hit.url.match(DOC_ID) || [])[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      hits.push({ ...hit, engine: engine.name });
      fresh += 1;
    }
    notes.push(found.length
      ? `${engine.name}: ${found.length} link(s), ${fresh} new`
      : `${engine.name}: answered, no Scribd links in the page`);
    if (hits.length >= MAX_SEND) break;
  }
  return { hits, notes };
}

// ---------------------------------------------------------------------------
// the browser — only when plain http was not enough
// ---------------------------------------------------------------------------
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const chromium = (await import("@sparticuz/chromium")).default;
      const puppeteer = (await import("puppeteer-core")).default;
      const executablePath =
        process.env.CHROME_PATH || (await chromium.executablePath());
      return puppeteer.launch({
        args: chromium.args,
        executablePath,
        headless: "shell",
      });
    })().catch((exc) => {
      browserPromise = null;
      throw exc;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    /* already gone */
  }
}

export async function searchWithBrowser(query) {
  const hits = [];
  const notes = [];
  const seen = new Set();
  let browser;
  try {
    browser = await getBrowser();
  } catch (exc) {
    return { hits, notes: [`browser: could not start — ${String(exc.message || exc).slice(0, 200)}`] };
  }
  for (const engine of ENGINES.filter((item) => item.mode === "browser")) {
    const page = await browser.newPage();
    try {
      await page.setUserAgent(UA);
      const answers = [];
      page.on("response", (response) => {
        const type = response.request().resourceType();
        if (type === "document") answers.push(response.status());
      });
      const target = engine.url(query);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const anchors = await page.evaluate(() =>
        [...document.querySelectorAll("a[href]")].map((a) => ({
          href: a.href,
          text: (a.textContent || "").trim(),
        })),
      );
      let fresh = 0;
      const found = anchors.flatMap((anchor) =>
        documentLinks(unwrap(anchor.href, target))
          .map((url) => ({ url, title: strip(anchor.text) })),
      );
      for (const hit of found) {
        const id = (hit.url.match(DOC_ID) || [])[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        hits.push({ ...hit, engine: engine.name });
        fresh += 1;
      }
      const status = answers.length ? answers[0] : 0;
      const title = await page.title().catch(() => "");
      notes.push(found.length
        ? `${engine.name}: ${found.length} link(s), ${fresh} new (http ${status})`
        : `${engine.name}: ${refusal(status, await page.content().catch(() => ""))}` +
          (title ? ` — page title ${JSON.stringify(title.slice(0, 60))}` : ""));
    } catch (exc) {
      notes.push(`${engine.name}: failed — ${String(exc.message || exc).slice(0, 160)}`);
      if (!browser.isConnected()) {
        browserPromise = null;
        break;
      }
    } finally {
      await page.close().catch(() => {});
    }
    if (hits.length >= MAX_SEND) break;
  }
  return { hits, notes };
}

/** auto = plain http, then the browser only if plain http found nothing. */
export async function search(query, mode = "auto") {
  const words = String(query || "").replace(/\s+/g, " ").trim();
  if (!words) return { hits: [], notes: ["type a few words to search for"], mode };
  if (mode === "browser") {
    const result = await searchWithBrowser(words);
    return { ...result, mode };
  }
  if (mode === "fetch") {
    const result = await searchWithFetch(words);
    return { ...result, mode };
  }
  const plain = await searchWithFetch(words);
  if (plain.hits.length) return { ...plain, mode: "fetch" };
  const withBrowser = await searchWithBrowser(words);
  return {
    hits: withBrowser.hits,
    notes: [...plain.notes, "— plain http found nothing, tried the browser —",
            ...withBrowser.notes],
    mode: "fetch+browser",
  };
}

// ---------------------------------------------------------------------------
// sending to the panel — the panel does the downloading, we only pass links
// ---------------------------------------------------------------------------
export function panelOrigin(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : "http://" + raw);
  } catch {
    return "";
  }
  const host = url.hostname || "";
  if (!host) return "";
  if (!host.includes(".") && host !== "localhost" && !url.port) return "";
  return `${url.protocol}//${url.host}`;
}

/** The panel answers /send with a tiny page whose heading is the whole message. */
export function headline(body) {
  const text = String(body || "");
  const heading = text.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (heading) return strip(heading[1]).slice(0, 200);
  return strip(text.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")).slice(0, 200);
}

export async function sendToPanel(panel, urls) {
  const origin = panelOrigin(panel);
  if (!origin) return { ok: false, message: `not a panel address: ${JSON.stringify(String(panel || ""))}` };
  const wanted = [...new Set((urls || []).flatMap((url) => documentLinks(url)))].slice(0, MAX_SEND);
  if (!wanted.length) return { ok: false, message: "no Scribd document link in that selection" };
  const link = origin + "/send?" + wanted.map((url) => "url=" + encodeURIComponent(url)).join("&");
  const got = await fetchText(link, 30000);
  if (!got.status) {
    return { ok: false, message: `the panel did not answer (${got.error || "no reply"})` };
  }
  const message = got.body
    ? headline(got.body)
    : `HTTP ${got.status}`;
  return {
    ok: got.status === 200,
    message,
    status: got.status,
    sent: wanted,
  };
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------
const PAGE = `<!doctype html>
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
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;')
  .replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

$('panel').value = localStorage.getItem('panel') || '${PANEL}';

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

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
function json(answer, status, payload) {
  const body = JSON.stringify(payload);
  answer.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  answer.end(body);
}

function html(answer, status, body) {
  answer.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  answer.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

export async function browserStatus() {
  try {
    const chromium = (await import("@sparticuz/chromium")).default;
    const executablePath = process.env.CHROME_PATH || (await chromium.executablePath());
    return { ready: Boolean(executablePath), note: "", path: executablePath };
  } catch (exc) {
    return { ready: false, note: String(exc.message || exc).slice(0, 160) };
  }
}

export function serve(port = PORT) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    try {
      if (url.pathname === "/health") return html(response, 200, "ok");
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return html(response, 200, PAGE);
      }
      if (url.pathname === "/diag") {
        const browser = await browserStatus();
        const panel = { address: PANEL || "", health: "not set" };
        const origin = panelOrigin(PANEL);
        if (origin) {
          const got = await fetchText(origin + "/health", 12000);
          panel.health = got.status === 200 ? "ok" : refusal(got.status, got.body);
        }
        return json(response, 200, {
          version: VERSION,
          node: process.version,
          browser,
          panel,
          engines: ENGINES.map((engine) => `${engine.name} (${engine.mode})`),
          maxSend: MAX_SEND,
        });
      }
      if (url.pathname === "/search" && request.method === "POST") {
        const payload = await readJson(request);
        const query = String(payload.query || "").trim();
        if (!query) return json(response, 400, { error: "type a few words to search for" });
        const mode = ["auto", "fetch", "browser"].includes(payload.mode)
          ? payload.mode
          : "auto";
        console.log(`search [${mode}] ${query}`);
        const result = await search(query, mode);
        console.log(`  -> ${result.hits.length} hit(s) · ${result.notes.join(" | ")}`);
        return json(response, 200, {
          ...result,
          summary: result.hits.length ? `${result.hits.length} document(s) found` : "nothing found",
        });
      }
      if (url.pathname === "/send" && request.method === "POST") {
        const payload = await readJson(request);
        const result = await sendToPanel(payload.panel || PANEL, payload.urls || []);
        console.log(`send -> ${result.ok ? "ok" : "refused"}: ${result.message}`);
        return json(response, result.ok ? 200 : 502, result);
      }
      return json(response, 404, { error: "unknown endpoint" });
    } catch (exc) {
      console.error("error:", exc);
      return json(response, 500, { error: String(exc.message || exc).slice(0, 300) });
    }
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`open http://0.0.0.0:${port}/ — search, tick, send to the panel`);
    if (!PANEL) console.log("no panel address set: type it in the page (it is remembered)");
  });
  return server;
}

// ---------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------
export function picked(hits, spec) {
  const chosen = [];
  for (const part of String(spec || "").replace(/\s+/g, ",").split(",")) {
    if (!part) continue;
    const range = part.match(/^(\d+)-(\d+)$/);
    const numbers = range
      ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i)
      : [Number(part)];
    for (const number of numbers) {
      const hit = hits[number - 1];
      if (hit && !chosen.includes(hit)) chosen.push(hit);
    }
  }
  return chosen;
}

export function selftest() {
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const sample = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.scribd.com%2Fdocument%2F1234%2FA-Book">A book</a>
    <a href="https://www.scribd.com/document/1234/A-Book?utm=x">same book, one page</a>
    <a href="https://www.scribd.com/document/5678/Other#page=3">Other</a>
    <a href="https://example.com/document/9999/nope">elsewhere</a>
    <a href="https://www.scribd.com/about">about</a>`;
  const anchors = parseAnchors(sample, "https://html.duckduckgo.com/html/");
  assert(anchors.length === 2, `expected 2 document links, got ${anchors.length}`);
  assert(anchors[0].url === "https://www.scribd.com/document/1234/A-Book", anchors[0].url);
  assert(anchors[1].url === "https://www.scribd.com/document/5678/Other", anchors[1].url);

  assert(unwrap("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.scribd.com%2Fdocument%2F1%2Fx")
    === "https://www.scribd.com/document/1/x", "ddg unwrap");
  const bingTarget = "https://www.scribd.com/document/42/Y";
  const bingHref = "https://www.bing.com/ck/a?!&&p=abc&u=a1" +
    encodeURIComponent(Buffer.from(bingTarget).toString("base64")) + "&ntb=1";
  assert(unwrap(bingHref) === bingTarget, "bing unwrap: " + unwrap(bingHref));

  assert(documentLinks("https://www.scribd.com/doc/10004/NCERT-Index")[0].includes("/doc/10004/"),
    "short /doc/ form");
  assert(documentLinks("https://id.scribd.com/document/777/Spaced").length === 1, "language host");
  assert(documentLinks("no links here").length === 0, "empty");
  assert(documentLinks("https://example.com/document/5/x").length === 0, "other site");

  const scribdJson = JSON.stringify({
    results: { documents: { content: { documents: [
      { id: 111111111, title: " Physics 12th ", pageCount: 402, views: "12K",
        reader_url: "https://www.scribd.com/document/111111111/P?x=1",
        authors: [{ name: "a" }] },
      { id: 222222222, title: "other",
        reader_url: "https://www.scribd.com/document/222222222/O" },
    ] } } },
  });
  const parsed = parseScribdJson(scribdJson);
  assert(parsed.length === 2, `scribd json: ${parsed.length}`);
  assert(parsed[0].title === "Physics 12th" && parsed[0].pages === 402, parsed[0].title);
  assert(parsed[0].url === "https://www.scribd.com/document/111111111/P", parsed[0].url);
  assert(parseScribdJson("<html>not json</html>").length === 0, "html is not json");

  assert(panelOrigin("195.123.189.187:25811") === "http://195.123.189.187:25811", "bare host");
  assert(panelOrigin("http://1.2.3.4:25811/") === "http://1.2.3.4:25811", "trailing slash");
  assert(panelOrigin("nonsense") === "", "typo rejected");
  assert(panelOrigin("") === "", "empty rejected");

  const reply = "<html><head><style>body{x:1}</style></head><body><h3>queued 3 link(s)</h3></body></html>";
  assert(headline(reply) === "queued 3 link(s)", `headline: ${headline(reply)}`);
  assert(headline("<p>plain words</p>") === "plain words", "headline without a heading");

  assert(refusal(403).includes("refused"), "403 wording");
  assert(refusal(200, "Please solve this CAPTCHA").includes("challenge"), "captcha wording");
  assert(refusal(0).includes("no answer"), "no answer wording");

  const hits = [{ url: "a" }, { url: "b" }, { url: "c" }];
  assert(picked(hits, "2")[0].url === "b", "pick one");
  assert(picked(hits, "1-2").length === 2, "pick range");
  assert(picked(hits, "9").length === 0, "pick out of range");
  assert(engineOrder("fetch").every((e) => e.mode === "fetch"), "fetch order");
  assert(engineOrder("auto")[0].mode === "fetch", "auto starts with plain http");

  const urls = ENGINES[1].url("physics 12th");
  assert(urls.includes("site%3Ascribd.com+physics+12th"), urls);

  return "selftest: every check passed — link parsing, redirect unwrapping, scribd json, panel address, panel reply, picking, engine order";
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------
export async function runCli(args) {
  let query = "";
  let pick = "";
  let panel = PANEL;
  let mode = "auto";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pick") pick = args[++index] || "";
    else if (arg === "--panel") panel = args[++index] || "";
    else if (arg === "--mode") mode = args[++index] || "auto";
    else if (arg === "--browser") mode = "browser";
    else if (arg === "--fetch") mode = "fetch";
    else if (!arg.startsWith("-")) query = arg;
  }
  if (!query) {
    console.log('usage: node index.js "physics 12th" [--pick 1,3] [--panel http://ip:port]');
    return 2;
  }
  const result = await search(query, mode);
  for (const note of result.notes) console.log("  " + note);
  if (!result.hits.length) {
    console.log("no documents found");
    await closeBrowser();
    return 1;
  }
  result.hits.forEach((hit, index) => {
    const extra = [hit.pages ? `${hit.pages} pages` : "", hit.views ? `${hit.views} views` : "",
                   hit.author || ""].filter(Boolean).join(" · ");
    console.log(`  ${String(index + 1).padStart(2)}. ${hit.title}`);
    console.log(`      ${hit.url}${extra ? "   (" + extra + ")" : ""}`);
  });
  if (!pick) {
    console.log(`${result.hits.length} document(s) — add --pick 1,3 to send any of them`);
    await closeBrowser();
    return 0;
  }
  const chosen = picked(result.hits, pick);
  if (!chosen.length) {
    console.log(`nothing matches --pick ${pick}`);
    await closeBrowser();
    return 2;
  }
  if (!panel) {
    console.log(`${chosen.length} picked, but no --panel and no SCRIBD_PANEL — nothing sent`);
    await closeBrowser();
    return 0;
  }
  const sent = await sendToPanel(panel, chosen.map((hit) => hit.url));
  console.log(sent.ok ? `SENT — ${sent.message}` : `NOT SENT — ${sent.message}`);
  await closeBrowser();
  return sent.ok ? 0 : 1;
}

/**
 * @sparticuz/chromium unpacks into TMPDIR, so give it one inside the project.
 *
 *   node index.js                 serve the page
 *   node index.js --selftest      offline check
 *   node index.js "words" …       search in the terminal
 */
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const tmp = path.join(process.cwd(), "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  process.env.TMPDIR = tmp;
  process.env.AWS_EXECUTION_ENV = process.env.AWS_EXECUTION_ENV ||
    "AWS_Lambda_nodejs22.x";

  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    try {
      console.log(selftest());
      process.exit(0);
    } catch (exc) {
      console.error("selftest FAILED:", exc.message);
      process.exit(1);
    }
  }
  // a word that is not a flag, and not a flag's value, means: search from here
  const flagsWithValues = new Set(["--pick", "--panel", "--mode"]);
  const spoken = args.filter((arg, index) =>
    !arg.startsWith("-") && !flagsWithValues.has(args[index - 1]));
  if (!args.length || args.includes("--serve") || !spoken.length) {
    serve(PORT);
  } else {
    runCli(args).then((code) => process.exit(code));
  }
}
