'use strict';
/**
 * The panel the dashboard talks to (Botkeep side).
 *
 * Routes are the dashboard's existing contract: /health, /status, /find, /run,
 * /files, /file, /reset, plus /diag and /link. Capture happens here with the
 * local Chromium; finished PDFs are handed to the Python storage server, and
 * /files and /file are served from there so downloads come off that box.
 */

const fs = require('fs');
const http = require('http');

const config = require('./config');
const scribd = require('./scribd');
const capture = require('./capture');
const store = require('./store');
const { UI_HTML } = require('./ui');

const state = {
  queue: [],
  job: null, // { id, doc, started, progress }
  outcome: null, // { ok, verdict, detail, file, name, seconds, pages }
  log: [],
  cancel: null,
  lastTitle: '',
};

/** The last /find results, so /run can recover title and page count. */
const hitsById = new Map();

function rememberHits(hits) {
  for (const hit of hits || []) {
    if (hit && hit.id) hitsById.set(String(hit.id), hit);
  }
  if (hitsById.size > 4000) hitsById.clear();
}

function note(message) {
  const line = String(message || '').trim();
  if (!line) return;
  state.log.push(line);
  if (state.log.length > config.MAX_LOG_LINES) state.log.shift();
  console.log(`[panel] ${line}`);
}

function progress(page, of, ok) {
  if (!state.job) return;
  state.job.progress = { page, of, ok };
}

function statusBody() {
  const job = state.job;
  const outcome = state.outcome;
  return {
    state: job ? 'running' : 'idle',
    verdict: outcome ? (outcome.ok ? 'PDF BUILT' : 'failed') : '',
    detail: job
      ? `Capturing ${state.lastTitle || 'document'}${job.progress ? ` (${job.progress.page}/${job.progress.of})` : ''}`
      : outcome
        ? outcome.detail || ''
        : 'Search Scribd, tick results, download ticked.',
    url: job && job.doc ? job.doc.url : '',
    title: state.lastTitle,
    file: outcome && outcome.file ? outcome.file : '',
    name: outcome && outcome.name ? outcome.name : '',
    seconds: outcome && outcome.seconds ? Math.round(outcome.seconds) : 0,
    pages: outcome && outcome.pages ? outcome.pages : 0,
    version: config.VERSION,
    cookies: config.cookieReport(),
    sample: 'screenshot-boundaries',
    progress: job && job.progress ? job.progress : { page: 0, of: 0, ok: 0, skipped: 0, blank: 0 },
    queued: state.queue.length,
    log: state.log.slice(-24),
  };
}

async function runJob(job) {
  state.job = job;
  state.cancel = new AbortController();
  state.lastTitle = job.doc.title || '';
  note(`start ${job.doc.url}`);
  try {
    const result = await capture.captureDocument(job.doc, {
      progress,
      log: note,
      cancel: state.cancel,
    });
    note(`handing ${result.name} to the storage server`);
    await store.upload(result.path, result.name);
    state.outcome = {
      ok: true,
      file: result.name,
      name: result.name,
      pages: result.pages,
      seconds: result.seconds,
      detail: `${result.pages} page(s) · ${Math.round(result.bytes / 1024)} KiB · stored`,
    };
    note(`done ${result.name} (${result.pages} pages)`);
    try {
      fs.rmSync(result.workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    state.outcome = { ok: false, detail: message, file: '', name: '', pages: 0, seconds: 0 };
    note(`failed: ${message}`);
  } finally {
    state.job = null;
    state.cancel = null;
    pump();
  }
}

function pump() {
  if (state.job || !state.queue.length) return;
  const job = state.queue.shift();
  runJob(job).catch((err) => note(`worker error: ${err.message}`));
}

/**
 * What the dashboard already sends: the ticked results as `urls`, plus the
 * older free-text `links` field. Bare URLs are enriched from the last /find so
 * the page count Scribd reported stays authoritative.
 */
function documentsFrom(body) {
  const docs = [];
  const seen = new Set();

  const push = (rawUrl, meta) => {
    const url = String(rawUrl || '').trim();
    const ident = scribd.docIdOf(url) || String((meta && meta.id) || '');
    if (!ident || seen.has(ident)) return;
    seen.add(ident);
    const cached = hitsById.get(ident) || {};
    const pages = Number((meta && meta.pages) || cached.pages || 0) || 0;
    docs.push({
      id: ident,
      url: scribd.cleanUrl(url) || scribd.documentUrl(ident),
      title: String((meta && meta.title) || '').trim() || cached.title || scribd.titleFromUrl(url),
      pages: Math.max(0, Math.min(pages, config.MAX_PAGES)),
    });
  };

  if (Array.isArray(body.documents)) {
    for (const item of body.documents) {
      if (item) push(item.url, item);
    }
  }
  if (Array.isArray(body.urls)) {
    for (const url of body.urls) push(url, null);
  }
  if (typeof body.links === 'string') {
    for (const url of body.links.split(/[\s,]+/)) push(url, null);
  }
  return docs.slice(0, config.MAX_DOCUMENTS);
}

function readBody(req, limit = config.MAX_BODY_BYTES) {  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('That request was too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function authorised(req) {
  const key = config.panelKey();
  if (!key) return true;
  const given = req.headers['x-panel-key'] || '';
  if (given === key) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((part) => part.trim() === `${config.PANEL_COOKIE}=${key}`);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = (process.env.SCRIBD_PANEL_ORIGIN || '')
    .split(',')
    .map((part) => part.trim().replace(/\/+$/, ''))
    .filter((part) => part && part !== '*');
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Panel-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

async function handle(req, res) {
  cors(req, res);
  const url = new URL(req.url || '/', 'http://panel.local');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/health') {
    sendJson(res, 200, { ok: true, version: config.VERSION, role: 'panel', locked: Boolean(config.panelKey()), state: state.job ? 'running' : 'idle' });
    return;
  }

  if (pathname === '/' && req.method === 'GET') {
    const html = UI_HTML;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  if (!authorised(req)) {
    sendJson(res, 401, { error: 'This panel is locked. Add the panel key.' });
    return;
  }

  if (pathname === '/diag') {
    const storeHealth = await store.health().catch((err) => ({ ok: false, body: { error: err.message } }));
    sendJson(res, 200, {
      ok: true,
      version: config.VERSION,
      role: 'capture (this server) + storage (python server)',
      browser: 'Chromium',
      executable: capture.executablePath() || 'bundled (@sparticuz/chromium)',
      cookies: config.cookieReport(),
      store_url: config.storeUrl(),
      store_ok: storeHealth.ok,
      store: storeHealth.body,
      ports: state.boundPorts || config.ports(),
    });
    return;
  }

  if (pathname === '/status') {
    sendJson(res, 200, statusBody());
    return;
  }

  if (pathname === '/files') {
    try {
      const listing = await store.files();
      const files = (Array.isArray(listing.files) ? listing.files : []).map((file) => ({
        ...file,
        name: String(file.name || ''),
        bytes: Number(file.bytes) || 0,
        // The dashboard formats `when` as epoch seconds.
        when: Number(file.when) || Math.floor((Number(file.mtime) || 0) / 1000) || 0,
      }));
      sendJson(res, 200, { ...listing, files });
    } catch (err) {
      sendJson(res, 200, { files: [], error: err.message });
    }
    return;
  }

  if (pathname.startsWith('/file/') || pathname === '/file') {
    const name = decodeURIComponent(
      pathname.startsWith('/file/') ? pathname.slice('/file/'.length) : url.searchParams.get('name') || '',
    );
    if (!name) {
      sendJson(res, 400, { error: 'Which file?' });
      return;
    }
    try {
      const answer = await store.download(name);
      if (!answer.ok) {
        sendJson(res, answer.status === 404 ? 404 : 502, { error: `The storage server refused that file (HTTP ${answer.status}).` });
        return;
      }
      const headers = {
        'Content-Type': answer.headers.get('content-type') || 'application/pdf',
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      };
      const length = answer.headers.get('content-length');
      if (length) headers['Content-Length'] = length;
      res.writeHead(200, headers);
      // Stream it: a 150 MB book must never be held in memory on this box.
      if (!answer.body) {
        res.end();
        return;
      }
      const { Readable } = require('stream');
      Readable.fromWeb(answer.body).pipe(res);
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }

  if (pathname === '/link' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const name = String(body.name || '');
    if (!name) {
      sendJson(res, 400, { error: 'Which file?' });
      return;
    }
    sendJson(res, 200, { url: `${config.storeUrl()}/file/${encodeURIComponent(name)}`, name });
    return;
  }

  if (pathname === '/find' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      sendJson(res, 400, { error: 'Send JSON.' });
      return;
    }
    const query = String(body.query || '');
    if (!query.trim()) {
      sendJson(res, 400, { error: 'Type a few words to search Scribd for.' });
      return;
    }
    const found = await scribd.findPage(query, body.page || 1);
    rememberHits(found.hits);
    sendJson(res, 200, found);
    return;
  }

  if (pathname === '/run' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      sendJson(res, 400, { error: 'Send JSON.' });
      return;
    }
    if (state.job) {
      sendJson(res, 409, { error: 'A download is already running. Wait for it to finish.' });
      return;
    }
    const docs = documentsFrom(body);
    if (!docs.length) {
      sendJson(res, 400, { error: 'Tick at least one document first.' });
      return;
    }
    state.outcome = null;
    state.log = [];
    state.queue = docs.map((doc) => ({ doc, queued: Date.now() }));
    note(`queued ${docs.length} document(s)`);
    pump();
    sendJson(res, 200, { ok: true, queued: docs.length, documents: docs.map((d) => d.id) });
    return;
  }

  if (pathname === '/reset' && req.method === 'POST') {
    state.queue = [];
    if (state.cancel) state.cancel.abort();
    state.outcome = null;
    state.log = [];
    try {
      await store.reset();
    } catch {
      /* the storage box being down must not break reset */
    }
    sendJson(res, 200, { ok: true, stopped: true });
    return;
  }

  sendJson(res, 404, { error: 'No such route.' });
}

function serve() {
  const wanted = config.ports();
  const bound = [];

  for (const port of wanted) {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
        else res.destroy();
      });
    });
    server.on('clientError', (_err, socket) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
    server.listen(port, config.HOST, () => {
      console.log(`[panel] listening on http://${config.HOST}:${port}`);
    });
    server.on('error', (err) => console.error(`[panel] cannot listen on ${port}: ${err.code || err.message}`));
    bound.push(server);
  }
  state.boundPorts = wanted;

  console.log(`[panel] Scribd panel v${config.VERSION} · capture on this server`);
  console.log(`[panel] cookies: ${config.cookieReport()}`);
  console.log(`[panel] finished PDFs are stored on: ${config.storeUrl()}`);

  store.health().then((result) => {
    if (result.ok) console.log('[panel] storage server is up');
    else console.log('[panel] storage server is NOT answering yet — captures will report it');
  });

  const stop = () => {
    for (const server of bound) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }
    capture.closeBrowser().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return bound;
}

module.exports = { serve, handle, state, statusBody };
