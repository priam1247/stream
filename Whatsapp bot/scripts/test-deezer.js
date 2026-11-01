'use strict';

// No external requests or real accounts: all HTTP and media are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deezer-test-'));
const ROOT = createBotFixture(TEMP);
process.chdir(TEMP);
const dz = require(path.join(ROOT, 'utils/deezer'));
const TRACK = '3135553';
const ARL = 'SYNTHETIC_FAKE_ARL_123456789';
const LIC = 'SYNTHETIC_LICENSE';
const TOKEN = 'SYNTHETIC_TRACK_TOKEN';
const CDN = 'https://e-cdns-proxy-a.dzcdn.net/media/example';
const row = { id: Number(TRACK), title: 'Example', duration: 200, artist: { name: 'Artist' }, album: { title: 'Album' } };

test.after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

function encryptStripes(plain) {
  // An independent OpenSSL implementation supplies a reference vector;
  // the production decoder itself does not need the legacy provider.
  const script = `const c=require('node:crypto');const data=require('node:fs').readFileSync(0);const key=Buffer.from(process.argv[1],'hex');const out=[];for(let i=0;i<data.length;i+=2048){const b=data.subarray(i,i+2048);if((i/2048)%3===0&&b.length===2048){const x=c.createCipheriv('bf-cbc',key,Buffer.from('0001020304050607','hex'));x.setAutoPadding(false);out.push(Buffer.concat([x.update(b),x.final()]));}else out.push(b)}process.stdout.write(Buffer.concat(out));`;
  return execFileSync(process.execPath, ['--openssl-legacy-provider', '-e', script, dz.songKey(TRACK).toString('hex')], { input: plain, maxBuffer: 1024 * 1024 });
}

function fakeService(encrypted, { premium = false, fail320 = false, arl = ARL, mediaUrl = CDN } = {}) {
  const calls = [];
  const http = {
    async get(url, options) {
      calls.push({ method: 'get', url, options });
      assert.equal(options.maxRedirects, 0);
      if (url.includes('/search/track?')) return { status: 200, data: { data: [row] } };
      if (url === `https://api.deezer.com/track/${TRACK}`) return { status: 200, data: { ...row, track_token: TOKEN } };
      if (url.startsWith('https://www.deezer.com/ajax/gw-light.php')) {
        assert.equal(options.headers.Cookie, `arl=${arl}; comeback=1`);
        return { status: 200, data: { results: { USER: { OPTIONS: { license_token: LIC, web_sound_quality: { lossless: premium } } } } } };
      }
      if (url === CDN) {
        assert.equal(options.headers.Cookie, undefined);
        // Deliberately split across stripe boundaries.
        return { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(encrypted.length) },
          data: Readable.from([encrypted.subarray(0, 7), encrypted.subarray(7, 2500), encrypted.subarray(2500, 7001), encrypted.subarray(7001)]) };
      }
      throw new Error('unexpected GET');
    },
    async post(url, body, options) {
      calls.push({ method: 'post', url, body, options });
      assert.equal(url, 'https://media.deezer.com/v1/get_url');
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(body.license_token, LIC);
      assert.deepEqual(body.track_tokens, [TOKEN]);
      assert.equal(body.media[0].type, 'FULL');
      const fmt = body.media[0].formats[0];
      assert.equal(fmt.cipher, 'BF_CBC_STRIPE');
      if (fail320 && fmt.format === 'MP3_320') return { status: 200, data: { data: [{ errors: [{ message: 'unavailable' }] }] } };
      return { status: 200, data: { data: [{ media: [{ cipher: { type: 'BF_CBC_STRIPE' }, sources: [{ url: mediaUrl }] }] }] } };
    },
  };
  return { http, calls };
}

function sample() {
  const data = Buffer.alloc(2048 * 7 + 37);
  for (let i = 0; i < data.length; i++) data[i] = (i * 29 + 17) % 256;
  Buffer.from('ID3').copy(data);
  // Exercise real trailing zeros where a padding-aware decoder might lose data.
  data.fill(0, 2048 - 5, 2048);
  data.fill(0, 2048 * 4 - 8, 2048 * 4);
  return data;
}

test('only real Deezer track links and safe HTTPS CDN hosts are accepted', () => {
  assert.equal(dz.trackId('https://www.deezer.com/en/track/3135553?utm_source=x'), TRACK);
  assert.equal(dz.trackId('deezer.com/track/3135553'), TRACK);
  for (const bad of ['https://deezer.com.evil.test/track/3135553', 'https://evil.test/?next=https://deezer.com/track/3135553',
    'https://user@deezer.com/track/3135553', 'https://deezer.com/album/3135553', 'https://deezer.com:444/track/3135553']) assert.equal(dz.trackId(bad), null);
  assert.equal(dz.validMediaUrl(CDN), true);
  for (const bad of ['http://dzcdn.net/test', 'https://dzcdn.net.evil.test/test', 'https://127.0.0.1/a', 'https://user@dzcdn.net/a']) assert.equal(dz.validMediaUrl(bad), false);
});

test('share links follow only HTTPS Deezer redirects, without account cookies', async () => {
  const calls = [];
  const http = { async get(url, options) {
    calls.push(url);
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.headers.Cookie, undefined);
    return { status: 302, headers: { location: url.includes('/good') ? 'https://www.deezer.com/en/track/3135553' : 'https://evil.test/track/3135553' }, data: Readable.from([]) };
  } };
  const client = dz.createClient({ http, arl: ARL });
  assert.equal(await client.resolveTrackId('https://link.deezer.com/good'), TRACK);
  await assert.rejects(client.resolveTrackId('https://link.deezer.com/bad'), { code: 'DEEZER_TRACK' });
  assert.equal(calls.length, 2);
});

test('streaming decoder matches independent Blowfish stripes and preserves partial and zero-filled tails', async () => {
  const plain = sample();
  const encrypted = encryptStripes(plain);
  const chunks = [];
  const sink = new (require('node:stream').Writable)({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  await pipeline(Readable.from([encrypted.subarray(0, 5), encrypted.subarray(5, 2050), encrypted.subarray(2050)]), await dz.stripeDecoder(TRACK, plain.length), sink);
  assert.deepEqual(Buffer.concat(chunks), plain);
});

test('search and full download keep credentials scoped and stream valid MP3 bytes', async () => {
  const plain = sample();
  const fake = fakeService(encryptStripes(plain));
  const client = dz.createClient({ http: fake.http, arl: ARL });
  assert.deepEqual((await client.search('artist example'))[0], { ...row, id: TRACK, artist: 'Artist', album: 'Album', isrc: '', thumbnail: '', url: `https://www.deezer.com/track/${TRACK}` });
  const dest = path.join(TEMP, 'track.mp3');
  const result = await client.download(TRACK, dest);
  assert.deepEqual(fs.readFileSync(dest), plain);
  assert.equal(result.title, 'Example');
  assert.equal(result.trackToken, undefined);
  const jsonCalls = fake.calls.filter((c) => c.url.startsWith('https://api.deezer.com'));
  assert.ok(jsonCalls.every((c) => !c.options.headers.Cookie));
  assert.equal(fake.calls.find((c) => c.method === 'post').body.media[0].formats[0].format, 'MP3_128');
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
});

test('decrypted full-track fixture is probed, tagged and delivered by the real command', async (t) => {
  const ffmpeg = require(path.join(ROOT, 'utils/ffmpeg'));
  if (!ffmpeg.works()) return t.skip('ffmpeg unavailable');
  const source = path.join(TEMP, 'real-audio.mp3');
  execFileSync(ffmpeg(), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libmp3lame', '-b:a', '128k', source]);
  const fake = fakeService(encryptStripes(fs.readFileSync(source)));
  const origGet = fake.http.get;
  fake.http.get = async (url, opts) => {
    const response = await origGet(url, opts);
    if (url === `https://api.deezer.com/track/${TRACK}`) {
      response.data.duration = 3;
      response.data.title = '世界 Song';
      response.data.artist = { name: 'Artist' };
    }
    return response;
  };
  const config = require(path.join(ROOT, 'config'));
  const originalArl = config.deezer.arl;
  const originalClient = dz.createClient;
  config.deezer.arl = ARL;
  dz.createClient = () => originalClient({ http: fake.http, arl: ARL });
  const transfer = require(path.join(ROOT, 'utils/mediaTransfer'));
  const command = require(path.join(ROOT, 'commands/media/deezer'));
  let delivered, staged;
  const sock = { async sendMessage(_chat, body) {
    if (body.document) { staged = body.document.url; delivered = fs.readFileSync(staged); }
  } };
  try {
    await command.execute(sock, { key: { remoteJid: 'self@s.whatsapp.net', id: '1' }, message: {} }, [`https://www.deezer.com/track/${TRACK}`], { from: 'self@s.whatsapp.net' });
    assert.ok(delivered?.length > 10_000, 'audio was delivered');
    assert.equal(transfer.sniff(delivered).ext, 'mp3');
    assert.deepEqual(transfer.readId3(delivered), { title: '世界 Song', artist: 'Artist', album: 'Album' });
    assert.equal(fs.existsSync(staged), false);
  } finally {
    config.deezer.arl = originalArl;
    dz.createClient = originalClient;
  }
});

test('mismatched track metadata is rejected before authentication and media download', async () => {
  const fake = fakeService(encryptStripes(sample()));
  const expected = { title: 'Example', artist: 'Artist', duration: 200, isrc: 'USABC1234567' };
  await assert.rejects(dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, 'mismatch.mp3'), { expected }), { code: 'BAD_SOURCE' });
  assert.deepEqual(fake.calls.map((c) => c.url), [`https://api.deezer.com/track/${TRACK}`]);
});

test('premium tries 320, then 128 only when that format is unavailable', async () => {
  const fake = fakeService(encryptStripes(sample()), { premium: true, fail320: true });
  await dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, 'premium.mp3'));
  assert.deepEqual(fake.calls.filter((c) => c.method === 'post').map((c) => c.body.media[0].formats[0].format), ['MP3_320', 'MP3_128']);
});

test('media redirects stay on trusted HTTPS hosts without credentials', async () => {
  const encrypted = encryptStripes(sample());
  const fake = fakeService(encrypted);
  const get = fake.http.get;
  const visited = [];
  fake.http.get = async (url, options) => {
    if (url === CDN || url === 'https://edge.dzcdn.net/media') {
      visited.push(url);
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.headers.Cookie, undefined);
      if (url === CDN) return { status: 302, headers: { location: 'https://edge.dzcdn.net/media' }, data: Readable.from([]) };
      return get(CDN, options);
    }
    return get(url, options);
  };
  await dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, 'redirect.mp3'));
  assert.deepEqual(visited, [CDN, 'https://edge.dzcdn.net/media']);

  const bad = fakeService(encrypted);
  const original = bad.http.get;
  bad.http.get = async (url, options) => url === CDN
    ? { status: 302, headers: { location: 'https://evil.test/steal' }, data: Readable.from([]) }
    : original(url, options);
  await assert.rejects(dz.createClient({ http: bad.http, arl: ARL }).download(TRACK, path.join(TEMP, 'bad-redirect.mp3')), { code: 'DEEZER_UNAVAILABLE' });
  assert.equal(bad.calls.some((c) => c.url.includes('evil.test')), false);
});

test('stream limits and interruptions remove partially written files', async () => {
  const encrypted = encryptStripes(sample());
  const limited = fakeService(encrypted);
  const original = limited.http.get;
  limited.http.get = async (url, options) => {
    const response = await original(url, options);
    if (url === CDN) delete response.headers['content-length'];
    return response;
  };
  const tooLarge = path.join(TEMP, 'stream-too-large.mp3');
  await assert.rejects(dz.createClient({ http: limited.http, arl: ARL }).download(TRACK, tooLarge, { maxBytes: 1000 }), { code: 'TOO_BIG' });
  assert.equal(fs.existsSync(tooLarge), false);

  const broken = fakeService(encrypted);
  const get = broken.http.get;
  broken.http.get = async (url, options) => {
    const response = await get(url, options);
    if (url === CDN) {
      response.data.destroy();
      response.data = Readable.from((async function* () { yield encrypted.subarray(0, 4096); throw new Error('interrupted'); })());
    }
    return response;
  };
  const partial = path.join(TEMP, 'interrupted.mp3');
  await assert.rejects(dz.createClient({ http: broken.http, arl: ARL }).download(TRACK, partial), { code: 'DEEZER_NETWORK' });
  assert.equal(fs.existsSync(partial), false);
});

test('invalid cookies, media URLs, redirects, limits, and existing destinations fail safely', async () => {
  const plain = sample();
  const encrypted = encryptStripes(plain);
  const invalid = fakeService(encrypted, { mediaUrl: 'https://example.test/steal' });
  await assert.rejects(dz.createClient({ http: invalid.http, arl: ARL }).download(TRACK, path.join(TEMP, 'invalid.mp3')), { code: 'DEEZER_UNAVAILABLE' });
  assert.equal(invalid.calls.some((c) => c.url.includes('example.test')), false);
  const wrong = dz.createClient({ http: fakeService(encrypted).http, arl: 'secret\r\nCookie: stolen' });
  await assert.rejects(wrong.session(), (e) => e.code === 'DEEZER_AUTH' && !e.message.includes('secret'));
  const limitFile = path.join(TEMP, 'large.mp3');
  await assert.rejects(dz.createClient({ http: fakeService(encrypted).http, arl: ARL }).download(TRACK, limitFile, { maxBytes: 1000 }), { code: 'TOO_BIG' });
  assert.equal(fs.existsSync(limitFile), false);
  await assert.rejects(dz.createClient({ http: fakeService(encrypted).http, arl: ARL }).download(TRACK, limitFile, { maxSeconds: 10 }), { code: 'TOO_LONG' });
  const existing = path.join(TEMP, 'existing.mp3');
  fs.writeFileSync(existing, 'preserve');
  await assert.rejects(dz.createClient({ http: fakeService(encrypted).http, arl: ARL }).download(TRACK, existing), { code: 'DEEZER_NETWORK' });
  assert.equal(fs.readFileSync(existing, 'utf8'), 'preserve');
  const redirect = { get: async () => ({ status: 302, data: {} }) };
  await assert.rejects(dz.createClient({ http: redirect, arl: ARL }).session(), { code: 'DEEZER_NETWORK' });
});
