'use strict';
/** Offline checks: no browser, no network. `node index.js --selftest` */

const fs = require('fs');
const path = require('path');

const checks = [];
function check(label, fn) {
  checks.push({ label, fn });
}

check('ports resolve to something listenable', () => {
  const ports = require('./config').ports();
  if (!ports.length) throw new Error('no port');
  for (const port of ports) {
    if (!(port > 0 && port < 65536)) throw new Error(`bad port ${port}`);
  }
  return ports.join(', ');
});

check('store address is an http(s) URL', () => {
  const url = require('./config').storeUrl();
  if (!/^https?:\/\//.test(url)) throw new Error(url);
  return url;
});

check('search URL keeps the query and page', () => {
  const { searchUrl } = require('./scribd');
  const one = searchUrl('linear algebra', 1);
  const two = searchUrl('linear algebra', 3);
  if (!one.includes('query=linear+algebra')) throw new Error(one);
  if (!/page=3/.test(two)) throw new Error(two);
  return 'query + page';
});

check('document ids come out of Scribd links', () => {
  const { docIdOf, cleanUrl, embedUrl } = require('./scribd');
  const cases = [
    ['https://www.scribd.com/document/123456789/Some-Title', '123456789'],
    ['https://www.scribd.com/document/123456789', '123456789'],
    ['www.scribd.com/embeds/5555/content', '5555'],
  ];
  for (const [input, expected] of cases) {
    const got = docIdOf(input);
    if (got !== expected) throw new Error(`${input} -> ${got}`);
  }
  if (cleanUrl('https://www.scribd.com/document/9/x?y=1') !== 'https://www.scribd.com/document/9') {
    throw new Error('cleanUrl');
  }
  if (!embedUrl('https://www.scribd.com/document/9/x').includes('/embeds/9/content')) {
    throw new Error('embedUrl');
  }
  return `${cases.length} links`;
});

check('hits keep the dashboard shape', () => {
  const { hitFrom } = require('./scribd');
  const hit = hitFrom({
    id: 42,
    title: '  A   Book ',
    reader_url: 'https://www.scribd.com/document/42/A-Book',
    pageCount: 12,
    views: '9',
    authors: [{ name: 'Ann' }],
  });
  for (const key of ['id', 'title', 'url', 'pages', 'views', 'author']) {
    if (!(key in hit)) throw new Error(`missing ${key}`);
  }
  if (hit.pages !== 12) throw new Error('pages');
  if (hit.author !== 'Ann') throw new Error('author');
  if (hit.title !== 'A Book') throw new Error(`title ${hit.title}`);
  return 'id/title/url/pages/views/author';
});

check('ranking puts title matches first and marks them', () => {
  const { rankHits } = require('./scribd');
  const hits = [
    { id: '1', title: 'Unrelated' },
    { id: '2', title: 'Linear Algebra Done Right' },
    { id: '3', title: 'Algebra Basics' },
  ];
  const ranked = rankHits(hits, 'linear algebra');
  if (ranked[0].id !== '2') throw new Error(ranked.map((h) => h.id).join(','));
  if (ranked[0].match !== 'all') throw new Error('match');
  return 'phrase > words';
});

check('page boundaries never slice into the next page', () => {
  const { clipsFromBoxes } = require('./capture');
  const boxes = [0, 1, 2].map((i) => ({
    number: i + 1,
    left: 10,
    right: 610,
    top: 100 + i * 820,
    bottom: 100 + i * 820 + 800,
  }));
  const clips = clipsFromBoxes(boxes, 640, 3000);
  if (clips.length !== 3) throw new Error(`got ${clips.length} clips`);
  for (let i = 0; i < clips.length; i += 1) {
    if (clips[i].height <= 0) throw new Error('empty clip');
    if (i > 0 && clips[i].y < clips[i - 1].y + clips[i - 1].height) {
      throw new Error(`clip ${i} overlaps the previous page`);
    }
    if (clips[i].y > boxes[i].top) throw new Error(`clip ${i} starts below its page`);
  }
  return `${clips.length} non-overlapping clips`;
});

check('blank detection rejects a white sheet and keeps a real one', () => {
  const jpeg = require('jpeg-js');
  const { isBlank } = require('./pdf');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-'));

  const white = { width: 120, height: 160, data: Buffer.alloc(120 * 160 * 4, 255) };
  const whitePath = path.join(dir, 'white.jpg');
  fs.writeFileSync(whitePath, jpeg.encode(white, 80).data);

  const busy = Buffer.alloc(120 * 160 * 4, 255);
  for (let y = 20; y < 140; y += 1) {
    for (let x = 20; x < 100; x += 1) {
      const i = (y * 120 + x) * 4;
      busy[i] = 10;
      busy[i + 1] = 10;
      busy[i + 2] = 10;
    }
  }
  const busyPath = path.join(dir, 'busy.jpg');
  fs.writeFileSync(busyPath, jpeg.encode({ width: 120, height: 160, data: busy }, 80).data);

  const whiteBlank = isBlank(whitePath);
  const busyBlank = isBlank(busyPath);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!whiteBlank) throw new Error('white page was not detected as blank');
  if (busyBlank) throw new Error('a page with ink was called blank');
  return 'white skipped, ink kept';
});

check('PDF builder writes the exact page count', async () => {
  const jpeg = require('jpeg-js');
  const { buildPdf } = require('./pdf');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-pdf-'));
  const images = [];
  for (let i = 0; i < 12; i += 1) {
    const data = Buffer.alloc(60 * 80 * 4, 255);
    for (let y = 5; y < 20; y += 1) {
      for (let x = 5; x < 55; x += 1) {
        const idx = (y * 60 + x) * 4;
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
      }
    }
    const file = path.join(dir, `p${i}.jpg`);
    fs.writeFileSync(file, jpeg.encode({ width: 60, height: 80, data }, 80).data);
    images.push(file);
  }
  const out = path.join(dir, 'twelve.pdf');
  const bytes = await buildPdf(images, out, 12);
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.load(fs.readFileSync(out));
  const pages = doc.getPageCount();
  fs.rmSync(dir, { recursive: true, force: true });
  if (pages !== 12) throw new Error(`got ${pages} pages`);
  return `12 pages · ${Math.round(bytes / 1024)} KiB`;
});

check('panel answers its routes locally', async () => {
  const { makeTestServer } = require('./selftest-server');
  const server = await makeTestServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    if (!health.ok) throw new Error('health');
    results.push('/health');

    const ui = await fetch(`${base}/`).then((r) => r.text());
    if (!ui.toLowerCase().includes('<title>scribd')) throw new Error('ui');
    results.push('/');

    const bad = await fetch(`${base}/find`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    });
    if (bad.status !== 400) throw new Error(`empty find -> ${bad.status}`);
    results.push('/find empty');

    const run = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: [] }),
    });
    if (run.status !== 400) throw new Error(`empty run -> ${run.status}`);
    results.push('/run empty');

    const missing = await fetch(`${base}/nope`);
    if (missing.status !== 404) throw new Error(`404 -> ${missing.status}`);
    results.push('/404');
  } finally {
    server.close();
  }
  return results.join(', ');
});

async function run() {
  let failures = 0;
  for (const { label, fn } of checks) {
    try {
      const detail = await fn();
      console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      failures += 1;
      console.log(`  FAIL ${label} — ${err.message}`);
    }
  }
  if (failures) {
    console.log(`\nSELFTEST FAILED — ${failures} of ${checks.length}`);
    return 1;
  }
  console.log(`\nSELFTEST OK — ${checks.length} checks passed`);
  return 0;
}

module.exports = { run };
