#!/usr/bin/env node
'use strict';

// Offline pre-hosting regressions. All binaries, files and remote responses in
// these tests are fixtures; no WhatsApp session or provider is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
// Keep the HTTP cap small in this isolated process so size-limit behavior can
// be tested without downloading gigabytes. Lower the sample floor accordingly
// so verification can exercise the same boundary.
process.env.MAX_DOWNLOAD_MB = '1';
process.env.MIN_SAMPLE_MB = '0';
process.env.DOWNLOAD_RETRIES = '0';
process.env.MAX_PER_HOST = '4';
process.env.REALDEBRID_API_KEY = '';
process.env.DEBRID_API_KEY = '';
process.env.ALLDEBRID_API_KEY = 'offline-test';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-preflight-'));
const ROOT = createBotFixture(TMP);
const botRequire = createRequire(path.join(ROOT, 'scripts', 'test-preflight.js'));
process.chdir(TMP);
const nm3u8dl = require(path.join(ROOT, 'utils/nm3u8dl'));

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('HLS helper detects supported flags rather than silently skipping them', () => {
  const supported = path.join(TMP, 'supported-hls');
  const older = path.join(TMP, 'older-hls');
  fs.writeFileSync(supported, '#!/usr/bin/env node\nconsole.log("--no-config --vod-select-parts --no-log");\n', { mode: 0o755 });
  fs.writeFileSync(older, '#!/usr/bin/env node\nconsole.log("--no-log");\n', { mode: 0o755 });

  const flags = nm3u8dl.supportedFlags(supported);
  assert.ok(flags.has('--no-config'));
  assert.ok(flags.has('--vod-select-parts'));
  const argsFor = (bin) => nm3u8dl.buildArgs('https://example.test/master.m3u8', {
    bin, workTmpDir: TMP, workOutDir: TMP,
  });
  assert.ok(argsFor(supported).includes('--no-config'));
  assert.equal(argsFor(supported)[argsFor(supported).indexOf('--vod-select-parts') + 1], 'false');
  assert.ok(!argsFor(older).includes('--no-config'));
  assert.ok(!argsFor(older).includes('--vod-select-parts'));
});

test('Cinemeta searches the requested media type and enriches a selected result', async () => {
  const metadata = await import(pathToFileURL(path.join(ROOT, 'engine/metadata/index.js')).href);
  const sources = metadata.SOURCES.slice();
  const oldFetch = global.fetch;
  const requested = [];
  try {
    // Exercise the real metadata orchestrator and Cinemeta adapter, without
    // allowing unrelated providers or external network calls into the test.
    metadata.SOURCES.splice(0, metadata.SOURCES.length, metadata.cinemeta);
    global.fetch = async (url) => {
      requested.push(String(url));
      if (String(url).includes('/meta/series/tt1234567.json')) {
        return Response.json({ meta: { imdb_id: 'tt1234567', moviedb_id: 987, name: 'Audit Series', releaseInfo: '2022' } });
      }
      if (String(url).includes('/catalog/series/')) {
        return Response.json({ metas: [{ imdb_id: 'tt1234567', name: 'Audit Series', releaseInfo: '2022' }] });
      }
      if (String(url).includes('/catalog/movie/')) {
        return Response.json({ metas: [{ imdb_id: 'tt7654321', name: 'Audit Film', releaseInfo: '2021' }] });
      }
      throw new Error(`Unexpected test request: ${url}`);
    };
    const series = await metadata.search('Audit Series', { type: 'series' });
    assert.equal(series.length, 1);
    assert.equal(series[0].type, 'series');
    assert.equal(series[0].imdbId, 'tt1234567');
    assert.ok(requested.some((url) => url.includes('/catalog/series/')));
    const details = await metadata.details(series[0]);
    assert.equal(details.tmdbId, 987);

    const movies = await metadata.search('Audit Film', { type: 'movie' });
    assert.equal(movies.length, 1);
    assert.equal(movies[0].type, 'movie');
    assert.ok(requested.some((url) => url.includes('/catalog/movie/')));
    // Keep the adapter's documented string-argument form compatible too.
    assert.equal((await metadata.cinemeta.search('Audit Series', 'series'))[0].type, 'series');
  } finally {
    metadata.SOURCES.splice(0, metadata.SOURCES.length, ...sources);
    global.fetch = oldFetch;
  }
});

test('movie verification reads only a bounded prefix when a server ignores Range', async () => {
  const { sniffRemote, probeRange } = await import(pathToFileURL(path.join(ROOT, 'engine/core/verify.js')).href);
  const fakeBin = path.join(TMP, 'fake-tools');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'ffprobe'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'console.log(JSON.stringify({ streams: [{ height: 720 }], bytesRead: fs.statSync(process.argv.at(-1)).size }));',
    '',
  ].join('\n'), { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${oldPath}`;
  let closed = 0;
  const server = http.createServer((_req, res) => {
    res.on('close', () => { closed += 1; });
    // Ignore Range and hold a much larger response open. A safe sniffer should
    // consume the prefix and cancel, not buffer a potentially multi-GB movie.
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    const first = Buffer.alloc(64 * 1024, 1);
    first.write('ftyp', 4, 'ascii');
    res.write(first);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/video`;
  const bounded = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('read waited for the whole response')), 1500); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  try {
    assert.equal(await bounded(sniffRemote(url)), 'mp4');
    const probe = await bounded(probeRange(url, 25000));
    assert.equal(probe.bytesRead, 25000);
    assert.equal(probe.streams[0].height, 720);
  } finally {
    process.env.PATH = oldPath;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(closed >= 2, 'responses should be released after reading the prefix');
});

test('provider host limits reserve a released slot for an already waiting request', async () => {
  const { req } = await import(pathToFileURL(path.join(ROOT, 'engine/core/http.js')).href);
  const oldFetch = global.fetch;
  let active = 0;
  let peak = 0;
  let releaseImmediately = false;
  const controls = [];
  global.fetch = async () => {
    active += 1;
    peak = Math.max(peak, active);
    let done;
    const ready = new Promise((resolve) => { done = resolve; });
    controls.push(done);
    if (releaseImmediately) done();
    return {
      ok: true, status: 200, headers: { getSetCookie: () => [] },
      async text() { await ready; active -= 1; return '{}'; },
    };
  };
  const url = (n) => `https://preflight-limit.example/${n}`;
  const options = { retries: 0, coalesce: false, timeout: 5000 };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const first = Array.from({ length: 4 }, (_, i) => req(url(i), options));
  let waiting, late;
  try {
    await tick();
    assert.equal(controls.length, 4);
    waiting = req(url('waiting'), options);
    await tick();
    assert.equal(controls.length, 4);
    // Queue the late arrival after one response settles but before the waiting
    // acquire continuation runs. It must not take a slot already handed over.
    controls[0]();
    queueMicrotask(() => queueMicrotask(() => { late = req(url('late'), options); }));
    await tick();
  } finally {
    releaseImmediately = true;
    controls.forEach((resolve) => resolve());
    await Promise.all([...first, waiting, late].filter(Boolean));
    global.fetch = oldFetch;
  }
  assert.equal(peak, 4);
});

test('provider cookies respect host, domain, path, secure and expiry attributes', async () => {
  const { default: Jar } = await import(pathToFileURL(path.join(ROOT, 'engine/core/jar.js')).href);
  const jar = new Jar();
  jar.set('https://example.test/watch/page', [
    'hostOnly=one; Path=/; Secure',
    'scoped=two; Domain=example.test; Path=/watch; Secure',
    'foreign=three; Domain=evil.test; Path=/; Secure',
    'expired=four; Max-Age=0; Path=/',
  ]);
  const own = jar.headerFor('https://example.test/watch/episode');
  assert.match(own, /hostOnly=one/);
  assert.match(own, /scoped=two/);
  assert.doesNotMatch(own, /foreign|expired/);
  const sub = jar.headerFor('https://sub.example.test/watch/episode');
  assert.match(sub, /scoped=two/);
  assert.doesNotMatch(sub, /hostOnly/);
  assert.doesNotMatch(jar.headerFor('https://example.test/other') || '', /scoped=/);
  assert.equal(jar.headerFor('http://example.test/watch/episode'), null);
  assert.equal(jar.headerFor('https://example.test.evil.test/watch'), null);
});

test('provider response cookies belong to the final response origin after redirects', async () => {
  const { req, jar } = await import(pathToFileURL(path.join(ROOT, 'engine/core/http.js')).href);
  const oldFetch = global.fetch;
  try {
    global.fetch = async () => {
      const res = Response.json({ ok: true }, { headers: { 'set-cookie': 'redirectCookie=yes; Path=/; Secure' } });
      Object.defineProperty(res, 'url', { value: 'https://final.preflight.test/path' });
      return res;
    };
    await req('https://original.preflight.test/start', { retries: 0 });
    assert.equal(jar.headerFor('https://original.preflight.test/path'), null);
    assert.match(jar.headerFor('https://final.preflight.test/path'), /redirectCookie=yes/);
  } finally { global.fetch = oldFetch; }
});

test('provider cookies are not forwarded to another host on redirects', async () => {
  const { req, jar } = await import(pathToFileURL(path.join(ROOT, 'engine/core/http.js')).href);
  let receivedCookie = '';
  const target = http.createServer((request, response) => {
    receivedCookie = request.headers.cookie || '';
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const source = http.createServer((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/land` }).end();
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${source.address().port}/start`;
  jar.set(origin, 'sourceSession=not-for-the-next-host; Path=/');
  try {
    await req(origin, { retries: 0 });
    assert.equal(receivedCookie, '');
  } finally {
    source.closeAllConnections();
    target.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => source.close(resolve)),
      new Promise((resolve) => target.close(resolve)),
    ]);
  }
});

test('torrent episode selection never substitutes an explicitly different episode', async () => {
  const { pickTorrentFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/torrent.js')).href);
  const size = 100 * 1024 * 1024;
  const files = [
    { name: 'Show_S01E01.mkv', length: size },
    { name: 'Show_S01E03.mkv', length: size + 1 },
  ];
  assert.equal(pickTorrentFile(files, { season: 1, episode: 2 }), null);
  const matching = { name: 'Show.S01E01E02.mkv', length: size };
  assert.equal(pickTorrentFile([...files, matching], { season: 1, episode: 2 }), matching);
  assert.equal(pickTorrentFile([...files, matching], { season: 1, episode: 2, fileIdx: 0 }), matching);
  const unknown = { name: 'video.mp4', length: size };
  assert.equal(pickTorrentFile([unknown], { season: 1, episode: 2 }), unknown);
  assert.equal(pickTorrentFile([unknown, { name: 'second.mp4', length: size }], { season: 1, episode: 2 }), null);
  assert.equal(pickTorrentFile([unknown, files[0]], { season: 1, episode: 2, fileIdx: 0 }), unknown);
});

test('episode file labels use explicit ranges, not resolution or unrelated numbers', async () => {
  const { episodeFileLabel } = await import(pathToFileURL(path.join(ROOT, 'engine/core/tv.js')).href);
  const single = { season: 1, first: 2, last: 2 };
  const cases = [
    ['Show.1x02.720p.mkv', single],
    ['Show S01E02 - 720p.mkv', single],
    ['Show - 1x02 - 480p', single],
    ['Show.1x02-1080p.mkv', single],
    ['Show.S01E02 - 2160p.mkv', single],
    ['Show.1x02.03.mkv', single],
    ['Show.S01E02-03.mkv', single], // no second E marker: not an explicit SxxE range
    ['Show.S01E02-E03p.mkv', single],
    ['Show.1x02-03i.mkv', single],
    ['Show.1x02-03K.mkv', single],
    ['Show.S01E02E03.mkv', { season: 1, first: 2, last: 3 }],
    ['Show.S01E02-E03.mkv', { season: 1, first: 2, last: 3 }],
    ['Show S01E02 - E03.mkv', { season: 1, first: 2, last: 3 }],
    ['Show.1x02-03.mkv', { season: 1, first: 2, last: 3 }],
    ['Show.1X02X03.mkv', { season: 1, first: 2, last: 3 }],
    ['Show.1x02 - x03.mkv', { season: 1, first: 2, last: 3 }],
    ['Show.S01E02E52.mkv', { season: 1, first: 2, last: 52 }],
    ['Show.1x02-52.mkv', { season: 1, first: 2, last: 52 }],
    ['Show.S01E02E53.mkv', single], // more than 50 episodes apart
    ['Show.1x02-53.mkv', single],
    ['Show.S01E10E02.mkv', { season: 1, first: 10, last: 10 }],
    ['Show.1x10-02.mkv', { season: 1, first: 10, last: 10 }],
  ];
  for (const [name, expected] of cases) assert.deepEqual(episodeFileLabel(name), expected, name);
});

for (const name of ['Show.1x02.720p.mkv', 'Show S01E02 - 720p.mkv', 'Show - 1x02 - 480p.mkv']) {
  test(`debrid and torrent packs do not mistake ${name} for episode 3`, async () => {
    const { pickEpisodeFile } = await import(pathToFileURL(path.join(ROOT, 'engine/core/tv.js')).href);
    const { pickTorrentFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/torrent.js')).href);
    const wrong = { path: `/Season 1/${name}` };
    const right = { path: '/Season 1/Show.S01E03.720p.mkv' };
    assert.equal(pickEpisodeFile([wrong, right], 1, 3), right);
    assert.equal(pickEpisodeFile([wrong], 1, 3), null);
    assert.equal(pickEpisodeFile([wrong], 1, 2), wrong);

    // The wrong episode is larger and explicitly indexed: neither should make
    // it win over the file whose label actually matches the request.
    const wrongTorrent = { name, length: 120 * 1024 * 1024 };
    const rightTorrent = { name: 'Show.S01E03.720p.mkv', length: 100 * 1024 * 1024 };
    assert.equal(pickTorrentFile([wrongTorrent, rightTorrent], { season: 1, episode: 3 }), rightTorrent);
    assert.equal(pickTorrentFile([wrongTorrent, rightTorrent], { season: 1, episode: 3, fileIdx: 0 }), rightTorrent);
    assert.equal(pickTorrentFile([wrongTorrent], { season: 1, episode: 3 }), null);
    assert.equal(pickTorrentFile([wrongTorrent], { season: 1, episode: 2 }), wrongTorrent);
  });
}

test('explicit multi-episode ranges remain selectable from debrid and torrent packs', async () => {
  const { pickEpisodeFile } = await import(pathToFileURL(path.join(ROOT, 'engine/core/tv.js')).href);
  const { pickTorrentFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/torrent.js')).href);
  for (const name of ['Show.S01E02E03.mkv', 'Show.S01E02-E03.mkv', 'Show.1x02-03.mkv', 'Show.1x02x03.mkv']) {
    const debrid = { path: name };
    const torrent = { name, length: 100 * 1024 * 1024 };
    assert.equal(pickEpisodeFile([debrid], 1, 3), debrid, name);
    assert.equal(pickTorrentFile([torrent], { season: 1, episode: 3 }), torrent, name);
  }
});

test('backwards and implausibly wide ranges only select their first episode in packs', async () => {
  const { pickEpisodeFile } = await import(pathToFileURL(path.join(ROOT, 'engine/core/tv.js')).href);
  const { pickTorrentFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/torrent.js')).href);
  for (const [name, first, requested] of [
    ['Show.S01E02E53.mkv', 2, 3], ['Show.1x02-53.mkv', 2, 3],
    ['Show.S01E02-E720.mkv', 2, 3], ['Show.1x02-720.mkv', 2, 3],
    ['Show.S01E10E02.mkv', 10, 2], ['Show.1x10-02.mkv', 10, 2],
  ]) {
    const rightName = `Show.S01E${String(requested).padStart(2, '0')}.mkv`;
    const wrong = { path: name };
    const right = { path: rightName };
    assert.equal(pickEpisodeFile([wrong, right], 1, requested), right, name);
    assert.equal(pickEpisodeFile([wrong], 1, requested), null, name);
    assert.equal(pickEpisodeFile([wrong], 1, first), wrong, name);

    const wrongTorrent = { name, length: 120 * 1024 * 1024 };
    const rightTorrent = { name: rightName, length: 100 * 1024 * 1024 };
    assert.equal(pickTorrentFile([wrongTorrent, rightTorrent], { season: 1, episode: requested, fileIdx: 0 }), rightTorrent, name);
    assert.equal(pickTorrentFile([wrongTorrent], { season: 1, episode: requested }), null, name);
    assert.equal(pickTorrentFile([wrongTorrent], { season: 1, episode: first }), wrongTorrent, name);
  }
});

for (const padded of [true, false]) {
  test(`native HLS decrypts every sequence with its own IV (${padded ? 'padded' : 'unpadded'} segments)`, async () => {
    const { downloadHlsNative } = await import(pathToFileURL(path.join(ROOT, 'engine/media/hls.js')).href);
    const key = Buffer.alloc(16, 11);
    const sequence = 42;
    const originals = Array.from({ length: 3 }, (_, i) => {
      const data = Buffer.alloc(188 * 88, 0x20 + i); // a multiple of AES's block size
      for (let offset = 0; offset < data.length; offset += 188) data[offset] = 0x47;
      return data;
    });
    const encrypted = originals.map((data, i) => {
      const iv = Buffer.alloc(16);
      iv.writeUInt32BE(sequence + i, 12);
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      cipher.setAutoPadding(padded);
      return Buffer.concat([cipher.update(data), cipher.final()]);
    });
    const server = http.createServer((req, res) => {
      if (req.url === '/key') return res.end(key);
      const match = /^\/seg(\d+)\.ts$/.exec(req.url);
      if (match) return res.end(encrypted[Number(match[1])]);
      res.end(`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:2,\n/seg0.ts\n#EXTINF:2,\n/seg1.ts\n#EXTINF:2,\n/seg2.ts\n#EXT-X-ENDLIST`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const out = await downloadHlsNative(`http://127.0.0.1:${server.address().port}/index.m3u8`, path.join(TMP, `hls-${padded}.ts`));
      assert.deepEqual(fs.readFileSync(out.file), Buffer.concat(originals));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('native HLS rejects unsupported encryption instead of sending ciphertext', async () => {
  const { parseMedia } = await import(pathToFileURL(path.join(ROOT, 'engine/media/hls.js')).href);
  assert.throws(() => parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:2,\nsegment.ts', 'https://example.test/'), /unsupported.*encryption/i);
  assert.throws(() => parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:2,\nsegment.ts', 'https://example.test/'), /key.*URI|missing.*key/i);
  assert.doesNotThrow(() => parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\nsegment.ts', 'https://example.test/'));
});

test('native HLS enforces the size cap while receiving a segment', async () => {
  const { downloadHlsNative } = await import(pathToFileURL(path.join(ROOT, 'engine/media/hls.js')).href);
  const server = http.createServer((req, res) => {
    if (req.url === '/playlist') return res.end('#EXTM3U\n#EXTINF:2,\n/big.ts\n#EXT-X-ENDLIST');
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.write(Buffer.alloc(4096, 1)); // deliberately never end the response
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let timer;
  try {
    await assert.rejects(
      Promise.race([
        downloadHlsNative(`http://127.0.0.1:${server.address().port}/playlist`, path.join(TMP, 'too-large.ts'), { maxBytes: 1024 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('size cap did not stop the response')), 1500); }),
      ]),
      (err) => err.code === 'TOO_BIG',
    );
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('native HLS refuses to silently drop a separate audio rendition', async () => {
  const { downloadHlsNative } = await import(pathToFileURL(path.join(ROOT, 'engine/media/hls.js')).href);
  const segment = Buffer.alloc(188 * 88, 1);
  for (let i = 0; i < segment.length; i += 188) segment[i] = 0x47;
  const server = http.createServer((req, res) => {
    if (req.url === '/master') return res.end([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="/audio"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="audio"',
      '/video',
    ].join('\n'));
    if (req.url === '/video') return res.end('#EXTM3U\n#EXTINF:2,\n/segment\n#EXT-X-ENDLIST');
    return res.end(segment);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      downloadHlsNative(`http://127.0.0.1:${server.address().port}/master`, path.join(TMP, 'silent.ts')),
      /separate audio.*ffmpeg/i,
    );
    assert.equal(fs.existsSync(path.join(TMP, 'silent.ts')), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('native HLS removes partial output if a later segment exceeds the cap', async () => {
  const { downloadHlsNative } = await import(pathToFileURL(path.join(ROOT, 'engine/media/hls.js')).href);
  const segment = Buffer.alloc(188 * 88, 1);
  for (let i = 0; i < segment.length; i += 188) segment[i] = 0x47;
  const server = http.createServer((req, res) => {
    if (req.url === '/playlist') return res.end('#EXTM3U\n#EXTINF:2,\n/one\n#EXTINF:2,\n/two\n#EXT-X-ENDLIST');
    return res.end(segment);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const out = path.join(TMP, 'partial.ts');
  try {
    await assert.rejects(
      downloadHlsNative(`http://127.0.0.1:${server.address().port}/playlist`, out, { maxBytes: 25000 }),
      (err) => err.code === 'TOO_BIG',
    );
    assert.equal(fs.existsSync(out), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ID3 reader handles UTF-16BE without mutating the supplied buffer', () => {
  const { readId3 } = require(path.join(ROOT, 'utils/mediaTransfer'));
  const title = '音楽 title';
  const text = Buffer.from(title, 'utf16le');
  text.swap16();
  const body = Buffer.concat([Buffer.from([2]), text]);
  const frame = Buffer.alloc(10);
  frame.write('TIT2', 0, 'ascii');
  frame.writeUInt32BE(body.length, 4);
  const size = frame.length + body.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, (size >> 7) & 0x7f, size & 0x7f]);
  const input = Buffer.concat([header, frame, body]);
  const original = Buffer.from(input);
  assert.equal(readId3(input).title, title);
  assert.deepEqual(input, original);
});

test('ffmpeg HLS fallback keeps the selected quality with separate audio', { timeout: 30000 }, async (t) => {
  const ffmpeg = require(path.join(ROOT, 'utils/ffmpeg'));
  if (!ffmpeg.works()) return t.skip('ffmpeg unavailable');
  const { probeMedia } = require(path.join(ROOT, 'utils/mediaTransfer'));
  const { hlsToFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/download.js')).href);
  const dir = path.join(TMP, 'hls-ffmpeg-fixture');
  for (const child of ['high', 'low', 'audio']) fs.mkdirSync(path.join(dir, child), { recursive: true });
  for (const [child, size] of [['high', '640x360'], ['low', '320x180']]) {
    execFileSync(ffmpeg(), [
      '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=20:duration=2`,
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
      path.join(dir, child, 'index.m3u8'),
    ]);
  }
  execFileSync(ffmpeg(), [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=523:duration=2',
    '-vn', '-c:a', 'aac', '-b:a', '128k', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
    path.join(dir, 'audio', 'index.m3u8'),
  ]);
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/master') return res.end([
      '#EXTM3U',
      '#EXT-X-MEDIA:GROUP-ID="aud",TYPE=AUDIO,NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="/audio/index.m3u8"',
      '#EXT-X-STREAM-INF:AUDIO="aud",BANDWIDTH=5000000,RESOLUTION=1920x1080',
      '/high/index.m3u8',
      '#EXT-X-STREAM-INF:AUDIO="aud",BANDWIDTH=2000000,RESOLUTION=1280x720',
      '/low/index.m3u8',
    ].join('\n'));
    const file = path.join(dir, req.url.replace(/^\/+/, ''));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return fs.createReadStream(file).pipe(res);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const oldMode = process.env.MOVIE_HLS_ENGINE;
  process.env.MOVIE_HLS_ENGINE = 'ffmpeg';
  try {
    const result = await hlsToFile(`http://127.0.0.1:${server.address().port}/master`, path.join(dir, 'result.mp4'), null, { maxHeight: 720 });
    assert.equal(result.engine, 'ffmpeg');
    assert.ok(hits.some((hit) => hit.startsWith('/low/')), `720p variant missing: ${hits}`);
    assert.ok(hits.some((hit) => hit.startsWith('/audio/')), `audio missing: ${hits}`);
    assert.ok(!hits.some((hit) => hit.startsWith('/high/')), `higher variant was downloaded: ${hits}`);
    const media = await probeMedia(result.file);
    assert.equal(media.hasVideo, true);
    assert.equal(media.hasAudio, true);
  } finally {
    if (oldMode === undefined) delete process.env.MOVIE_HLS_ENGINE;
    else process.env.MOVIE_HLS_ENGINE = oldMode;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('movie verification and HTTP downloads agree at the configured byte boundary', async () => {
  const { verify } = await import(pathToFileURL(path.join(ROOT, 'engine/core/verify.js')).href);
  const { httpToFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/download.js')).href);
  const mb = 1024 * 1024;
  const cap = Math.round(1.2 * mb);
  const sizes = { below: cap - 1, at: cap, above: cap + 1, between: Math.ceil(1.3 * mb) };
  const payload = Buffer.alloc(sizes.between, 7);
  payload.write('ftyp', 4, 'ascii');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/unknown') {
      if (req.method === 'HEAD') return res.writeHead(200, { 'Content-Type': 'video/mp4' }).end();
      return res.writeHead(200, { 'Content-Type': 'video/mp4', 'Transfer-Encoding': 'chunked' }).end(payload.subarray(0, 512));
    }
    const size = sizes[req.url.slice(1)];
    if (!size) return res.writeHead(404).end();
    if (req.headers.range) {
      return res.writeHead(206, {
        'Content-Type': 'video/mp4', 'Content-Length': 512, 'Content-Range': `bytes 0-511/${size}`,
      }).end(payload.subarray(0, 512));
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
    return res.end(req.method === 'HEAD' ? undefined : payload.subarray(0, size));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const label of ['below', 'at']) {
      const result = await verify({ url: `${base}/${label}` });
      assert.equal(result.verified, true, label);
      assert.equal(result.sizeMB * mb, sizes[label], label);
      const dest = path.join(TMP, `cap-${label}.mp4`);
      assert.equal((await httpToFile(`${base}/${label}`, dest)).bytes, sizes[label], label);
      assert.equal(fs.statSync(dest).size, sizes[label], label);
    }
    for (const label of ['above', 'between']) {
      const before = requests.length;
      await assert.rejects(verify({ url: `${base}/${label}` }), /too big/i);
      assert.deepEqual(requests.slice(before), [`HEAD /${label}`], 'reject known oversized files before sniffing');
      const dest = path.join(TMP, `cap-${label}.mp4`);
      await assert.rejects(httpToFile(`${base}/${label}`, dest), (err) => err.code === 'TOO_BIG');
      assert.equal(fs.existsSync(dest), false);
    }
    // With no Content-Length or Content-Range, the same rule applies to a
    // provider's candidate size rather than just the HTTP probe.
    assert.equal((await verify({ url: `${base}/unknown`, sizeMB: cap / mb })).verified, true);
    await assert.rejects(verify({ url: `${base}/unknown`, sizeMB: (cap + 1) / mb }), /too big/i);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('native HLS uses the same byte boundary as HTTP downloads', async () => {
  const { hlsToFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/download.js')).href);
  const cap = Math.round(1.2 * 1024 * 1024);
  const sizes = { below: cap - 1, at: cap, above: cap + 1, between: Math.ceil(1.3 * 1024 * 1024) };
  const payload = Buffer.alloc(sizes.between, 7);
  payload[0] = payload[188] = 0x47;
  const server = http.createServer((req, res) => {
    const [kind, label] = req.url.slice(1).split('/');
    if (!sizes[label]) return res.writeHead(404).end();
    if (kind === 'playlist') return res.end(`#EXTM3U\n#EXTINF:2,\n/segment/${label}\n#EXT-X-ENDLIST`);
    if (kind === 'segment') return res.writeHead(200, { 'Content-Length': sizes[label] }).end(payload.subarray(0, sizes[label]));
    return res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const oldMode = process.env.MOVIE_HLS_ENGINE;
  process.env.MOVIE_HLS_ENGINE = 'native';
  try {
    for (const label of ['below', 'at']) {
      const dest = path.join(TMP, `hls-cap-${label}.mp4`);
      const result = await hlsToFile(`http://127.0.0.1:${server.address().port}/playlist/${label}`, dest);
      assert.equal(result.engine, 'native');
      assert.equal(result.bytes, sizes[label], label);
      assert.equal(fs.statSync(result.file).size, sizes[label], label);
    }
    for (const label of ['above', 'between']) {
      const dest = path.join(TMP, `hls-cap-${label}.mp4`);
      await assert.rejects(hlsToFile(`http://127.0.0.1:${server.address().port}/playlist/${label}`, dest), (err) => err.code === 'TOO_BIG');
      assert.equal(fs.existsSync(dest), false);
      assert.equal(fs.existsSync(dest.replace(/\.mp4$/, '.ts')), false);
    }
  } finally {
    if (oldMode === undefined) delete process.env.MOVIE_HLS_ENGINE;
    else process.env.MOVIE_HLS_ENGINE = oldMode;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('verification and HTTP downloads round a fractional byte cap identically', () => {
  // A fresh process can use 1.3 MB without changing the other preflight tests.
  // Here the 1.2x cap rounds UP, so a float-only verifier would reject the
  // exact last byte that the downloader allows.
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import config from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'engine/config.js')).href)};
    import { verify } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'engine/core/verify.js')).href)};
    import { httpToFile } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'engine/media/download.js')).href)};
    const mb = 1024 * 1024;
    const cap = Math.round(1.3 * 1.2 * mb);
    assert.ok(cap > 1.3 * 1.2 * mb);
    assert.equal(config.downloadCapFactor, 1.2);
    const payload = Buffer.alloc(cap + 1, 7);
    payload.write('ftyp', 4, 'ascii');
    globalThis.fetch = async (url, options = {}) => {
      const size = String(url).endsWith('/at') ? cap : cap + 1;
      return new Response(options.method === 'HEAD' ? null : payload.subarray(0, size), {
        headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
      });
    };
    const at = ${JSON.stringify(path.join(TMP, 'fraction-at.mp4'))};
    const above = ${JSON.stringify(path.join(TMP, 'fraction-above.mp4'))};
    assert.equal((await verify({ url: 'http://fixture/at' })).verified, true);
    assert.equal((await httpToFile('http://fixture/at', at)).bytes, cap);
    await assert.rejects(verify({ url: 'http://fixture/above' }), /too big/i);
    await assert.rejects(httpToFile('http://fixture/above', above), (err) => err.code === 'TOO_BIG');
    assert.equal(fs.existsSync(above), false);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MAX_DOWNLOAD_MB: '1.3', MIN_SAMPLE_MB: '0' },
    timeout: 10000,
  });
});

for (const chunked of [false, true]) {
  test(`movie HTTP downloader enforces its cap for ${chunked ? 'unknown' : 'known'} response size`, async () => {
    const { httpToFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/download.js')).href);
    let requests = 0;
    const payload = Buffer.alloc(2 * 1024 * 1024, 7);
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': payload.length }),
      });
      res.end(payload);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dest = path.join(TMP, `oversize-${chunked}.mp4`);
    try {
      await assert.rejects(
        httpToFile(`http://127.0.0.1:${server.address().port}/video`, dest),
        (err) => err.code === 'TOO_BIG',
      );
      assert.equal(requests, 1, 'oversized downloads must not retry via another engine');
      assert.equal(fs.existsSync(dest), false);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dest, { force: true });
    }
  });
}

test('movie HTTP cancellation stops immediately without retry or fallback', async () => {
  const { httpToFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/download.js')).href);
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(Buffer.alloc(20000, 8));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dest = path.join(TMP, 'cancelled.mp4');
  try {
    await assert.rejects(
      httpToFile(`http://127.0.0.1:${server.address().port}/video`, dest, { onAbort: () => true }),
      (err) => err.code === 'ABORTED',
    );
    assert.equal(requests, 1);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dest, { force: true });
  }
});

test('debrid episode selection refuses a pack containing only other episodes', async () => {
  const { pickEpisodeFile } = await import(pathToFileURL(path.join(ROOT, 'engine/core/tv.js')).href);
  const other = [{ path: '/Show_S01E01.mkv' }, { path: '/Show_S01E03.mkv' }];
  assert.equal(pickEpisodeFile(other, 1, 2), null);
  const match = { path: '/Show.S01E01E02.mkv' };
  assert.equal(pickEpisodeFile([...other, match], 1, 2), match);
  assert.equal(pickEpisodeFile([{ path: '/single-unlabelled.mkv' }], 1, 2)?.path, '/single-unlabelled.mkv');
  assert.equal(pickEpisodeFile([{ path: '/unknown-a.mkv' }, { path: '/unknown-b.mkv' }], 1, 2), null);
});

test('AllDebrid resolves a selected episode from the current nested files API', async (t) => {
  const realTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => realTimeout(fn, ms === 3000 ? 0 : ms, ...args));
  const { resolve } = await import(pathToFileURL(path.join(ROOT, 'engine/providers/debrid/alldebrid.js')).href);
  const { pickEpisodeFile } = await import(pathToFileURL(path.join(ROOT, 'engine/core/tv.js')).href);
  const calls = [];
  t.mock.method(global, 'fetch', async (url, opts = {}) => {
    const parsed = new URL(url);
    const body = new URLSearchParams(opts.body || '');
    calls.push({ path: parsed.pathname, method: opts.method, body });
    let data;
    if (parsed.pathname === '/v4/magnet/upload') data = { magnets: [{ id: 123, ready: true }] };
    else if (parsed.pathname === '/v4/magnet/files') data = { magnets: [{ id: '123', files: [
      { n: 'Season 1', e: [
        { n: 'Show.S01E01.mkv', s: 1000000, l: 'https://alldebrid.example/episode1' },
        { n: 'Show.S01E02.mkv', s: 2000000, l: 'https://alldebrid.example/episode2' },
      ] },
    ] }] };
    else if (parsed.pathname === '/v4/link/unlock') data = { link: 'https://cdn.example/episode2', filesize: 2000000 };
    else throw new Error(`unexpected AllDebrid endpoint ${parsed.pathname}`);
    return new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
  });
  const result = await resolve({ magnet: 'magnet:?xt=urn:btih:example' }, { pickEpisode: (files) => pickEpisodeFile(files, 1, 2) });
  assert.equal(result.url, 'https://cdn.example/episode2');
  assert.equal(result.filename, 'Season 1/Show.S01E02.mkv');
  assert.equal(calls[0].body.get('magnets[]'), 'magnet:?xt=urn:btih:example');
  assert.equal(calls.find((x) => x.path === '/v4/magnet/files').body.get('id[]'), '123');
  assert.equal(calls.find((x) => x.path === '/v4/link/unlock').body.get('link'), 'https://alldebrid.example/episode2');
  assert.ok(calls.every((x) => x.method === 'POST'));
});

test('AllDebrid fails on a magnet error instead of treating it as ready', async (t) => {
  const realTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => realTimeout(fn, ms === 3000 ? 0 : ms, ...args));
  const { resolve } = await import(pathToFileURL(path.join(ROOT, 'engine/providers/debrid/alldebrid.js')).href);
  t.mock.method(global, 'fetch', async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/v4/magnet/upload') return new Response(JSON.stringify({ status: 'success', data: { magnets: [{ id: 123, ready: false }] } }));
    if (pathname === '/v4.1/magnet/status') return new Response(JSON.stringify({ status: 'success', data: { magnets: [{ id: 123, statusCode: 5, status: 'Upload failed' }] } }));
    throw new Error(`unexpected AllDebrid endpoint ${pathname}`);
  });
  await assert.rejects(resolve({ magnet: 'magnet:?xt=urn:btih:example' }, {}), /Upload failed/);
});

test('Real-Debrid never substitutes the first link for a missing episode link', async (t) => {
  const realTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => realTimeout(fn, ms === 3000 ? 0 : ms, ...args));
  const { resolve } = await import(pathToFileURL(path.join(ROOT, 'engine/providers/debrid/realdebrid.js')).href);
  let unlocked = false;
  t.mock.method(global, 'fetch', async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/addMagnet')) return new Response(JSON.stringify({ id: '123' }));
    if (pathname.includes('/selectFiles/')) return new Response('{}');
    if (pathname.includes('/info/')) return new Response(JSON.stringify({
      status: 'downloaded',
      files: [
        { path: '/Show.S01E01.mkv', selected: 1, bytes: 1 },
        { path: '/Show.S01E02.mkv', selected: 1, bytes: 2 },
      ],
      links: ['https://example.com/episode1'],
    }));
    if (pathname.endsWith('/unrestrict/link')) { unlocked = true; return new Response(JSON.stringify({ download: 'https://cdn.example/wrong' })); }
    throw new Error(`unexpected Real-Debrid endpoint ${pathname}`);
  });
  await assert.rejects(resolve({ magnet: 'magnet:?xt=urn:btih:example' }, { pickEpisode: (files) => files[1] }), /no link/);
  assert.equal(unlocked, false);
});

test('AllDebrid polls current magnet status and resolves delayed links', async (t) => {
  const realTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => realTimeout(fn, ms === 3000 || ms === 5000 ? 0 : ms, ...args));
  const { resolve } = await import(pathToFileURL(path.join(ROOT, 'engine/providers/debrid/alldebrid.js')).href);
  const calls = [];
  let statuses = 0, delayed = 0;
  t.mock.method(global, 'fetch', async (url, opts) => {
    const pathname = new URL(url).pathname;
    const params = new URLSearchParams(opts.body);
    calls.push({ pathname, params });
    let data;
    if (pathname === '/v4/magnet/upload') data = { magnets: [{ id: 456, ready: false }] };
    else if (pathname === '/v4.1/magnet/status') {
      statuses += 1;
      data = { magnets: [{ id: 456, statusCode: statuses === 1 ? 1 : 4 }] };
    } else if (pathname === '/v4/magnet/files') data = { magnets: [{ id: 456, files: [
      { n: 'Film.mkv', s: 2000000, l: 'https://alldebrid.example/film' },
    ] }] };
    else if (pathname === '/v4/link/unlock') data = { delayed: 789, filesize: 2000000 };
    else if (pathname === '/v4/link/delayed') {
      delayed += 1;
      data = delayed === 1 ? { status: 1, time_left: 5 } : { status: 2, link: 'https://cdn.example/film' };
    } else throw new Error(`unexpected endpoint ${pathname}`);
    return Response.json({ status: 'success', data });
  });
  const result = await resolve({ magnet: 'magnet:?xt=urn:btih:example' });
  assert.equal(result.url, 'https://cdn.example/film');
  assert.equal(statuses, 2);
  assert.equal(delayed, 2);
  assert.equal(calls.find((x) => x.pathname === '/v4.1/magnet/status').params.get('id'), '456');
  assert.equal(calls.find((x) => x.pathname === '/v4/link/delayed').params.get('id'), '789');
});

test('AllDebrid stops polling when its caller cancels', async (t) => {
  const { resolve } = await import(pathToFileURL(path.join(ROOT, 'engine/providers/debrid/alldebrid.js')).href);
  const controller = new AbortController();
  t.mock.method(global, 'fetch', async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/v4/magnet/upload') return Response.json({ status: 'success', data: { magnets: [{ id: 456, ready: false }] } });
    if (pathname === '/v4.1/magnet/status') {
      queueMicrotask(() => controller.abort(new Error('cancelled by test')));
      return Response.json({ status: 'success', data: { magnets: [{ id: 456, statusCode: 1 }] } });
    }
    throw new Error(`unexpected endpoint ${pathname}`);
  });
  await assert.rejects(resolve({ magnet: 'magnet:?xt=urn:btih:example' }, { signal: controller.signal }), /cancelled by test/);
});

test('Real-Debrid stops polling when its caller cancels', async (t) => {
  const realTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => realTimeout(fn, ms === 3000 ? 0 : ms, ...args));
  const { resolve } = await import(pathToFileURL(path.join(ROOT, 'engine/providers/debrid/realdebrid.js')).href);
  const controller = new AbortController();
  t.mock.method(global, 'fetch', async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/addMagnet')) return Response.json({ id: '123' });
    if (pathname.includes('/selectFiles/')) { controller.abort(new Error('cancelled by test')); return new Response(null, { status: 204 }); }
    if (pathname.includes('/info/')) return Response.json({ status: 'downloading' });
    throw new Error(`unexpected endpoint ${pathname}`);
  });
  await assert.rejects(resolve({ magnet: 'magnet:?xt=urn:btih:example' }, { signal: controller.signal }), /cancelled by test/);
});

test('debrid cache isolates different magnets without an explicit info hash', async (t) => {
  const debrid = await import(pathToFileURL(path.join(ROOT, 'engine/providers/debrid/index.js')).href);
  const { default: alldebrid } = await import(pathToFileURL(path.join(ROOT, 'engine/providers/debrid/alldebrid.js')).href);
  let calls = 0;
  t.mock.method(alldebrid, 'resolve', async (candidate) => { calls += 1; return { url: `https://cdn.example/${candidate.magnet.slice(-1)}` }; });
  const a = { provider: 'same-provider', magnet: 'magnet:?xt=urn:btih:A' };
  const b = { provider: 'same-provider', magnet: 'magnet:?xt=urn:btih:B' };
  assert.equal((await debrid.resolve(a, {})).url, 'https://cdn.example/A');
  assert.equal((await debrid.resolve(b, {})).url, 'https://cdn.example/B');
  assert.equal((await debrid.resolve(a, {})).url, 'https://cdn.example/A');
  assert.equal(calls, 2);
});

test('metadata search limits do not poison later larger IMDb and Jikan searches', async (t) => {
  const imdb = await import(pathToFileURL(path.join(ROOT, 'engine/metadata/imdb.js')).href);
  const jikan = await import(pathToFileURL(path.join(ROOT, 'engine/metadata/jikan.js')).href);
  let imdbCalls = 0, jikanCalls = 0;
  t.mock.method(global, 'fetch', async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname.includes('imdb')) {
      imdbCalls += 1;
      return Response.json({ d: Array.from({ length: 8 }, (_, i) => ({ id: `tt12345${i}`, l: `Audit IMDb ${i}`, qid: 'movie' })) });
    }
    if (parsed.hostname.includes('jikan')) {
      jikanCalls += 1;
      const limit = Number(parsed.searchParams.get('limit'));
      return Response.json({ data: Array.from({ length: limit }, (_, i) => ({ mal_id: i + 1, title: `Audit Anime ${i}` })) });
    }
    throw new Error(`unexpected metadata host ${parsed.hostname}`);
  });
  assert.equal((await imdb.suggest('Preflight IMDb Unique', { limit: 2 })).length, 2);
  assert.equal((await imdb.suggest('Preflight IMDb Unique', { limit: 8 })).length, 8);
  assert.equal((await imdb.suggest('Preflight IMDb Unique', { limit: 1 })).length, 1);
  assert.equal(imdbCalls, 1);
  assert.equal((await jikan.search('Preflight Anime Unique', { limit: 2 })).length, 2);
  assert.equal((await jikan.search('Preflight Anime Unique', { limit: 8 })).length, 8);
  assert.equal(jikanCalls, 2);
});

test('native HLS resolves relative playlists after redirects', async () => {
  const { downloadHlsNative } = await import(pathToFileURL(path.join(ROOT, 'engine/media/hls.js')).href);
  const segment = Buffer.alloc(188 * 88, 1);
  for (let i = 0; i < segment.length; i += 188) segment[i] = 0x47;
  const server = http.createServer((req, res) => {
    if (req.url === '/start') return res.writeHead(302, { location: '/nested/master' }).end();
    if (req.url === '/nested/master') return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=640x360\nvariant\n');
    if (req.url === '/nested/variant') return res.writeHead(302, { location: '/actual/media' }).end();
    if (req.url === '/actual/media') return res.end('#EXTM3U\n#EXTINF:2,\nsegment\n#EXT-X-ENDLIST');
    if (req.url === '/actual/segment') return res.end(segment);
    return res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const out = await downloadHlsNative(`http://127.0.0.1:${server.address().port}/start`, path.join(TMP, 'redirect.ts'));
    assert.deepEqual(fs.readFileSync(out.file), segment);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('native HLS decrypts an explicitly encrypted initialization map', async () => {
  const { downloadHlsNative } = await import(pathToFileURL(path.join(ROOT, 'engine/media/hls.js')).href);
  const key = Buffer.alloc(16, 4);
  const iv = Buffer.alloc(16, 5);
  const init = Buffer.alloc(12000, 7);
  init.write('ftyp', 4, 'ascii');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encryptedInit = Buffer.concat([cipher.update(init), cipher.final()]);
  const segment = Buffer.alloc(12000, 8);
  const server = http.createServer((req, res) => {
    if (req.url === '/key') return res.end(key);
    if (req.url === '/init') return res.end(encryptedInit);
    if (req.url === '/segment') return res.end(segment);
    return res.end(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key",IV=0x${iv.toString('hex')}\n#EXT-X-MAP:URI="/init"\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\n/segment\n#EXT-X-ENDLIST`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const out = await downloadHlsNative(`http://127.0.0.1:${server.address().port}/playlist`, path.join(TMP, 'init.mp4'));
    assert.equal(Buffer.compare(fs.readFileSync(out.file), Buffer.concat([init, segment])), 0, 'decrypted initialization map differs');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('native HLS rejects unsupported byte ranges and changing initialization maps', async () => {
  const { parseMedia } = await import(pathToFileURL(path.join(ROOT, 'engine/media/hls.js')).href);
  assert.throws(() => parseMedia('#EXTM3U\n#EXT-X-BYTERANGE:500@0\nsegment.mp4', 'https://example.test/'), /byte.range/i);
  assert.throws(() => parseMedia('#EXTM3U\n#EXT-X-MAP:URI="init",BYTERANGE="500@0"\nsegment.mp4', 'https://example.test/'), /byte.range/i);
  assert.throws(() => parseMedia('#EXTM3U\n#EXT-X-MAP:URI="init1"\nsegment1\n#EXT-X-MAP:URI="init2"\nsegment2', 'https://example.test/'), /initialization|map/i);
});

test('HLS playlists are bounded even when response size is unknown', async () => {
  const { downloadHlsNative } = await import(pathToFileURL(path.join(ROOT, 'engine/media/hls.js')).href);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Transfer-Encoding': 'chunked' });
    res.write('#EXTM3U\n');
    res.write(Buffer.alloc(5 * 1024 * 1024, 35)); // no Content-Length and never ends
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let timer;
  try {
    await assert.rejects(Promise.race([
      downloadHlsNative(`http://127.0.0.1:${server.address().port}/playlist`, path.join(TMP, 'huge-playlist.mp4')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('playlist read was unbounded')), 1500); }),
    ]), (err) => err.code === 'TOO_BIG');
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ffmpeg HLS enforces the output cap even if it finishes before its watchdog', { timeout: 30000 }, async (t) => {
  const ffmpeg = require(path.join(ROOT, 'utils/ffmpeg'));
  if (!ffmpeg.works()) return t.skip('ffmpeg unavailable');
  const { hlsToFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/download.js')).href);
  const dir = path.join(TMP, 'hls-fast-cap');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(ffmpeg(), [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4',
    '-an', '-c:v', 'mpeg2video', '-b:v', '4M', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    path.join(dir, 'index.m3u8'),
  ]);
  const total = fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  assert.ok(total > 1.2 * 1024 * 1024, `fixture is too small: ${total}`);
  const server = http.createServer((req, res) => {
    const file = path.join(dir, req.url.replace(/^\/+/, ''));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return fs.createReadStream(file).pipe(res);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const oldMode = process.env.MOVIE_HLS_ENGINE;
  process.env.MOVIE_HLS_ENGINE = 'ffmpeg';
  const dest = path.join(dir, 'too-large.mp4');
  try {
    await assert.rejects(hlsToFile(`http://127.0.0.1:${server.address().port}/index.m3u8`, dest), (err) => err.code === 'TOO_BIG');
    assert.equal(fs.existsSync(dest), false);
  } finally {
    if (oldMode === undefined) delete process.env.MOVIE_HLS_ENGINE;
    else process.env.MOVIE_HLS_ENGINE = oldMode;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('native HLS cancellation stops an in-flight segment and removes partial output', async () => {
  const { hlsToFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/download.js')).href);
  let started;
  const segmentStarted = new Promise((resolve) => { started = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url === '/playlist') return res.end('#EXTM3U\n#EXTINF:2,\n/segment\n#EXT-X-ENDLIST');
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.write(Buffer.alloc(12000, 4));
    started();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const oldMode = process.env.MOVIE_HLS_ENGINE;
  process.env.MOVIE_HLS_ENGINE = 'native';
  const dest = path.join(TMP, 'cancelled-hls.mp4');
  let cancel = false, timer;
  try {
    const task = hlsToFile(`http://127.0.0.1:${server.address().port}/playlist`, dest, null, { onAbort: () => cancel });
    await segmentStarted;
    cancel = true;
    await assert.rejects(Promise.race([
      task,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HLS cancellation did not stop the response')), 1800); }),
    ]), (err) => err.code === 'ABORTED');
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(dest.replace(/\.mp4$/, '.ts')), false);
  } finally {
    clearTimeout(timer);
    if (oldMode === undefined) delete process.env.MOVIE_HLS_ENGINE;
    else process.env.MOVIE_HLS_ENGINE = oldMode;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function id3Fixture(encoding, raw, frameSize = raw.length + 1, declaredTagSize = 10 + raw.length + 1) {
  const frame = Buffer.alloc(10);
  frame.write('TIT2', 0, 'ascii');
  frame.writeUInt32BE(frameSize, 4);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0,
    (declaredTagSize >> 21) & 0x7f, (declaredTagSize >> 14) & 0x7f,
    (declaredTagSize >> 7) & 0x7f, declaredTagSize & 0x7f]);
  return Buffer.concat([header, frame, Buffer.from([encoding]), raw]);
}

test('ID3 reader supports BOM byte order, Latin-1 and truncated frames', (t) => {
  const { readId3 } = require(path.join(ROOT, 'utils/mediaTransfer'));
  const le = Buffer.from('Music é', 'utf16le');
  const be = Buffer.from(le).swap16();
  assert.equal(readId3(id3Fixture(1, Buffer.concat([Buffer.from([0xff, 0xfe]), le]))).title, 'Music é');
  assert.equal(readId3(id3Fixture(1, Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).title, 'Music é');
  assert.equal(readId3(id3Fixture(0, Buffer.from('Café', 'latin1'))).title, 'Café');
  assert.equal(readId3(id3Fixture(2, Buffer.concat([be, Buffer.from([0x12])]))).title, 'Music é');
  // Audio bytes following a shorter declared tag are not part of the frame.
  assert.equal(readId3(id3Fixture(0, Buffer.from('NOT TAG'), 8, 11)), null);

  const file = path.join(TMP, 'tagged-large.mp3');
  fs.writeFileSync(file, Buffer.concat([id3Fixture(0, Buffer.from('Café', 'latin1')), Buffer.alloc(2 * 1024 * 1024)]));
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (name, ...args) => {
    if (name === file) throw new Error('must not read the entire audio file');
    return originalRead.call(fs, name, ...args);
  });
  assert.equal(readId3(file).title, 'Café');
});

test('shared streaming downloader removes partial files after exceeding its cap', async () => {
  const { downloadToFile } = require(path.join(ROOT, 'utils/mediaTransfer'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked' });
    res.end(Buffer.alloc(200000, 4));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dest = path.join(TMP, 'shared-too-large.mp3');
  try {
    await assert.rejects(downloadToFile(`http://127.0.0.1:${server.address().port}/audio`, dest, { maxBytes: 10000 }), (err) => err.code === 'TOO_BIG');
    assert.equal(fs.existsSync(dest), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dest, { force: true });
  }
});

test('old Node runtimes fail at startup with panel-friendly guidance', () => {
  const { spawnSync } = require('node:child_process');
  const script = `Object.defineProperty(process.versions,'node',{value:'20.19.5'}); require(${JSON.stringify(path.join(ROOT, 'index.js'))});`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node\.js 20\.19\.5 is too old.*22\.13/);
});

test('AVIF is labeled with its real image MIME type', () => {
  const { sniff } = require(path.join(ROOT, 'utils/mediaTransfer'));
  const avif = Buffer.alloc(32);
  avif.write('ftyp', 4);
  avif.write('avif', 8);
  assert.deepEqual(sniff(avif), { kind: 'image', ext: 'avif', mime: 'image/avif' });
});

for (const mode of ['valid-range', 'stale-416', 'wrong-offset']) {
  test(`movie HTTP resume handles ${mode} without corrupting the output`, async () => {
    const { httpToFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/download.js')).href);
    const data = Buffer.alloc(24000, 3);
    const dest = path.join(TMP, `resume-${mode}.mp4`);
    fs.writeFileSync(dest, mode === 'stale-416' ? Buffer.alloc(30000, 8) : data.subarray(0, 500));
    const ranges = [];
    const server = http.createServer((req, res) => {
      ranges.push(req.headers.range || null);
      if (!req.headers.range) return res.writeHead(200, { 'Content-Length': data.length }).end(data);
      if (mode === 'stale-416') return res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end();
      if (mode === 'wrong-offset') return res.writeHead(206, { 'Content-Range': `bytes 0-9/${data.length}` }).end(data.subarray(0, 10));
      return res.writeHead(206, { 'Content-Range': `bytes 500-${data.length - 1}/${data.length}`, 'Content-Length': data.length - 500 }).end(data.subarray(500));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await httpToFile(`http://127.0.0.1:${server.address().port}/video`, dest);
      assert.equal(result.bytes, data.length);
      assert.equal(Buffer.compare(fs.readFileSync(dest), data), 0);
      assert.deepEqual(ranges, mode === 'valid-range' ? ['bytes=500-'] : [mode === 'stale-416' ? 'bytes=30000-' : 'bytes=500-', null]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('movie HTTP fallback respects cancellation during an in-flight response', async () => {
  const { httpToFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/download.js')).href);
  let started, requests = 0;
  const fallbackStarted = new Promise((resolve) => { started = resolve; });
  const server = http.createServer((_req, res) => {
    requests += 1;
    if (requests === 1) return res.writeHead(503).end();
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Transfer-Encoding': 'chunked' });
    res.write(Buffer.alloc(20000, 4));
    started();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dest = path.join(TMP, 'cancelled-fallback.mp4');
  let cancel = false, timer;
  try {
    const task = httpToFile(`http://127.0.0.1:${server.address().port}/video`, dest, { onAbort: () => cancel });
    await fallbackStarted;
    cancel = true;
    await assert.rejects(Promise.race([
      task,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fallback did not cancel')), 1800); }),
    ]), (err) => err.code === 'ABORTED');
    assert.equal(requests, 2);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dest, { force: true });
  }
});

test('console and bot/engine loggers redact nested credentials and error metadata', async () => {
  const util = require('node:util');
  const { redactArg, safeText } = botRequire('../utils/safeLog');
  const payload = {
    note: 'visible detail',
    apiKey: 'dummy-api-secret',
    headers: { Authorization: 'Basic ZHVtbXk6c2VjcmV0', 'X-Bot-Token': 'dummy-bot-secret', Cookie: 'sid=dummy-cookie' },
    nested: { refresh_token: 'dummy-refresh-secret' },
  };
  payload.self = payload;
  const err = new Error('Remote request failed');
  err.config = payload;
  const captured = [util.inspect(redactArg(payload), { depth: 8 }), util.inspect(redactArg(err), { depth: 8 }), safeText(payload)];
  const originalLog = console.log;
  try {
    console.log = (...args) => captured.push(util.format(...args));
    botRequire('../utils/logger')('security-test').info(payload);
    const { log } = await import(pathToFileURL(path.join(ROOT, 'engine/core/log.js')).href);
    log.child('security-test').info(payload);
  } finally { console.log = originalLog; }
  const output = captured.join('\n');
  for (const secret of ['dummy-api-secret', 'ZHVtbXk6c2VjcmV0', 'dummy-bot-secret', 'dummy-cookie', 'dummy-refresh-secret']) {
    assert.equal(output.includes(secret), false, `log leaked ${secret}`);
  }
  assert.match(output, /visible detail/);
});

test('logger runtime levels and section headers work', () => {
  const logger = botRequire('../utils/logger');
  const before = process.env.LOG_LEVEL;
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    logger.setLevel('error');
    logger('test').info('should be hidden');
    logger.setLevel('debug');
    logger('test').debug('debug is visible');
    logger.section('test', 'section is visible');
  } finally {
    logger.setLevel(before || 'info');
    if (before === undefined) delete process.env.LOG_LEVEL;
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(lines.some((line) => line.includes('should be hidden')), false);
  assert.ok(lines.some((line) => line.includes('debug is visible')));
  assert.ok(lines.some((line) => line.includes('section is visible')));
});

test('updated YouTube search dependencies retain their CommonJS and glob interfaces', async () => {
  assert.equal(typeof require('yt-search'), 'function');
  const glob = require('redstar');
  const dir = fs.mkdtempSync(path.join(TMP, 'search-glob-'));
  fs.writeFileSync(path.join(dir, 'included.js'), '');
  fs.writeFileSync(path.join(dir, 'excluded.txt'), '');
  const files = await new Promise((resolve, reject) => glob(path.join(dir, '*.js'), (err, found) => err ? reject(err) : resolve(found)));
  assert.deepEqual(files.map((file) => path.basename(file)), ['included.js']);
});

test('offline bot fixture copies source without copying private runtime data', () => {
  const { createBotFixture } = require('./test-sandbox');
  const source = path.join(TMP, 'fixture-source'); const parent = path.join(TMP, 'fixture-parent');
  for (const dir of ['commands', 'engine', 'utils', 'scripts', 'database', 'session', 'secrets']) fs.mkdirSync(path.join(source, dir), { recursive: true });
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(source, 'package.json'), '{}');
  fs.writeFileSync(path.join(source, 'utils', 'safe.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(source, 'utils', 'creds.json'), 'PRIVATE');
  fs.writeFileSync(path.join(source, 'database', 'whitelist.json'), 'PRIVATE');
  fs.writeFileSync(path.join(source, 'session', 'creds.json'), 'PRIVATE');
  fs.writeFileSync(path.join(source, 'secrets', 'rclone.conf'), 'PRIVATE');
  fs.writeFileSync(path.join(source, '.env'), 'PRIVATE');
  const root = createBotFixture(parent, source);
  assert.equal(fs.readFileSync(path.join(root, 'utils', 'safe.js'), 'utf8'), 'module.exports = 1;');
  for (const relative of ['.env', 'utils/creds.json', 'database/whitelist.json', 'session/creds.json', 'secrets/rclone.conf']) {
    assert.equal(fs.existsSync(path.join(root, relative)), false, `${relative} must not enter test fixture`);
    assert.equal(fs.readFileSync(path.join(source, relative), 'utf8'), 'PRIVATE', `${relative} must stay untouched`);
  }
});

test('redacted error logs retain safe aggregate causes and statuses without request metadata', () => {
  const util = require('node:util');
  const { redactArg, safeText } = botRequire('../utils/safeLog');
  const leaf = Object.assign(new Error('disk denied token=secret-cause-fixture'), {
    code: 'EACCES', status: 403, statusCode: 503,
    config: { headers: { Authorization: 'Bearer secret-request-fixture' }, password: 'secret-password-fixture' },
  });
  const objectCause = { message: 'filesystem refused token=secret-object-fixture', code: 'EIO', statusCode: 507, request: { password: 'secret-object-request' } };
  objectCause.cause = objectCause;
  leaf.cause = objectCause;
  const wrapped = new Error('backup shutdown failed', { cause: leaf });
  const circular = new Error('self-referencing'); circular.cause = circular;
  const aggregate = new AggregateError([wrapped, circular], 'services did not stop');
  const sanitized = redactArg(aggregate);
  assert.ok(sanitized instanceof AggregateError);
  assert.equal(sanitized.errors[0].message, 'backup shutdown failed');
  assert.equal(sanitized.errors[0].cause.code, 'EACCES');
  assert.equal(sanitized.errors[0].cause.status, 403);
  assert.equal(sanitized.errors[0].cause.statusCode, 503);
  assert.equal(sanitized.errors[0].cause.config, undefined, 'arbitrary request metadata must not be copied');
  assert.equal(sanitized.errors[0].cause.cause.code, 'EIO');
  assert.equal(sanitized.errors[0].cause.cause.statusCode, 507);
  assert.equal(sanitized.errors[0].cause.cause.request, undefined);
  assert.match(String(sanitized.errors[0].cause.cause.cause), /circular/i);
  assert.match(String(sanitized.errors[1].cause), /circular/i);
  const lines = []; const originalError = console.error;
  try {
    console.error = (...args) => lines.push(util.format(...args));
    botRequire('../utils/logger')('error-test').warn(aggregate);
  } finally { console.error = originalError; }
  const output = `${util.inspect(sanitized, { depth: 8 })}\n${safeText(aggregate)}\n${lines.join('\n')}`;
  assert.match(lines.join('\n'), /disk denied/);
  assert.match(lines.join('\n'), /statusCode=503/);
  assert.match(output, /backup shutdown failed/);
  assert.match(output, /disk denied/);
  for (const secret of ['secret-cause-fixture', 'secret-request-fixture', 'secret-password-fixture', 'secret-object-fixture', 'secret-object-request']) {
    assert.equal(output.includes(secret), false, `logged secret: ${secret}`);
  }
});

test('redacted error causes are bounded even when very deeply nested', () => {
  const { redactArg } = botRequire('../utils/safeLog');
  const root = new Error('root'); let node = root;
  for (let i = 0; i < 200; i++) { node.cause = new Error(`cause-${i}`); node = node.cause; }
  const safe = redactArg(root);
  let depth = 0; let value = safe;
  while (value instanceof Error && value.cause) { depth++; value = value.cause; }
  assert.ok(depth > 0 && depth <= 12);
  assert.match(String(value), /truncat|depth/i);
});

test('aggregate error redaction caps total work even for wide repeated graphs', () => {
  const { redactArg, safeText } = botRequire('../utils/safeLog');
  let graph = new Error('leaf');
  for (let i = 0; i < 7; i++) graph = new AggregateError(Array(20).fill(graph), `level-${i}`);
  const result = redactArg(graph);
  const output = safeText(result);
  assert.match(output, /truncated/i);
  assert.ok(output.length < 100_000, 'repeated branches must not expand exponentially');
});

test('Drime sends one Bearer prefix and gives safe, owner-only authentication guidance', async (t) => {
  const config = botRequire('../config');
  const originalDrime = { ...config.drime };
  const oldError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(' '));
  let responseStatus = 401;
  const requests = [];
  const secret = 'private-fixture-drime-token';
  const server = http.createServer((req, res) => {
    requests.push(req.headers.authorization);
    res.writeHead(responseStatus, { 'content-type': 'application/json' });
    // A server can echo the rejected value; logs and messages must not expose it.
    res.end(JSON.stringify({ message: `rejected ${secret}` }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    console.error = oldError;
    Object.assign(config.drime, originalDrime);
    await new Promise((resolve) => server.close(resolve));
  });
  Object.assign(config.drime, {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiToken: `  Bearer ${secret}  `,
    papersFolderId: '1', papersFolderHash: 'test', workspaceId: '0',
  });
  const [paper, count, refresh] = botRequire('../commands/general/paper');
  const sock = { sendMessage: async () => ({}) };
  const msg = { key: { remoteJid: 'test@s.whatsapp.net' } };
  const execute = async (command, isOwner, args = []) => {
    const replies = [];
    await command.execute(sock, msg, args, {
      from: msg.key.remoteJid, isOwner,
      status: async () => ({ update: async (text) => replies.push(text) }),
      reply: async (text) => replies.push(text),
    });
    return replies.join('\n');
  };

  const ownerCount = await execute(count, true);
  const memberCount = await execute(count, false);
  const ownerRefresh = await execute(refresh, true);
  const ownerPaper = await execute(paper, true, ['COMP']);
  const memberPaper = await execute(paper, false, ['COMP']);
  assert.equal(requests.length, 5);
  assert.ok(requests.every((header) => header === `Bearer ${secret}`), 'authorization must not contain a doubled prefix or outer whitespace');
  for (const text of [ownerCount, ownerRefresh, ownerPaper]) assert.match(text, /authentication.*DRIME_API_TOKEN/i);
  for (const text of [memberCount, memberPaper]) assert.doesNotMatch(text, /DRIME_API_TOKEN|DRIME_BASE_URL|authentication/i);
  assert.doesNotMatch(logged.join('\n') + ownerCount + memberCount + ownerRefresh + ownerPaper + memberPaper, /private-fixture-drime-token/);

  config.drime.apiToken = secret; // A bare token remains supported.
  responseStatus = 403;
  const forbidden = await execute(count, true);
  assert.equal(requests.at(-1), `Bearer ${secret}`);
  assert.match(forbidden, /permission|access/i, '403 must not be described as an expired token');
  responseStatus = 500;
  await execute(count, true);
  assert.doesNotMatch(forbidden + logged.join('\n'), /private-fixture-drime-token/);

  config.drime.apiToken = '  Bearer  ';
  const beforeEmpty = requests.length;
  assert.match(await execute(count, true), /not configured/i);
  assert.equal(requests.length, beforeEmpty, 'an empty Bearer value must not be sent');
});
