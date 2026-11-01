'use strict';

// Offline regression cases for parsing, security, and file-level failover.
// The separate test-knight-live.js exercises the actual internet provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knight-provider-test-'));
const root = createBotFixture(temp);
process.chdir(temp);
process.env.FAKE_YTDLP = 'offline';
const fromBot = (name) => require(path.join(root, name));
const knight = fromBot('utils/knightYouTube');
const providers = fromBot('utils/downloadProviders');
const yt1d = fromBot('utils/yt1d');
const axios = require(path.join(root, 'node_modules/axios'));
const sample = 'https://www.youtube.com/watch?v=H5eLnIhRpWg';
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

function httpFor(data) {
  return { async get(url, opts) {
    assert.equal(url, knight.ENDPOINT);
    assert.equal(opts.params.url, sample);
    assert.equal(opts.headers.Cookie, undefined);
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(opts.maxRedirects, 0);
    return { status: 200, data };
  } };
}

test('Hector audio and requested video quality are read from the public response', async () => {
  const data = { title: 'Licensed fixture', audio: 'https://media.example.org/a.mp3',
    videos: { '360': 'https://media.example.org/v360.mp4', '720p': 'https://media.example.org/v720.mp4' } };
  const client = knight.createClient({ http: httpFor(data) });
  const audio = await client.resolve(sample, { kind: 'audio' });
  assert.equal(audio.provider, 'Hector');
  assert.equal(audio.url, data.audio);
  assert.equal(audio.title, data.title);
  const video = await client.resolve(sample, { kind: 'video', quality: 480 });
  assert.equal(video.quality, 360);
  assert.equal(video.url, data.videos['360']);
});

test('non-YouTube inputs, internal hosts and IP-bound Googlevideo results are refused', async () => {
  assert.equal(knight.usableUrl('https://r1.googlevideo.com/videoplayback?sig=fixture'), null);
  assert.equal(knight.usableUrl('https://www.youtube.com/videoplayback?a=b'), null);
  for (const url of ['http://media.example.org/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://user:pass@media.example.org/a']) {
    assert.equal(knight.usableUrl(url), null);
  }
  const client = knight.createClient({ http: httpFor({ audio: 'https://r1.googlevideo.com/videoplayback' }) });
  await assert.rejects(client.resolve(sample), { code: 'NO_FORMATS' });
  await assert.rejects(client.resolve('https://evil.example/watch?v=H5eLnIhRpWg'), { code: 'UNSUPPORTED_URL' });
});

test('whole media files are checked for tracks, duration and safe cleanup', async () => {
  const hit = { url: 'https://media.example.org/a.mp3', provider: 'fixture' };
  const base = path.join(temp, 'out');
  const transfer = async (_url, file) => {
    fs.writeFileSync(file, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16000)]));
    return { bytes: 16003 };
  };
  const inspect = async () => ({ probed: true, hasAudio: true, hasVideo: false, duration: 60 });
  const result = await providers.fetchCandidate(hit, { outBase: base, kind: 'audio', maxBytes: 20000, maxSeconds: 120, expectedSeconds: 60, transfer, inspect });
  assert.equal(result.sniff.ext, 'mp3');
  assert.equal(fs.existsSync(result.file), true);
  fs.rmSync(result.file);
  for (const options of [
    { maxSeconds: 30, expectedSeconds: 0, code: 'TOO_LONG' },
    { maxSeconds: 120, expectedSeconds: 100, code: 'BAD_SOURCE' },
    { maxSeconds: 120, expectedSeconds: 0, kind: 'video', code: 'BAD_SOURCE' },
  ]) {
    await assert.rejects(providers.fetchCandidate(hit, { outBase: base, kind: 'audio', maxBytes: 20000, transfer, inspect, ...options }), { code: options.code });
    assert.deepEqual(fs.readdirSync(temp).filter((name) => name.startsWith('out_remote_')), []);
  }
  await assert.rejects(providers.fetchCandidate({ url: 'https://127.0.0.1/file' }, { outBase: base, maxBytes: 20000 }), { code: 'BAD_SOURCE' });
});

test('a provider with an unusable file does not prevent trying another provider or mirror', async () => {
  const previousYt1d = yt1d.resolveYt1d;
  const previousPost = axios.post;
  process.env.YT1D_BASE_URL = 'http://fixture.invalid';
  process.env.COBALT_INSTANCES = 'https://one.example,https://two.example';
  yt1d.resolveYt1d = async () => ({ provider: 'yt1d', url: 'https://media.example.org/dead', ext: 'mp3' });
  axios.post = async (url) => ({ status: 200, data: { status: 'tunnel',
    url: url.startsWith('https://one.') ? 'https://media.example.org/bad' : 'https://media.example.org/good', filename: 'fixture.mp3' } });
  const tried = [];
  try {
    const hit = await providers.resolveMedia(sample, {
      only: ['yt1d', 'cobalt'], kind: 'audio', timeoutMs: 2000,
      accept: async (candidate) => {
        tried.push(new URL(candidate.url).pathname);
        if (!candidate.url.endsWith('/good')) throw Object.assign(new Error('private signed URL fixture'), { code: 'BAD_SOURCE' });
        return { file: '/fixture/verified.mp3' };
      },
    });
    assert.deepEqual(tried, ['/dead', '/bad', '/good']);
    assert.equal(hit.file, '/fixture/verified.mp3');
    assert.match(hit.provider, /^cobalt/);
  } finally {
    yt1d.resolveYt1d = previousYt1d;
    axios.post = previousPost;
    delete process.env.YT1D_BASE_URL;
    delete process.env.COBALT_INSTANCES;
  }
});

test('a duration limit is terminal and cannot be bypassed by another source', async () => {
  const previous = yt1d.resolveYt1d;
  process.env.YT1D_BASE_URL = 'http://fixture.invalid';
  yt1d.resolveYt1d = async () => ({ provider: 'yt1d', url: 'https://media.example.org/long', ext: 'mp3' });
  let calls = 0;
  try {
    await assert.rejects(providers.resolveMedia(sample, {
      only: ['yt1d'], accept: async () => { calls++; throw Object.assign(new Error('long'), { code: 'TOO_LONG' }); },
    }), { code: 'TOO_LONG' });
    assert.equal(calls, 1);
  } finally { yt1d.resolveYt1d = previous; delete process.env.YT1D_BASE_URL; }
});
