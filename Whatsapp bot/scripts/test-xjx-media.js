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

const media = require(path.join(ROOT, 'utils/xjxMedia'));
const constants = media.constants;
const noWait = async () => {};
const sample = 'https://youtu.be/dQw4w9WgXcQ';
const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const fromBot = (name) => require(path.join(ROOT, name));

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function fakeHttp(responder) {
  const calls = [];
  return {
    calls,
    http: {
      async get(url, options = {}) {
        calls.push({ url, options });
        return responder(url, options, calls.length - 1);
      },
    },
  };
}

test('audio follows XJX provider order and succeeds on the keyless Hector URL fallback', async () => {
  const { http, calls } = fakeHttp(async (url, options) => {
    if (url === constants.HECTOR_WORKER_API) {
      assert.equal(options.params.url, canonical);
      return { data: { audio: 'https://cdn.example.org/song.mp3', title: 'Remote Song' } };
    }
    return { data: { success: false, status: false } };
  });
  const client = media.createXjxMedia({ http, settings: {}, logger: { warn() {} }, wait: noWait });
  const hit = await client.resolveAudio(sample, { query: 'Artist Track' });
  assert.equal(hit.provider, 'Hector');
  assert.equal(hit.download, 'https://cdn.example.org/song.mp3');
  assert.deepEqual(calls.map((call) => call.url), [
    `${constants.KNIGHTBOT_API}/ytaudio`,
    constants.APISSUPREME_AUDIO_API,
    constants.APIX_AUDIO_API,
    constants.HECTOR_WORKER_API,
  ]);
  assert.equal(calls[0].options.params.apikey, undefined);
  assert.equal(calls[1].options.params.apikey, undefined);
  assert.equal(calls[2].options.params.key, undefined);
});

test('KnightBot uses XJX retry count and delay before the next resolver', async () => {
  let attempts = 0;
  const waits = [];
  const client = media.createXjxMedia({
    http: { async get(url, options) {
      attempts++;
      assert.equal(url, `${constants.KNIGHTBOT_API}/ytaudio`);
      assert.equal(options.params.url, canonical);
      if (attempts < 3) throw new Error('temporary failure');
      return { data: { success: true, result: { download: 'https://cdn.example.org/retried.mp3' } } };
    } },
    settings: {},
    logger: { warn() {} },
    wait: async (ms) => waits.push(ms),
  });
  const hit = await client.resolveAudio(sample);
  assert.equal(hit.provider, 'KnightBot');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('XJX reaches Hector search only after its URL resolvers fail', async () => {
  const { http, calls } = fakeHttp(async (url, options) => {
    if (url === constants.HECTOR_WORKER_API && options.params.url === 'Artist Track') {
      return { data: { audio: 'https://cdn.example.org/search-song.mp3', title: 'Search result' } };
    }
    return { data: { success: false, status: false } };
  });
  const client = media.createXjxMedia({ http, settings: {}, logger: { warn() {} }, wait: noWait });
  const hit = await client.resolveAudioInput(canonical, { query: 'Artist Track' });
  assert.equal(hit.provider, 'Hector');
  assert.equal(hit.download, 'https://cdn.example.org/search-song.mp3');
  assert.deepEqual(calls.map((call) => call.url), [
    `${constants.KNIGHTBOT_API}/ytaudio`,
    constants.APISSUPREME_AUDIO_API,
    constants.APIX_AUDIO_API,
    constants.HECTOR_WORKER_API,
    constants.HECTOR_WORKER_API,
  ]);
  assert.equal(calls[3].options.params.url, canonical);
  assert.equal(calls[4].options.params.url, 'Artist Track');
});

test('Apix fallback URL is accepted only after earlier XJX providers fail', async () => {
  const { http, calls } = fakeHttp(async (url) => {
    if (url === constants.APIX_AUDIO_API) {
      return { data: {
        success: true,
        proxyURL: 'https://proxy.example.org/audio.mp3',
        directURL: 'https://cdn.example.org/audio.mp3',
        title: 'Apix title',
      } };
    }
    return { data: { success: false, status: false } };
  });
  const client = media.createXjxMedia({ http, settings: {}, logger: { warn() {} }, wait: noWait });
  const hit = await client.resolveAudio(sample, { query: 'Artist Track' });
  assert.equal(hit.provider, 'Apix');
  assert.equal(hit.download, 'https://proxy.example.org/audio.mp3');
  assert.equal(hit.fallback, 'https://cdn.example.org/audio.mp3');
  assert.deepEqual(calls.map((call) => call.url), [
    `${constants.KNIGHTBOT_API}/ytaudio`,
    constants.APISSUPREME_AUDIO_API,
    constants.APIX_AUDIO_API,
  ]);
});

test('missing provider keys are omitted; configured credentials never enter logs or errors', async () => {
  const secret = 'fixture-secret-do-not-log';
  const messages = [];
  const { http } = fakeHttp(async (url, options) => {
    if (url.endsWith('/ytaudio') || url === constants.APISSUPREME_AUDIO_API) {
      assert.equal(options.params.apikey, secret);
      throw Object.assign(new Error(`request rejected for apikey=${secret}`), { response: { status: 403 } });
    }
    if (url === constants.APIX_AUDIO_API) {
      assert.equal(options.params.key, secret);
      throw Object.assign(new Error(`request rejected for key=${secret}`), { response: { status: 403 } });
    }
    return { data: {} };
  });
  const client = media.createXjxMedia({
    http,
    settings: { knightbotApiKey: secret, apissupremeApiKey: secret, apixKey: secret },
    logger: { warn: (text) => messages.push(String(text)) },
    wait: noWait,
  });
  await assert.rejects(client.resolveAudio(sample), (error) => {
    assert.equal(error.code, 'NO_MEDIA');
    assert.ok(error.attempts.every((attempt) => !JSON.stringify(attempt).includes(secret)));
    return true;
  });
  assert.ok(messages.length > 0);
  assert.ok(messages.every((line) => !line.includes(secret)));
});

test('video follows XJX KnightBot then Keithsite at its 480p default', async () => {
  const { http, calls } = fakeHttp(async (url, options) => {
    if (url === constants.KEITHSITE_VIDEO_API) {
      assert.equal(options.params.url, canonical);
      assert.equal(options.params.format, 'mp4');
      return { data: { status: true, result: 'https://cdn.example.org/video.mp4', title: 'Video' } };
    }
    assert.equal(options.params.format, '480p');
    return { data: { success: false } };
  });
  const client = media.createXjxMedia({ http, settings: {}, logger: { warn() {} }, wait: noWait });
  const hit = await client.resolveVideo(sample);
  assert.equal(hit.provider, 'Keithsite');
  assert.equal(hit.download, 'https://cdn.example.org/video.mp4');
  assert.deepEqual(calls.map((call) => call.url), [
    `${constants.KNIGHTBOT_API}/ytmp4`,
    constants.KEITHSITE_VIDEO_API,
  ]);
});

test('unsafe API media URLs are rejected and the next resolver is tried', async () => {
  const { http } = fakeHttp(async (url) => {
    if (url.endsWith('/ytaudio')) {
      return { data: { success: true, result: { download: 'http://127.0.0.1/private.mp3' } } };
    }
    if (url === constants.APISSUPREME_AUDIO_API) {
      return { data: { status: true, downloadUrl: 'https://cdn.example.org/safe.mp3' } };
    }
    throw new Error('unexpected provider call');
  });
  const client = media.createXjxMedia({ http, settings: {}, logger: { warn() {} }, wait: noWait });
  const hit = await client.resolveAudio(sample);
  assert.equal(hit.provider, 'ApisSupreme');
  assert.equal(hit.download, 'https://cdn.example.org/safe.mp3');
});

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

test('.song sends one artist-titled MP3 document at the configured high bitrate', async () => {
  const { http } = fakeHttp(async (url, options) => {
    assert.equal(url, `${constants.KNIGHTBOT_API}/ytaudio`);
    assert.equal(options.params.url, sample);
    assert.equal(options.params.format, '320kbps');
    return { data: { success: true, result: { download: 'https://cdn.example.org/song.mp3', title: 'Provider title' } } };
  });
  const client = media.createXjxMedia({
    http,
    search: async ({ videoId }) => ({
      title: 'Joji - Sanctuary (Official Video)',
      author: { name: 'Joji - Topic' },
      videoId,
    }),
    settings: { audioFormat: '320kbps' },
    logger: { warn() {} }, wait: noWait,
  });
  const bodies = [];
  const sock = { async sendMessage(_chat, body) { bodies.push(body); return { key: { id: 'sent' } }; } };
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'm-song' } };
  const result = await client.downloadSongCommand(sock, msg, { from: msg.key.remoteJid }, sample);
  assert.equal(result.via, 'KnightBot');
  assert.equal(result.artist, 'Joji');
  assert.equal(result.title, 'Sanctuary');
  const mediaBodies = bodies.filter((body) => body.audio || body.document);
  assert.equal(mediaBodies.length, 1);
  assert.equal(mediaBodies[0].audio, undefined);
  assert.equal(mediaBodies[0].document.url, 'https://cdn.example.org/song.mp3');
  assert.equal(mediaBodies[0].fileName, 'Joji - Sanctuary.mp3');
  assert.match(mediaBodies[0].caption, /Joji - Sanctuary/);
  assert.equal(bodies.some((body) => body.text), false);
});

test('XJX .video sends the resolved video and falls back to a document if needed', async () => {
  const { http } = fakeHttp(async (url, options) => {
    assert.equal(url, `${constants.KNIGHTBOT_API}/ytmp4`);
    assert.equal(options.params.format, '480p');
    return { data: { success: true, result: { download: 'https://cdn.example.org/video.mp4', title: 'Provider title' } } };
  });
  const client = media.createXjxMedia({
    http,
    search: async ({ videoId }) => ({ title: 'Selected video', videoId }),
    settings: {},
    logger: { warn() {} }, wait: noWait,
  });
  const bodies = [];
  const sock = { async sendMessage(_chat, body) {
    bodies.push(body);
    if (body.video) throw new Error('video send not accepted');
    return { key: { id: 'sent' } };
  } };
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'm-video' } };
  const result = await client.downloadVideoCommand(sock, msg, { from: msg.key.remoteJid }, sample);
  assert.equal(result.via, 'KnightBot');
  const mediaBodies = bodies.filter((body) => body.video || body.document);
  assert.deepEqual(mediaBodies.map((body) => body.video ? 'video' : 'document'), ['video', 'document']);
  assert.equal(mediaBodies[0].video.url, 'https://cdn.example.org/video.mp4');
  assert.equal(mediaBodies[1].document.url, 'https://cdn.example.org/video.mp4');
});

test('video URL send failure falls back to XJX document delivery without a local download', async () => {
  const { http } = fakeHttp(async (url) => {
    if (url.endsWith('/ytmp4')) {
      return { data: { success: true, result: { download: 'https://cdn.example.org/video.mp4', title: 'Provider title' } } };
    }
    throw new Error(`unexpected request ${url}`);
  });
  const client = media.createXjxMedia({
    http,
    search: async ({ videoId }) => ({ title: 'Selected title', author: { name: 'Artist' }, duration: { seconds: 60 }, videoId }),
    settings: {},
    logger: { warn() {} }, wait: noWait,
  });
  const bodies = [];
  const sock = {
    async sendMessage(_chat, body) {
      bodies.push(body);
      if (body.video) throw new Error('video send not accepted');
      return { key: { id: 'sent' } };
    },
  };
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'm1' } };
  const result = await client.downloadAndSend(sock, msg, { from: msg.key.remoteJid }, {
    url: sample, query: sample, kind: 'video', height: 720,
  });
  assert.equal(result.sent, true);
  assert.equal(result.via, 'KnightBot');
  const mediaBodies = bodies.filter((body) => body.video || body.document);
  assert.deepEqual(mediaBodies.map((body) => body.video ? 'video' : 'document'), ['video', 'document']);
  assert.equal(mediaBodies[0].video.url, 'https://cdn.example.org/video.mp4');
  assert.equal(mediaBodies[1].document.url, 'https://cdn.example.org/video.mp4');
});

test('.song and .video commands use XJX command handlers without local fallbacks or extra options', async () => {
  const commandMedia = fromBot('utils/xjxMedia');
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
  const song = fromBot('commands/media/song');
  const video = fromBot('commands/media/video');
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
