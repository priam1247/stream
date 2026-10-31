#!/usr/bin/env node
'use strict';

// Offline regression tests. All cookie/binary fixtures are synthetic and are
// written under a temporary cwd; no provider, WhatsApp or internet calls occur.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'media-regression-'));
const ROOT = createBotFixture(TMP);
const botRequire = Module.createRequire(path.join(ROOT, 'scripts', 'test-media-downloads.js'));
process.chdir(TMP);
botRequire('../utils/telemetry')._resetForTests(null);
process.env.YT_AUTH_FILE = path.join(TMP, 'oauth.json');
process.env.FAKE_YTDLP = '1';
const bin = path.join(TMP, 'bin', 'yt-dlp');
const versionFile = path.join(TMP, 'version');
const callsFile = path.join(TMP, 'calls');
const counterFile = path.join(TMP, 'count');
fs.mkdirSync(path.dirname(bin), { recursive: true });
fs.writeFileSync(versionFile, '2025.01.01');
const fakeBinary = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const versionFile = ${JSON.stringify(versionFile)};
const callsFile = ${JSON.stringify(callsFile)};
const counterFile = ${JSON.stringify(counterFile)};
if (args.includes('--version')) { console.log(fs.readFileSync(versionFile, 'utf8')); process.exit(0); }
if (args.includes('--help')) {
  console.log('--js-runtimes --remote-components --impersonate --extractor-retries --force-ipv4 --no-check-certificates --newline --progress-template');
  process.exit(0);
}
if (args.includes('-U')) {
  if (process.env.TEST_UPDATE_FAIL === '1') { console.error('update failed'); process.exit(1); }
  if (process.env.TEST_UPDATE_VERSION) fs.writeFileSync(versionFile, process.env.TEST_UPDATE_VERSION);
  console.log('update complete'); process.exit(0);
}
fs.appendFileSync(callsFile, JSON.stringify(args) + '\\n');
if (process.env.TEST_REJECT_FLAG && args.includes(process.env.TEST_REJECT_FLAG)) {
  console.error('error: no such option: ' + process.env.TEST_REJECT_FLAG); process.exit(2);
}
let count = 0; try { count = Number(fs.readFileSync(counterFile, 'utf8')); } catch {}
fs.writeFileSync(counterFile, String(count + 1));
if (process.env.TEST_ALWAYS_BLOCK === '1' || count < Number(process.env.TEST_FAIL_FIRST || 0)) {
  console.error('ERROR: Sign in to confirm you are not a bot. Use --cookies for authentication'); process.exit(1);
}
console.log('ok');
`;
fs.writeFileSync(bin, fakeBinary, { mode: 0o755 });

// Compile the real implementation with an appended test-only accessor. The
// production module does not expose its internal client pool or cookie header.
function instrument(relative, appended) {
  const filename = path.join(ROOT, relative);
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  instance._compile(fs.readFileSync(filename, 'utf8') + `\n${appended}\n`, filename);
  return instance.exports;
}

const YT = require(path.join(ROOT, 'utils/youtubedl'));
const it = instrument('utils/ytInnertube.js', `
  module.exports._test = {
    readYoutubeCookieHeader, getClient, downloadWithClient, runCascade, streamWebReadableToFile,
    installDeps(value) { _deps = value; _clientCache.clear(); _poCache.clear(); _cookieFingerprint = null; },
  };
`);
const axios = require(path.join(ROOT, 'node_modules/axios'));
const ytInstaller = instrument('utils/youtubedl.js', 'module.exports._installStandaloneForTest = downloadStandaloneBinary;');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const resetFake = () => {
  fs.writeFileSync(counterFile, '0');
  fs.writeFileSync(callsFile, '');
  delete process.env.TEST_FAIL_FIRST;
  delete process.env.TEST_ALWAYS_BLOCK;
  delete process.env.TEST_REJECT_FLAG;
};

const row = (domain, sub, cookiePath, expires, name, value) =>
  [domain, sub, cookiePath, 'TRUE', String(expires), name, value].join('\t');

function makeInnertubeDeps() {
  const calls = { create: [], basic: [], mints: [], fetch: [], api: [], sabr: null };
  let useSabr = false;
  let sabrStreams = null;
  let duration = 0;
  let failChallenge = false;
  class JSDOM {
    constructor() { this.window = { document: {}, navigator: {}, close() {} }; }
  }
  const rawFetch = async (url, options) => {
    calls.fetch.push({ url: String(url), options });
    return { ok: true, json: async () => [] };
  };
  const stream = () => new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([1, 2, 3, 4])); controller.close(); } });
  class SabrStream {
    constructor(options) { calls.sabr = options; this.listeners = {}; }
    on(event, fn) { this.listeners[event] = fn; calls.reload = fn; }
    async start() {
      await calls.sabr.fetch(new URL('https://cdn.example.test/videoplayback'), { method: 'POST' });
      return sabrStreams || { audioStream: stream() };
    }
    setStreamingURL() {}
    setUstreamerConfig() {}
  }
  const yt = {
    Constants: {
      CLIENTS: { WEB: { NAME: 'WEB' }, IOS: { NAME: 'iOS' }, TV: { NAME: 'TVHTML5' } },
      CLIENT_NAME_IDS: { WEB: '1', iOS: '5', TVHTML5: '7' },
    },
    UniversalCache: class {},
    Innertube: { async create(options) {
      calls.create.push(options);
      return {
        session: {
          context: { client: { visitorData: 'fixture-visitor', clientName: options.client_type, clientVersion: '1' } },
          cookie: options.cookie, logged_in: Boolean(options.cookie),
          player: { decipher: async (url) => url },
          http: { fetch_function: rawFetch, fetch: async () => { throw new Error('authenticated API wrapper must not be used for external URLs'); } },
          on() {}, async signIn() {},
        },
        actions: { async execute(endpoint, payload) {
          calls.api.push({ endpoint, payload });
          return { streaming_data: { server_abr_streaming_url: 'https://cdn.example.test/videoplayback' },
            player_config: { media_common_config: { media_ustreamer_request_config: { video_playback_ustreamer_config: 'cfg' } } } };
        } },
        async getBasicInfo(id, options) {
          calls.basic.push({ id, options });
          const page = useSabr ? {
            streaming_data: { server_abr_streaming_url: 'https://cdn.example.test/videoplayback', adaptive_formats: [{ mime_type: 'audio/mp4' }] },
            player_config: { media_common_config: { media_ustreamer_request_config: { video_playback_ustreamer_config: 'cfg' } } },
          } : { streaming_data: {} };
          return { basic_info: { id, title: 'Fixture', duration }, page: [page], download: async () => { calls.streams = (calls.streams || 0) + 1; return stream(); } };
        },
        async download() { throw new Error('must reuse player response'); },
      };
    } },
  };
  const BG = {
    Challenge: { async create(cfg) {
      if (failChallenge) throw new Error('fixture challenge unavailable');
      await cfg.fetch('https://jnn-pa.googleapis.com/fixture', { method: 'POST' });
      return { program: 'p', globalName: 'g', interpreterJavascript: { privateDoNotAccessOrElseSafeScriptWrappedValue: 'void 0;' } };
    } },
    PoToken: {
      async generate({ bgConfig }) { calls.mints.push(bgConfig.identifier); return { poToken: `mint:${bgConfig.identifier}` }; },
      generateColdStartToken(id) { return `cold:${id}`; },
    },
  };
  return { deps: { yt, BG, JSDOM, SabrStream, buildSabrFormat: (v) => ({ mimeType: v.mime_type, audioQuality: 'AUDIO_QUALITY_HIGH' }),
    EnabledTrackTypes: { AUDIO_ONLY: 1, VIDEO_AND_AUDIO: 0 } }, calls,
    setSabr(value) { useSabr = value; }, setSabrStreams(value) { sabrStreams = value; },
    setDuration(value) { duration = value; }, setFailure(value) { failChallenge = value; } };
}

test('YouTube links use the actual host, and clips are not truncated into video IDs', () => {
  for (const url of ['https://youtu.be/dQw4w9WgXcQ', 'https://music.youtube.com/watch?x=1&v=dQw4w9WgXcQ', 'youtube.com/shorts/dQw4w9WgXcQ']) {
    assert.equal(YT.isYouTubeUrl(url), true, url);
    assert.equal(YT.extractVideoId(url), 'dQw4w9WgXcQ', url);
    assert.equal(it.extractVideoId(url), 'dQw4w9WgXcQ', url);
  }
  assert.equal(it.extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  for (const url of ['https://notyoutube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.example.org/watch?v=dQw4w9WgXcQ', 'https://example.org/?next=https://youtube.com/watch?v=dQw4w9WgXcQ']) {
    assert.equal(YT.isYouTubeUrl(url), false, url);
    assert.equal(YT.extractVideoId(url), null, url);
    assert.equal(it.extractVideoId(url), null, url);
  }
  for (const url of ['https://www.youtube.com/clip/Ugabcdef1234567890', 'https://youtu.be/dQw4w9WgXcQextra', 'https://youtube.com/watch?v=dQw4w9WgXcQextra']) {
    assert.equal(YT.extractVideoId(url), null, url);
    assert.equal(it.extractVideoId(url), null, url);
  }
});

test('Netscape HttpOnly cookies count and reach Innertube only for the correct host/path and expiry', () => {
  const raw = [
    '# Netscape HTTP Cookie File',
    row('#HttpOnly_.youtube.com', 'TRUE', '/', 0, 'SID', 'http-only-fixture'),
    row('.youtube.com', 'TRUE', '/', 1999999999, 'SAPISID', 'fixture'),
    row('www.youtube.com', 'FALSE', '/', 0, 'HOST', 'allowed'),
    row('.evil-youtube.com', 'TRUE', '/', 0, 'WRONG_DOMAIN', 'denied'),
    row('youtube.com.example.org', 'TRUE', '/', 0, 'SPOOFED', 'denied'),
    row('.google.com', 'TRUE', '/', 0, 'OTHER_SITE', 'denied'),
    row('youtube.com', 'FALSE', '/', 0, 'HOST_ONLY_PARENT', 'denied'),
    row('.youtube.com', 'TRUE', '/watch', 0, 'WRONG_PATH', 'denied'),
    row('.youtube.com', 'TRUE', '/', 100, 'EXPIRED', 'denied'),
    row('.youtube.com', 'TRUE', '/', 0, 'BAD', 'bad;injected'),
  ].join('\n') + '\n';
  assert.equal(YT.setCookies(raw).count, 10);
  assert.equal(YT.cookieInfo().count, 10);
  const header = it._test.readYoutubeCookieHeader();
  assert.equal(header, 'SID=http-only-fixture; SAPISID=fixture; HOST=allowed');
  const converted = YT.normaliseCookieText(JSON.stringify([{ domain: '.youtube.com', name: 'SID', value: 'fixture', httpOnly: true }]));
  assert.match(converted, /#HttpOnly_\.youtube\.com/);
  assert.throws(() => YT.setCookies('# Netscape HTTP Cookie File\n'), { code: 'BAD_COOKIES' });
  assert.equal(it._test.readYoutubeCookieHeader(), header, 'an empty upload must not replace valid stored cookies');
  YT.clearCookies();
});

test('inline cookie precedence does not overwrite the separate managed upload', () => {
  const cfg = require(path.join(ROOT, 'config')).ytdlp;
  const before = cfg.cookies;
  const managed = row('.youtube.com', 'TRUE', '/', 0, 'SID', 'managed-fixture') + '\n';
  const inline = row('.youtube.com', 'TRUE', '/', 0, 'SID', 'inline-fixture') + '\n';
  try {
    cfg.cookies = inline;
    YT.setCookies(managed);
    assert.equal(YT.cookieInfo().source, 'inline (config/env)');
    const inlinePath = YT.cookieFile();
    assert.notEqual(inlinePath, YT.COOKIE_STORE);
    assert.match(fs.readFileSync(inlinePath, 'utf8'), /inline-fixture/);
    assert.match(fs.readFileSync(YT.COOKIE_STORE, 'utf8'), /managed-fixture/);
    cfg.cookies = '';
    YT.setCookies(managed); // invalidates the source cache, as at startup
    assert.equal(YT.cookieInfo().source, 'managed (.cookies set)');
    assert.match(fs.readFileSync(YT.cookieFile(), 'utf8'), /managed-fixture/);
  } finally { cfg.cookies = before; YT.clearCookies(); }
});

test('client pool uses correct protocol client names and rotates immediately with changed or cleared cookies', async () => {
  YT.setCookies(row('#HttpOnly_.youtube.com', 'TRUE', '/', 0, 'SID', 'http-only-fixture') + '\n');
  const fake = makeInnertubeDeps();
  it._test.installDeps(fake.deps);
  const a = await it._test.getClient('TV');
  assert.equal(fake.calls.create[0].client_type, 'TVHTML5');
  assert.equal(await it._test.getClient('TV'), a);
  assert.match(fake.calls.create[0].cookie, /SID=http-only-fixture/);
  YT.setCookies(row('#HttpOnly_.youtube.com', 'TRUE', '/', 0, 'SID', 'second-fixture') + '\n');
  const b = await it._test.getClient('TV');
  assert.notEqual(a, b);
  assert.equal(fake.calls.create[1].cookie, 'SID=second-fixture');
  YT.clearCookies();
  const c = await it._test.getClient('TV');
  assert.notEqual(b, c);
  assert.equal(fake.calls.create[2].cookie, undefined);
  await it._test.getClient('IOS');
  assert.equal(fake.calls.create[3].client_type, 'iOS');
});

test('player tokens are video-bound, uncached, sent on the request, and external fetch uses no auth wrapper', async () => {
  const fake = makeInnertubeDeps();
  it._test.installDeps(fake.deps);
  const id = 'dQw4w9WgXcQ';
  for (let i = 0; i < 2; i++) {
    const result = await it._test.downloadWithClient(id, 'IOS', null, 'audio', {
      outBase: path.join(TMP, `track${i}`), maxBytes: 1000, timeoutMs: 1000,
    });
    assert.equal(fs.readFileSync(result.file).length, 4);
  }
  assert.deepEqual(fake.calls.mints, ['fixture-visitor', id, id]);
  assert.equal(fake.calls.basic[0].options.client, 'IOS');
  assert.equal(fake.calls.basic[0].options.po_token, `mint:${id}`);
  assert.ok(fake.calls.fetch.every(({ url }) => url.startsWith('https://jnn-pa.googleapis.com/')));
});

test('SABR uses the session token and raw CDN fetch; player reload receives a fresh video token', async () => {
  const fake = makeInnertubeDeps();
  fake.setSabr(true);
  it._test.installDeps(fake.deps);
  const id = 'dQw4w9WgXcQ';
  await it._test.downloadWithClient(id, 'TV', null, 'audio', {
    outBase: path.join(TMP, 'sabr'), maxBytes: 1000, timeoutMs: 1000,
  });
  assert.equal(fake.calls.sabr.poToken, 'mint:fixture-visitor');
  assert.ok(fake.calls.fetch.some(({ url }) => url.startsWith('https://cdn.example.test/')));
  await fake.calls.reload();
  assert.deepEqual(fake.calls.mints, ['fixture-visitor', id, id]);
  assert.equal(fake.calls.api[0].payload.client, 'TV');
  assert.equal(fake.calls.api[0].payload.serviceIntegrityDimensions.poToken, `mint:${id}`);
});

test('Innertube stops on the duration limit before downloading or retrying other clients', async () => {
  const fake = makeInnertubeDeps();
  fake.setDuration(121);
  it._test.installDeps(fake.deps);
  const base = path.join(TMP, 'too-long');
  await assert.rejects(it._test.runCascade('https://youtu.be/dQw4w9WgXcQ', 'video', {
    outBase: base, maxSeconds: 120, timeoutMs: 20000, _allowInFakeYtdlp: true,
  }), { code: 'TOO_LONG' });
  assert.equal(fake.calls.basic.length, 1);
  assert.equal(fake.calls.streams || 0, 0);
  assert.equal(fs.existsSync(`${base}_it.mp4`), false);
});

test('signed-in sessions do not send a visitor-bound token as an account-bound media token', async () => {
  const fake = makeInnertubeDeps();
  fake.setSabr(true);
  YT.setCookies(row('#HttpOnly_.youtube.com', 'TRUE', '/', 0, 'SID', 'fixture') + '\n');
  it._test.installDeps(fake.deps);
  const id = 'dQw4w9WgXcQ';
  try {
    await it._test.downloadWithClient(id, 'WEB', null, 'audio', {
      outBase: path.join(TMP, 'signed-in'), maxBytes: 1000, timeoutMs: 1000,
    });
    assert.deepEqual(fake.calls.mints, [id]);
    assert.equal(fake.calls.basic[0].options.po_token, `mint:${id}`);
    assert.equal(fake.calls.sabr.poToken, undefined);
  } finally { YT.clearCookies(); }
});

test('stream writes enforce size and timeout limits and clean partial files without unhandled errors', async () => {
  const write = it._test.streamWebReadableToFile;
  const bytes = () => new ReadableStream({ start(c) { c.enqueue(Uint8Array.from([1, 2, 3, 4])); c.close(); } });
  const good = path.join(TMP, 'stream-good');
  await write(bytes(), good, { maxBytes: 4, timeoutMs: 1000 });
  assert.deepEqual([...fs.readFileSync(good)], [1, 2, 3, 4]);
  const big = path.join(TMP, 'stream-too-big');
  await assert.rejects(write(bytes(), big, { maxBytes: 3, timeoutMs: 1000 }), { code: 'TOO_BIG' });
  assert.equal(fs.existsSync(big), false);
  let cancelled = false;
  const hanging = () => new ReadableStream({ cancel() { cancelled = true; } });
  const slow = path.join(TMP, 'stream-timeout');
  const guard = setTimeout(() => {}, 2000); // keep the test alive for the unref'ed timeout
  try { await assert.rejects(write(hanging(), slow, { maxBytes: 100, timeoutMs: 50 }), { code: 'NETWORK' }); }
  finally { clearTimeout(guard); }
  assert.equal(cancelled, true);
  assert.equal(fs.existsSync(slow), false);
  await assert.rejects(write(hanging(), path.join(TMP, 'missing', 'file'), { timeoutMs: 1000 }), { code: 'ENOENT' });
});

test('a failed SABR track cancels its sibling and both temporary files are removed', async () => {
  const fake = makeInnertubeDeps();
  fake.setSabr(true);
  let cancelled = false;
  fake.setSabrStreams({
    videoStream: new ReadableStream({ start(c) { c.enqueue(Uint8Array.from([1, 2, 3, 4])); c.close(); } }),
    audioStream: new ReadableStream({ cancel() { cancelled = true; } }),
  });
  it._test.installDeps(fake.deps);
  const outBase = path.join(TMP, 'sabr-cancel');
  await assert.rejects(it._test.downloadWithClient('dQw4w9WgXcQ', 'WEB', null, 'video', {
    outBase, maxBytes: 3, timeoutMs: 1000,
  }), { code: 'TOO_BIG' });
  assert.equal(cancelled, true);
  assert.equal(fs.existsSync(`${outBase}_it_v.mp4`), false);
  assert.equal(fs.existsSync(`${outBase}_it_a.m4a`), false);
});

test('combined SABR track sizes cannot exceed the media cap', async () => {
  const fake = makeInnertubeDeps();
  fake.setSabr(true);
  const bytes = () => new ReadableStream({ start(c) { c.enqueue(Uint8Array.from([1, 2, 3, 4])); c.close(); } });
  fake.setSabrStreams({ videoStream: bytes(), audioStream: bytes() });
  it._test.installDeps(fake.deps);
  const outBase = path.join(TMP, 'sabr-combined');
  await assert.rejects(it._test.downloadWithClient('dQw4w9WgXcQ', 'WEB', null, 'video', {
    outBase, maxBytes: 7, timeoutMs: 1000,
  }), { code: 'TOO_BIG' });
  assert.equal(fs.existsSync(`${outBase}_it_v.mp4`), false);
  assert.equal(fs.existsSync(`${outBase}_it_a.m4a`), false);
});

test('when token minting fails, no session-bound placeholder is sent as a player token', async () => {
  const fake = makeInnertubeDeps();
  fake.setFailure(true);
  it._test.installDeps(fake.deps);
  await it._test.downloadWithClient('dQw4w9WgXcQ', 'WEB', null, 'audio', {
    outBase: path.join(TMP, 'cold'), maxBytes: 1000, timeoutMs: 1000,
  });
  assert.equal(fake.calls.basic[0].options.po_token, undefined);
});

test('real youtubei.js sends the selected client and content token to its API, not cookies to the media CDN', async () => {
  const real = await import('youtubei.js');
  const fake = makeInnertubeDeps();
  const requests = [];
  const id = 'dQw4w9WgXcQ';
  const fetchStub = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, init });
    if (url.includes('/youtubei/v1/player')) {
      return Response.json({
        playabilityStatus: { status: 'OK' },
        videoDetails: { videoId: id, title: 'Fixture', author: 'Tester', lengthSeconds: '1', viewCount: '1', thumbnail: { thumbnails: [] } },
        streamingData: { expiresInSeconds: '60', adaptiveFormats: [], formats: [{
          itag: 18, url: 'https://cdn.example.test/videoplayback?source=youtube', mimeType: 'video/mp4; codecs="avc1, mp4a"',
          qualityLabel: '360p', audioQuality: 'AUDIO_QUALITY_MEDIUM', audioBitrate: 128, contentLength: '4', lastModified: '0',
        }] },
      });
    }
    if (url.startsWith('https://cdn.example.test/')) return new Response(Uint8Array.from([1, 2, 3, 4]));
    throw new Error(`unexpected offline request: ${url}`);
  };
  fake.deps.yt = {
    ...real,
    Innertube: { create: (opts) => real.Innertube.create({ ...opts, retrieve_player: false, retrieve_innertube_config: false, fetch: fetchStub }) },
  };
  // The fake BG challenge does no I/O; the real client still handles player and CDN requests.
  fake.deps.BG.Challenge.create = async () => ({ program: 'p', globalName: 'g', interpreterJavascript: { privateDoNotAccessOrElseSafeScriptWrappedValue: 'void 0;' } });
  it._test.installDeps(fake.deps);
  YT.setCookies([row('#HttpOnly_.youtube.com', 'TRUE', '/', 0, 'SID', 'fixture'),
    row('.youtube.com', 'TRUE', '/', 0, 'SAPISID', 'fixture')].join('\n') + '\n');
  try {
    await it._test.downloadWithClient(id, 'IOS', null, 'video', {
      outBase: path.join(TMP, 'real-youtubei'), height: 360, maxBytes: 1000, timeoutMs: 2000,
    });
    const api = requests.find((r) => r.url.includes('/youtubei/v1/player'));
    const payload = JSON.parse(api.init.body);
    assert.equal(payload.context.client.clientName, 'iOS');
    assert.equal(payload.serviceIntegrityDimensions.poToken, `mint:${id}`);
    assert.match(new Headers(api.init.headers).get('cookie'), /SID=fixture/);
    const cdn = requests.find((r) => r.url.startsWith('https://cdn.example.test/'));
    assert.ok(cdn, 'real client did not fetch the fixture media');
    assert.equal(new Headers(cdn.init.headers).get('cookie'), null);
    assert.equal(new Headers(cdn.init.headers).get('authorization'), null);
  } finally { YT.clearCookies(); }
});

test('EJS and Node are enabled on the first attempt without disabling TLS checks', () => {
  const args = YT.baseArgs();
  assert.ok(args.includes('--js-runtimes'));
  assert.equal(args[args.indexOf('--remote-components') + 1], 'ejs:github');
  assert.equal(args.includes('--no-check-certificates'), false);
  assert.equal(YT.classify({ stderr: 'ERROR: certificate verify failed' }).code, 'TLS_ERROR');
});

test('after a real version change, the updated default profile is retried', async () => {
  resetFake();
  process.env.TEST_FAIL_FIRST = '1';
  process.env.TEST_UPDATE_VERSION = '2026.10.26';
  const result = await YT.runWithProfiles('https://youtu.be/dQw4w9WgXcQ', () => ['fixture'], { deadlineMs: 60000 });
  assert.equal(result.profile, 'default');
  assert.equal(result.attempts[0].engine, 'yt-dlp:default');
  const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((args) => !args.includes('--extractor-args')));
  delete process.env.TEST_UPDATE_VERSION;
  delete process.env.TEST_FAIL_FIRST;
});

test('unauthenticated retry cap includes distinct iOS and impersonation profiles', async () => {
  resetFake();
  YT.clearCookies();
  process.env.TEST_ALWAYS_BLOCK = '1';
  const names = [];
  await assert.rejects(() => YT.runWithProfiles('https://youtu.be/dQw4w9WgXcQ', () => ['fixture'], {
    deadlineMs: 60000, onAttempt: (name) => names.push(name),
  }), (e) => e.code === 'BOT_CHECK');
  assert.deepEqual(names, ['default', 'tv', 'android_vr', 'ios', 'impersonate']);
  delete process.env.TEST_ALWAYS_BLOCK;
});

test('minimal mode actually drops a rejected optional runtime flag', async () => {
  resetFake();
  process.env.TEST_REJECT_FLAG = '--js-runtimes';
  try {
    const result = await YT.runWithProfiles('https://youtu.be/dQw4w9WgXcQ', () => ['fixture'], { deadlineMs: 60000 });
    assert.equal(result.profile, 'default');
    assert.ok(YT.usingMinimalBaseArgs());
    assert.equal(YT.baseArgs().includes('--js-runtimes'), false);
    assert.equal(YT.baseArgs().includes('--remote-components'), false);
  } finally {
    YT.setMinimalBaseArgs(false);
    delete process.env.TEST_REJECT_FLAG;
  }
});

test('a failed update is not reported as successful just because the old version still runs', async () => {
  process.env.TEST_UPDATE_FAIL = '1';
  try { assert.equal(await YT.update({ quick: true }), null); }
  finally { delete process.env.TEST_UPDATE_FAIL; }
});

test('owner-only hints use the configured prefix and non-YouTube errors do not blame YouTube', () => {
  const err = { code: 'BOT_CHECK' };
  assert.doesNotMatch(YT.friendlyError(err), /\.ytdl|\.cookies/);
  assert.match(YT.friendlyError(err, { isOwner: true }), /\.ytdl update.*\.cookies set/);
  assert.doesNotMatch(YT.friendlyError(err, { isYouTube: false, isOwner: true }), /YouTube|\.cookies/);
});

test('standalone installer enforces TLS, verifies checksum and never executes a mismatch', async () => {
  const previousGet = axios.get;
  const before = fs.readFileSync(bin);
  const marker = path.join(TMP, 'executed');
  const payload = Buffer.from(`#!/bin/sh\necho yes > ${marker}\necho 2026.10.26\n`);
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  let count = 0;
  try {
    axios.get = async (_url, options) => {
      count++;
      assert.notEqual(options.httpsAgent.options.rejectUnauthorized, false);
      assert.throws(() => options.beforeRedirect({ protocol: 'http:' }), /insecure/);
      assert.doesNotThrow(() => options.beforeRedirect({ protocol: 'https:' }));
      throw new Error('certificate verify failed');
    };
    await assert.rejects(() => ytInstaller._installStandaloneForTest(), /certificate verify failed/);
    assert.equal(count, 1, 'certificate failure must not trigger an insecure retry');
    assert.deepEqual(fs.readFileSync(bin), before);

    axios.get = async (url, options) => {
      assert.notEqual(options.httpsAgent.options.rejectUnauthorized, false);
      return url.endsWith('SHA2-256SUMS')
        ? { data: `${'0'.repeat(64)}  yt-dlp\n` }
        : { data: Readable.from([payload]) };
    };
    await assert.rejects(() => ytInstaller._installStandaloneForTest(), /checksum mismatch/);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(fs.readFileSync(bin), before);
    assert.equal(fs.readdirSync(path.dirname(bin)).filter((name) => name.endsWith('.tmp')).length, 0);

    axios.get = async (url) => url.endsWith('SHA2-256SUMS')
      ? { data: `${digest}  yt-dlp\n` } : { data: Readable.from([payload]) };
    assert.equal(await ytInstaller._installStandaloneForTest(), bin);
    assert.equal(fs.existsSync(marker), true);
    assert.deepEqual(fs.readFileSync(bin), payload);
  } finally {
    axios.get = previousGet;
    fs.writeFileSync(bin, before, { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
  }
});

test('shell installer requires HTTPS and a matching checksum before executing', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(TMP, 'shell-installer');
  const tools = path.join(dir, 'tools'), assets = path.join(dir, 'assets');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(tools); fs.mkdirSync(assets);
  fs.copyFileSync(path.join(ROOT, 'scripts/install-ytdlp.sh'), path.join(dir, 'scripts/install-ytdlp.sh'));
  for (const name of ['dirname', 'mkdir', 'mktemp', 'rm', 'mv', 'chmod', 'cp']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    assert.equal(found.status, 0, `missing test utility ${name}`);
    fs.symlinkSync(found.stdout.trim(), path.join(tools, name));
  }
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  assert.equal(python.status, 0, 'python3 required to test the shell installer');
  fs.writeFileSync(path.join(tools, 'python3'), `#!/bin/sh\n[ "$1" = -m ] && exit 1\nexec ${python.stdout.trim()} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'pip3'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'curl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CURL_LOG"
out= url=
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2;; https:*) url="$1"; shift;; *) shift;; esac
done
case "$url" in */SHA2-256SUMS) cp "$ASSETS/sums" "$out";; */yt-dlp) cp "$ASSETS/binary" "$out";; *) exit 1;; esac
`, { mode: 0o755 });
  const marker = path.join(dir, 'executed');
  const payload = Buffer.from(`#!/bin/sh\necho yes > ${marker}\necho 2026.10.26\n`);
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  fs.writeFileSync(path.join(assets, 'binary'), payload);
  fs.writeFileSync(path.join(assets, 'sums'), `${'0'.repeat(64)}  yt-dlp\n`);
  const old = path.join(dir, 'bin/yt-dlp');
  fs.writeFileSync(old, 'old-disabled', { mode: 0o644 });
  const env = { ...process.env, PATH: tools, ASSETS: assets, CURL_LOG: path.join(dir, 'curl.log') };
  const run = () => spawnSync('/bin/bash', [path.join(dir, 'scripts/install-ytdlp.sh')], { cwd: dir, env, encoding: 'utf8' });
  const failed = run();
  assert.notEqual(failed.status, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(old, 'utf8'), 'old-disabled');
  assert.equal(fs.readdirSync(path.join(dir, 'bin')).some((name) => name.startsWith('.yt-dlp')), false);
  fs.writeFileSync(path.join(assets, 'sums'), `${digest}  yt-dlp\n`);
  const success = run();
  assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`);
  assert.equal(fs.existsSync(marker), true);
  assert.deepEqual(fs.readFileSync(old), payload);
  for (const line of fs.readFileSync(env.CURL_LOG, 'utf8').trim().split('\n')) {
    assert.match(line, /--proto =https/);
    assert.match(line, /--proto-redir =https/);
    assert.doesNotMatch(line, /(?:^|\s)(?:-k|--insecure)(?:\s|$)/);
  }
});

test('YouTube login times out before a device code and ignores late success', async (t) => {
  const { EventEmitter } = require('node:events');
  const ytAuth = botRequire('../utils/ytAuth');
  const authFile = process.env.YT_AUTH_FILE;
  t.after(() => { ytAuth._setInnertubeFactoryForTest(null); fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true }); });
  fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true });
  const session = new EventEmitter();
  session.signIn = () => new Promise(() => {});
  ytAuth._setInnertubeFactoryForTest(async () => ({ session }));
  let guard;
  try {
    await assert.rejects(Promise.race([
      ytAuth.startYtLogin({ timeoutMs: 25 }),
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('login did not time out')), 500); }),
    ]), (err) => err.code === 'LOGIN_TIMEOUT');
    session.emit('auth', { credentials: { refresh_token: 'dummy-late-token' } });
    assert.equal(fs.existsSync(authFile), false, 'a late authorization cannot restore credentials after timeout');
  } finally { clearTimeout(guard); }
});

test('YouTube OAuth clear removes both the active file and its backup', (t) => {
  const ytAuth = botRequire('../utils/ytAuth');
  const authFile = process.env.YT_AUTH_FILE;
  t.after(() => { fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true }); });
  ytAuth.saveYtCreds({ refresh_token: 'dummy-token-to-clear' });
  assert.equal(fs.existsSync(authFile), true);
  assert.equal(fs.existsSync(`${authFile}.bak`), true);
  fs.writeFileSync(`${authFile}.corrupt`, 'dummy-corrupt-token');
  assert.equal(ytAuth.clearYtCreds(), true);
  assert.equal(fs.existsSync(authFile), false);
  assert.equal(fs.existsSync(`${authFile}.bak`), false, 'a cleared OAuth token must not remain in the backup');
  assert.equal(fs.existsSync(`${authFile}.corrupt`), false, 'a cleared OAuth token must not remain in a recovery copy');
});

test('turning YouTube OAuth off cancels a pending device login and ignores late authorization', async (t) => {
  const { EventEmitter } = require('node:events');
  const ytAuth = botRequire('../utils/ytAuth');
  const command = botRequire('../commands/admin/ytlogin');
  const authFile = process.env.YT_AUTH_FILE;
  t.after(() => { ytAuth._setInnertubeFactoryForTest(null); fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true }); });
  fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true });
  const session = new EventEmitter(); let ready;
  const codeReady = new Promise((resolve) => { ready = resolve; });
  session.signIn = async () => { session.emit('auth-pending', { user_code: 'DUMMY', expires_in: 30 }); };
  ytAuth._setInnertubeFactoryForTest(async () => ({ session }));
  const extra = { reply: async () => {}, status: async () => { ready(); return { update: async () => {} }; } };
  const pending = command.execute({}, {}, [], extra);
  await codeReady;
  await command.execute({}, {}, ['off'], extra);
  session.emit('auth', { credentials: { refresh_token: 'dummy-late-token' } });
  await pending;
  assert.equal(fs.existsSync(authFile), false, 'cancelled login must not recreate OAuth credentials');
  assert.equal(fs.existsSync(`${authFile}.bak`), false);
});

test('OAuth refresh persists, but an old client cannot recreate credentials after clear', async (t) => {
  const { EventEmitter } = require('node:events');
  const ytAuth = botRequire('../utils/ytAuth'); const authFile = process.env.YT_AUTH_FILE;
  t.after(() => { fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true }); });
  ytAuth.saveYtCreds({ refresh_token: 'dummy-old-token' });
  const fake = makeInnertubeDeps(); const create = fake.deps.yt.Innertube.create;
  fake.deps.yt.Innertube.create = async (opts) => {
    const client = await create(opts);
    const { on: _ignoredOn, ...rest } = client.session;
    client.session = Object.assign(new EventEmitter(), rest, { signIn: async () => {} });
    return client;
  };
  it._test.installDeps(fake.deps);
  const client = await it._test.getClient('TV', ytAuth.getYtCreds());
  client.session.emit('update-credentials', { credentials: { refresh_token: 'dummy-old-token', access_token: 'dummy-fresh-access' } });
  assert.equal(ytAuth.getYtCreds().access_token, 'dummy-fresh-access', 'youtubei refresh events must persist the new token');
  ytAuth.clearYtCreds();
  client.session.emit('update-credentials', { credentials: { refresh_token: 'dummy-refreshed-token' } });
  assert.equal(fs.existsSync(authFile), false, 'a stale client must not recreate a cleared token');
  assert.equal(fs.existsSync(`${authFile}.bak`), false);
});

test('an OAuth client still starting when credentials are cleared is not signed in or cached', async (t) => {
  const { EventEmitter } = require('node:events');
  const ytAuth = botRequire('../utils/ytAuth'); const authFile = process.env.YT_AUTH_FILE;
  t.after(() => { fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true }); });
  ytAuth.saveYtCreds({ refresh_token: 'dummy-old-token' });
  const fake = makeInnertubeDeps(); const create = fake.deps.yt.Innertube.create;
  let release; let signIns = 0;
  const ready = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  fake.deps.yt.Innertube.create = async (opts) => {
    await ready;
    const client = await create(opts);
    const { on: _ignoredOn, ...rest } = client.session;
    client.session = Object.assign(new EventEmitter(), rest, { signIn: async () => { signIns += 1; } });
    return client;
  };
  it._test.installDeps(fake.deps);
  const creating = it._test.getClient('TV', ytAuth.getYtCreds());
  await new Promise((resolve) => setImmediate(resolve));
  ytAuth.clearYtCreds(); release();
  await assert.rejects(creating, /credential|auth/i);
  assert.equal(signIns, 0);
});

test('a runtime reload preserves a pending YouTube login so off still cancels it', async (t) => {
  const { EventEmitter } = require('node:events');
  const ytAuth = botRequire('../utils/ytAuth');
  const oldCommand = botRequire('../commands/admin/ytlogin');
  const authFile = process.env.YT_AUTH_FILE;
  t.after(() => { ytAuth._setInnertubeFactoryForTest(null); fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true }); });
  fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true });
  const session = new EventEmitter(); let ready;
  const codeReady = new Promise((resolve) => { ready = resolve; });
  session.signIn = async () => { session.emit('auth-pending', { user_code: 'DUMMY', expires_in: 30 }); };
  ytAuth._setInnertubeFactoryForTest(async () => ({ session }));
  const messages = [];
  const extra = { reply: async (text) => { messages.push(text); }, status: async () => { ready(); return { update: async () => {} }; } };
  const pending = oldCommand.execute({}, {}, [], extra);
  await codeReady;
  botRequire('../utils/hotReload').reloadRuntime();
  const reloadedAuth = botRequire('../utils/ytAuth');
  const reloadedCommand = botRequire('../commands/admin/ytlogin');
  await reloadedCommand.execute({}, {}, [], extra);
  assert.ok(messages.some((message) => /already waiting/i.test(message)), 'reload must not allow a second login');
  await reloadedCommand.execute({}, {}, ['off'], extra);
  session.emit('auth', { credentials: { refresh_token: 'dummy-late-token' } });
  await pending;
  assert.equal(reloadedAuth, ytAuth, 'auth state must survive runtime reload');
  assert.equal(fs.existsSync(authFile), false, 'logout after a reload must cancel the original pending login');
});

test('corrupt credential JSON does not expose file contents through recovery logs or errors', (t) => {
  const { readJsonSafe } = botRequire('../utils/jsonStore');
  const target = path.join(TMP, 'invalid-sensitive.json');
  const warnings = []; const originalWarn = console.warn;
  t.after(() => { console.warn = originalWarn; fs.rmSync(target, { force: true }); fs.rmSync(`${target}.bak`, { force: true }); fs.rmSync(`${target}.corrupt`, { force: true }); });
  fs.writeFileSync(target, 'secret-fixture-value-not-json');
  fs.writeFileSync(`${target}.bak`, '{}');
  console.warn = (...args) => warnings.push(args.join(' '));
  assert.equal(readJsonSafe(target).recovered, true);
  assert.doesNotMatch(warnings.join('\n'), /secret-fix/, 'recovery log must not quote corrupt file contents');
  fs.writeFileSync(target, 'secret-fixture-value-not-json');
  fs.writeFileSync(`${target}.bak`, 'also-corrupt');
  const result = readJsonSafe(target);
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error.message, /secret-fix/, 'returned parse errors must not quote corrupt file contents');
});

test('YouTube login also times out during client creation and never starts a late client', async (t) => {
  const { EventEmitter } = require('node:events');
  const ytAuth = botRequire('../utils/ytAuth');
  let release; let signIns = 0; let guard;
  const creation = new Promise((resolve) => { release = resolve; });
  t.after(() => { release({ session: new EventEmitter() }); ytAuth._setInnertubeFactoryForTest(null); clearTimeout(guard); });
  ytAuth._setInnertubeFactoryForTest(() => creation);
  await assert.rejects(Promise.race([
    ytAuth.startYtLogin({ timeoutMs: 25 }),
    new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('client creation did not time out')), 500); }),
  ]), (err) => err.code === 'LOGIN_TIMEOUT');
  const session = new EventEmitter(); session.signIn = () => { signIns += 1; };
  release({ session });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signIns, 0);
  assert.equal(ytAuth.isLoginPending(), false);
});

test('OAuth refresh from an earlier account cannot overwrite a newly linked account', async (t) => {
  const { EventEmitter } = require('node:events');
  const ytAuth = botRequire('../utils/ytAuth'); const authFile = process.env.YT_AUTH_FILE;
  t.after(() => { fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true }); });
  ytAuth.saveYtCreds({ refresh_token: 'dummy-first-account' });
  const fake = makeInnertubeDeps(); const create = fake.deps.yt.Innertube.create;
  fake.deps.yt.Innertube.create = async (opts) => {
    const client = await create(opts);
    const { on: _ignoredOn, ...rest } = client.session;
    client.session = Object.assign(new EventEmitter(), rest, { signIn: async () => {} });
    return client;
  };
  it._test.installDeps(fake.deps);
  const oldClient = await it._test.getClient('TV', ytAuth.getYtCreds());
  ytAuth.saveYtCreds({ refresh_token: 'dummy-second-account' });
  oldClient.session.emit('update-credentials', { credentials: { refresh_token: 'dummy-first-account', access_token: 'dummy-stale' } });
  assert.equal(ytAuth.getYtCreds().refresh_token, 'dummy-second-account');
  assert.equal(ytAuth.getYtCreds().access_token, undefined);
  const newClient = await it._test.getClient('TV', ytAuth.getYtCreds());
  assert.notEqual(newClient, oldClient);
});

test('YouTube OAuth clear reports a failure if a local recovery copy cannot be removed', (t) => {
  const ytAuth = botRequire('../utils/ytAuth'); const authFile = process.env.YT_AUTH_FILE;
  const originalUnlink = fs.unlinkSync;
  t.after(() => { fs.unlinkSync = originalUnlink; fs.rmSync(authFile, { force: true }); fs.rmSync(`${authFile}.bak`, { force: true }); });
  ytAuth.saveYtCreds({ refresh_token: 'dummy-clear-failure' });
  fs.unlinkSync = (name, ...args) => {
    if (name === `${authFile}.bak`) throw Object.assign(new Error('blocked'), { code: 'EACCES' });
    return originalUnlink(name, ...args);
  };
  assert.throws(() => ytAuth.clearYtCreds(), { code: 'YT_AUTH_CLEAR_FAILED' });
  assert.equal(fs.existsSync(authFile), false);
  assert.equal(fs.existsSync(`${authFile}.bak`), true, 'the operation must not claim full success');
});
