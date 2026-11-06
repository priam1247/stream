'use strict';

// Offline tests for the XJX-style external resolver chain and remote delivery.
// All provider responses and WhatsApp sends are mocked; no network is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xjx-media-'));
const ROOT = createBotFixture(TMP);
process.chdir(TMP);
process.env.PREFIX = '.';

const media = require(path.join(ROOT, 'lib/downloads/xjx'));
const constants = media.constants;
const noWait = async () => {};
const sample = 'https://youtu.be/dQw4w9WgXcQ';
const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const fromBot = (name) => require(path.join(ROOT, name));

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('search input selects the first YouTube result, as XJX does', async () => {
  const searches = [];
  const client = media.createXjxMedia({
    http: { async get() { throw new Error('not used'); } },
    search: async (input) => {
      searches.push(input);
      return { videos: [
        { url: sample, title: 'Top result', author: { name: 'Artist' }, duration: { seconds: 125 } },
        { url: 'https://youtu.be/aaaaaaaaaaa', title: 'Second result' },
      ] };
    },
    settings: {},
    logger: { warn() {} }, wait: noWait,
  });
  const hit = await client.resolveYouTubeInput('artist track');
  assert.equal(searches[0], 'artist track');
  assert.equal(hit.url, canonical);
  assert.equal(hit.title, 'Top result');
  assert.equal(hit.author, 'Artist');
  assert.equal(hit.duration, 125);
});

const gk = (result) => ({ enabled: true, async download(url, options) { return typeof result === 'function' ? result(url, options) : result; } });
const fakeSearch = (fields = {}) => async ({ videoId }) => ({ title: 'Selected title', videoId, ...fields });
const SONG_URL = 'https://dl.gronka.dev/f/song';
const VIDEO_URL = 'https://cdn.gronka.dev/video.mp4';

test('.song asks Gronka for audio and sends one artist-titled MP3 document', async () => {
  const asked = [];
  const gronka = gk((url, options) => { asked.push({ url, options }); return { lane: 'worker', files: [{ url: SONG_URL, filename: 'Provider title.audio.mp3', kind: 'audio' }] }; });
  const client = media.createXjxMedia({
    gronka,
    search: fakeSearch({ title: 'Joji - Sanctuary (Official Video)', author: { name: 'Joji - Topic' } }),
    settings: {}, logger: { warn() {} },
  });
  const bodies = [];
  const sock = { async sendMessage(_chat, body) { bodies.push(body); return { key: { id: 'sent' } }; } };
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'm-song' } };
  const result = await client.downloadSongCommand(sock, msg, { from: msg.key.remoteJid }, sample);
  assert.equal(result.via, 'Gronka');
  assert.equal(result.artist, 'Joji');
  assert.equal(result.title, 'Sanctuary');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].options.mode, 'audio');
  const mediaBodies = bodies.filter((body) => body.audio || body.document);
  assert.equal(mediaBodies.length, 1);
  assert.equal(mediaBodies[0].document.url, SONG_URL);
  assert.equal(mediaBodies[0].fileName, 'Joji - Sanctuary.mp3');
  assert.match(mediaBodies[0].caption, /Joji - Sanctuary/);
  assert.equal(bodies.some((body) => body.text), false);
});

test('.video sends the Gronka video and falls back to a document if the video send is refused', async () => {
  const asked = [];
  const gronka = gk((url, options) => { asked.push(options); return { lane: 'r2', files: [{ url: VIDEO_URL, filename: 'clip.mp4', type: 'video' }] }; });
  const client = media.createXjxMedia({ gronka, search: fakeSearch(), settings: {}, logger: { warn() {} } });
  const bodies = [];
  const sock = { async sendMessage(_chat, body) {
    bodies.push(body);
    if (body.video) throw new Error('video send not accepted');
    return { key: { id: 'sent' } };
  } };
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'm-video' } };
  const result = await client.downloadVideoCommand(sock, msg, { from: msg.key.remoteJid }, sample);
  assert.equal(result.via, 'Gronka');
  assert.equal(asked[0].mode, 'auto');
  const mediaBodies = bodies.filter((body) => body.video || body.document);
  assert.deepEqual(mediaBodies.map((body) => body.video ? 'video' : 'document'), ['video', 'document']);
  assert.equal(mediaBodies[0].video.url, VIDEO_URL);
  assert.equal(mediaBodies[1].document.url, VIDEO_URL);
});

test('without GRONKA_API_KEY .song and .video say so instead of trying anything else', async () => {
  const off = { enabled: false, async download() { throw new Error('must not be called'); } };
  const client = media.createXjxMedia({ gronka: off, search: fakeSearch(), settings: {}, logger: { warn() {} } });
  await assert.rejects(client.resolveAudioInput(sample), (e) => e.code === 'NOT_CONFIGURED' && /GRONKA_API_KEY/.test(e.userMessage));
  await assert.rejects(client.resolveVideoInput(sample), (e) => e.code === 'NOT_CONFIGURED');
});

test('.song and .video commands use XJX command handlers without local fallbacks or extra options', async () => {
  const commandMedia = fromBot('lib/downloads/xjx');
  const oldSong = commandMedia.downloadSongCommand;
  const oldVideo = commandMedia.downloadVideoCommand;
  const calls = [];
  commandMedia.downloadSongCommand = async (_sock, _msg, _extra, input) => {
    calls.push(['song', input]);
    return { sent: true };
  };
  commandMedia.downloadVideoCommand = async (_sock, _msg, _extra, input) => {
    calls.push(['video', input]);
    return { sent: true };
  };
  const song = fromBot('commands/song/index');
  const video = fromBot('commands/video/index');
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'm2' } };
  const extra = { from: msg.key.remoteJid, isOwner: false };
  const sock = { async sendMessage() { return {}; } };
  try {
    await song.execute(sock, msg, [sample], extra);
    await video.execute(sock, msg, [sample], extra);
    assert.deepEqual(calls, [['song', sample], ['video', sample]]);
    assert.equal(song.name, 'song');
    assert.equal(video.name, 'video');
    assert.equal(video.aliases.includes('ytv'), false);
  } finally {
    commandMedia.downloadSongCommand = oldSong;
    commandMedia.downloadVideoCommand = oldVideo;
  }
});

// ─── Gronka API (single source when GRONKA_API_KEY is set) ──────────────────
const { createGronka, titleFromFilename } = require(path.join(ROOT, 'lib/downloads/gronka'));
const KEY = 'gk_test1234_secretvalue';
const gronkaHttp = (responder) => {
  const calls = [];
  return { calls, http: { async post(url, body, options) { calls.push({ url, body, options }); return responder(url, body, options, calls.length - 1); } } };
};
const ok = (data, status = 200, headers = {}) => ({ status, data, headers });
const workerAudio = { lane: 'worker', files: [{ url: 'https://dl.gronka.dev/f/abc', filename: 'My Song.audio.m4a', kind: 'audio', size: 1234567 }] };

test('gronka: posts the link with the bearer key, split:false and the requested mode', async () => {
  const { http, calls } = gronkaHttp(() => ok(JSON.stringify(workerAudio)));
  const client = createGronka({ http, settings: { apiKey: KEY, baseUrl: 'https://api.example.test/' }, logger: { warn() {} } });
  assert.equal(client.enabled, true);
  const result = await client.download(sample, { mode: 'audio' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/download');
  assert.deepEqual(calls[0].body, { url: sample, mode: 'audio', split: false });
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(result.files[0].url, 'https://dl.gronka.dev/f/abc');
  assert.equal(titleFromFilename(result.files[0].filename), 'My Song');
});

test('gronka: tolerates the leading spaces long downloads send before the JSON', async () => {
  const { http } = gronkaHttp(() => ok(`          \n${JSON.stringify(workerAudio)}`));
  const client = createGronka({ http, settings: { apiKey: KEY }, logger: { warn() {} } });
  assert.equal((await client.download(sample)).files.length, 1);
});

test('gronka: an error inside a 200 body is raised, with a safe message', async () => {
  const body = JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'video duration exceeds the maximum allowed (60 minutes).' } });
  const { http } = gronkaHttp(() => ok(`   ${body}`));
  const client = createGronka({ http, settings: { apiKey: KEY }, logger: { warn() {} } });
  await assert.rejects(client.download(sample), (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.userMessage, /exceeds the maximum/);
    return true;
  });
});

test('gronka: 429 reports how long to wait; bad keys never echo the key', async () => {
  const limited = gronkaHttp(() => ok(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down', retryAfter: 42 } }), 429, { 'retry-after': '42' }));
  const client = createGronka({ http: limited.http, settings: { apiKey: KEY }, logger: { warn() {} } });
  await assert.rejects(client.download(sample), (error) => error.code === 'RATE_LIMITED' && error.retryAfter === 42 && /42s/.test(error.userMessage));

  const logs = [];
  const denied = gronkaHttp(() => ok(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: `bad ${KEY}` } }), 401));
  const strict = createGronka({ http: denied.http, settings: { apiKey: KEY }, logger: { warn: (m) => logs.push(m) } });
  await assert.rejects(strict.download(sample), (error) => {
    assert.equal(error.code, 'UNAUTHORIZED');
    assert.doesNotMatch(`${error.message} ${error.userMessage}`, new RegExp(KEY));
    return true;
  });
  assert.doesNotMatch(logs.join(' '), new RegExp(KEY));
});

test('gronka: separate video/audio parts, network errors and an unset key are refused loudly', async () => {
  const merge = gronkaHttp(() => ok(JSON.stringify({ lane: 'worker', merge: true, files: workerAudio.files })));
  await assert.rejects(createGronka({ http: merge.http, settings: { apiKey: KEY }, logger: { warn() {} } }).download(sample), (e) => e.code === 'NEEDS_MERGE');
  const down = { async post() { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } };
  await assert.rejects(createGronka({ http: down, settings: { apiKey: KEY }, logger: { warn() {} } }).download(sample), (e) => e.code === 'NETWORK_ERROR');
  const idle = gronkaHttp(() => ok('{}'));
  const off = createGronka({ http: idle.http, settings: {}, logger: { warn() {} } });
  assert.equal(off.enabled, false);
  await assert.rejects(off.download(sample), (e) => e.code === 'NOT_CONFIGURED');
  assert.equal(idle.calls.length, 0);
});

test('.song and .video use Gronka as the ONLY source when it is enabled (no provider chain behind it)', async () => {
  const asked = [];
  const gronka = {
    enabled: true,
    async download(url, options) {
      asked.push({ url, options });
      return options.mode === 'audio'
        ? workerAudio
        : { lane: 'direct', files: [{ url: 'https://video.twimg.com/clip.mp4', filename: '', type: 'video' }] };
    },
  };
  const client = media.createXjxMedia({ gronka, settings: {}, logger: { warn() {} } });
  const audio = await client.resolveAudioInput(sample, { query: 'x' });
  assert.equal(audio.provider, 'Gronka');
  assert.equal(audio.download, 'https://dl.gronka.dev/f/abc');
  const video = await client.resolveVideoInput(sample);
  assert.equal(video.provider, 'Gronka');
  assert.equal(video.download, 'https://video.twimg.com/clip.mp4');
  assert.deepEqual(asked.map((a) => a.options.mode), ['audio', 'auto']);

  // A Gronka failure surfaces as is — nothing else is tried.
  const broken = { enabled: true, async download() { throw Object.assign(new Error('gronka NOT_FOUND'), { code: 'NOT_FOUND', userMessage: 'That video is gone.' }); } };
  const strict = media.createXjxMedia({ gronka: broken, settings: {}, logger: { warn() {} } });
  await assert.rejects(strict.resolveAudioInput(sample), (e) => e.userMessage === 'That video is gone.');
  assert.equal(media.friendlyError(Object.assign(new Error('x'), { userMessage: 'That video is gone.' })), '❌ That video is gone.');
});

test('gronka health: ok, down, timeout and not-set are told apart', async () => {
  const get = (responder) => ({ http: { async get(url, options) { return responder(url, options); } } });
  const ok = createGronka({ ...get(() => ({ status: 200, data: '  {"ok":true}' })), settings: { apiKey: KEY } });
  const good = await ok.health();
  assert.equal(good.state, 'ok');
  const bad = createGronka({ ...get(() => ({ status: 503, data: '' })), settings: { apiKey: KEY } });
  assert.deepEqual({ state: (await bad.health()).state, reason: (await bad.health()).reason }, { state: 'down', reason: 'HTTP 503' });
  const slow = createGronka({ ...get(() => { throw Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' }); }), settings: { apiKey: KEY } });
  assert.equal((await slow.health()).reason, 'timeout');
  const unset = createGronka({ ...get(() => { throw new Error('must not be called'); }), settings: {} });
  assert.equal((await unset.health()).state, 'not-set');
});
