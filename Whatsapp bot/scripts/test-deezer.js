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
const CSRF = 'SYNTHETIC_CSRF';
const SID = 'SYNTHETIC_SESSION';
const MEDIA = 'https://media.deezer.com/v1/get_url';
const GATEWAY = 'https://www.deezer.com/ajax/gw-light.php';
const CDN = 'https://e-cdns-proxy-a.dzcdn.net/media/example';
const row = { id: Number(TRACK), title: 'Example', duration: 200, artist: { name: 'Artist' }, album: { title: 'Album' } };

test.after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

function encryptStripes(plain) {
  // An independent OpenSSL implementation supplies a reference vector;
  // the production decoder itself does not need the legacy provider.
  const script = `const c=require('node:crypto');const data=require('node:fs').readFileSync(0);const key=Buffer.from(process.argv[1],'hex');const out=[];for(let i=0;i<data.length;i+=2048){const b=data.subarray(i,i+2048);if((i/2048)%3===0&&b.length===2048){const x=c.createCipheriv('bf-cbc',key,Buffer.from('0001020304050607','hex'));x.setAutoPadding(false);out.push(Buffer.concat([x.update(b),x.final()]));}else out.push(b)}process.stdout.write(Buffer.concat(out));`;
  return execFileSync(process.execPath, ['--openssl-legacy-provider', '-e', script, dz.songKey(TRACK).toString('hex')], { input: plain, maxBuffer: 1024 * 1024 });
}

function fakeService(encrypted, {
  premium = false, high = false, fail320 = false, arl = ARL, mediaUrl = CDN,
  userId = '12345', sessionId = SID, csrf = CSRF, license = LIC, loginError = [],
  gatewayId = TRACK, token = TOKEN, gatewayError = [], mediaErrors = [], publicToken,
} = {}) {
  const calls = [];
  const http = {
    async get(url, options) {
      calls.push({ method: 'get', url, options });
      assert.equal(options.maxRedirects, 0);
      if (url.includes('/search/track?')) {
        assert.equal(options.headers.Cookie, undefined);
        return { status: 200, data: { data: [row] } };
      }
      if (url === `https://api.deezer.com/track/${TRACK}`) {
        assert.equal(options.headers.Cookie, undefined);
        // The public API normally provides metadata, not an account token.
        return { status: 200, data: { ...row, ...(publicToken ? { track_token: publicToken } : {}) } };
      }
      if (url.startsWith(`${GATEWAY}?`)) {
        assert.equal(new URL(url).searchParams.get('method'), 'deezer.getUserData');
        assert.equal(options.headers.Cookie, `arl=${arl}; comeback=1`);
        return { status: 200, data: { error: loginError, results: {
          checkForm: csrf, SESSION_ID: sessionId,
          USER: { USER_ID: userId, OPTIONS: { license_token: license, web_sound_quality: { high, lossless: premium } } },
        } } };
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
      assert.equal(options.maxRedirects, 0);
      if (url.startsWith(`${GATEWAY}?`)) {
        const params = new URL(url).searchParams;
        assert.equal(params.get('method'), 'song.getData');
        assert.equal(params.get('input'), '3');
        assert.equal(params.get('api_version'), '1.0');
        assert.equal(params.get('api_token'), csrf);
        assert.equal(options.headers.Cookie, `arl=${arl}; comeback=1; sid=${sessionId}`);
        assert.deepEqual(body, { sng_id: TRACK });
        return { status: 200, data: { error: gatewayError, results: { SNG_ID: gatewayId, TRACK_TOKEN: token } } };
      }
      assert.equal(url, MEDIA);
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(body.license_token, LIC);
      assert.deepEqual(body.track_tokens, [TOKEN]);
      assert.equal(body.media[0].type, 'FULL');
      const fmt = body.media[0].formats[0];
      assert.equal(fmt.cipher, 'BF_CBC_STRIPE');
      const errors = fail320 && fmt.format === 'MP3_320' ? [{ message: 'unavailable' }] : mediaErrors;
      return { status: 200, data: { data: [{ errors, media: [{ cipher: { type: 'BF_CBC_STRIPE' }, sources: [{ url: mediaUrl }] }] }] } };
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
  const gateway = fake.calls.find((c) => c.url.startsWith(`${GATEWAY}?method=song.getData`));
  assert.ok(gateway, 'track token comes from the authenticated gateway');
  assert.equal(fake.calls.find((c) => c.url === MEDIA).body.media[0].formats[0].format, 'MP3_128');
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
});

test('ignores any stale public token and URL-encodes the authenticated gateway token', async () => {
  const fake = fakeService(encryptStripes(sample()), { publicToken: 'STALE_PUBLIC_TOKEN', csrf: 'csrf+with/equals=' });
  const client = dz.createClient({ http: fake.http, arl: ARL });
  const metadata = await client.getTrack(TRACK);
  assert.equal(metadata.trackToken, undefined);
  await client.download(TRACK, path.join(TEMP, 'fresh-token.mp3'));
  const gateway = fake.calls.find((c) => c.url.startsWith(`${GATEWAY}?method=song.getData`));
  assert.equal(new URL(gateway.url).searchParams.get('api_token'), 'csrf+with/equals=');
  assert.deepEqual(fake.calls.find((c) => c.url === MEDIA).body.track_tokens, [TOKEN]);
});

test('logged-out, malformed or unsafe gateway sessions stop before track and media requests', async () => {
  const encrypted = encryptStripes(sample());
  const cases = [
    { userId: '0' }, { userId: '' }, { sessionId: '' }, { sessionId: 'bad; extra=secret' },
    { csrf: '' }, { csrf: 'bad\r\nvalue' }, { license: '' }, { license: 'bad\r\nvalue' },
    { loginError: { VALID_TOKEN_REQUIRED: true } },
  ];
  for (const [i, invalid] of cases.entries()) {
    const fake = fakeService(encrypted, invalid);
    await assert.rejects(dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, `bad-session-${i}.mp3`)), { code: 'DEEZER_AUTH' });
    assert.equal(fake.calls.some((c) => c.method === 'post'), false);
  }
});

test('gateway token must belong to the requested track and be a bounded nonempty string', async () => {
  const encrypted = encryptStripes(sample());
  const cases = [
    { gatewayId: '999999' }, { gatewayId: '' }, { token: '' }, { token: null }, { token: 'bad\r\ntoken' },
    { token: 'x'.repeat(4097) }, { gatewayError: { VALID_TOKEN_REQUIRED: true } },
  ];
  for (const [i, invalid] of cases.entries()) {
    const fake = fakeService(encrypted, invalid);
    await assert.rejects(dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, `bad-token-${i}.mp3`)), { code: 'DEEZER_UNAVAILABLE' });
    assert.equal(fake.calls.some((c) => c.url === MEDIA || c.url === CDN), false);
  }
});

test('authenticated gateway failures and redirects never forward or expose credentials', async () => {
  const encrypted = encryptStripes(sample());
  for (const failureMode of ['redirect', 'exception']) {
    const fake = fakeService(encrypted);
    const post = fake.http.post;
    fake.http.post = async (url, body, options) => {
      if (!url.startsWith(`${GATEWAY}?method=song.getData`)) return post(url, body, options);
      assert.equal(options.maxRedirects, 0);
      if (failureMode === 'redirect') return { status: 302, headers: { location: 'https://evil.test/steal' }, data: {} };
      const error = new Error(`failure with ${ARL} ${CSRF} ${SID}`);
      error.config = { url, headers: options.headers };
      throw error;
    };
    await assert.rejects(
      dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, `gateway-${failureMode}.mp3`)),
      (err) => err.code === 'DEEZER_NETWORK' && ![ARL, CSRF, SID].some((secret) => `${err.message} ${err.stack}`.includes(secret)),
    );
    assert.equal(fake.calls.some((c) => c.url === MEDIA || c.url === CDN || c.url.includes('evil.test')), false);
  }
});

test('empty media errors are accepted while real errors stop delivery', async () => {
  const encrypted = encryptStripes(sample());
  for (const [i, errors] of [[], {}, null].entries()) {
    const fake = fakeService(encrypted, { mediaErrors: errors });
    await dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, `no-errors-${i}.mp3`));
    assert.equal(fake.calls.some((c) => c.url === CDN), true);
  }
  for (const [i, errors] of [[{ code: 'NOT_ALLOWED' }], { message: 'unavailable' }, 'unavailable'].entries()) {
    const fake = fakeService(encrypted, { mediaErrors: errors });
    await assert.rejects(dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, `media-error-${i}.mp3`)), { code: 'DEEZER_UNAVAILABLE' });
    assert.equal(fake.calls.some((c) => c.url === CDN), false);
  }
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

test('real ffmpeg rejects a decrypted preview shorter than the full-track metadata', async (t) => {
  const ffmpeg = require(path.join(ROOT, 'utils/ffmpeg'));
  if (!ffmpeg.works()) return t.skip('ffmpeg unavailable');
  const preview = path.join(TEMP, 'preview.mp3');
  execFileSync(ffmpeg(), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libmp3lame', '-b:a', '128k', preview]);
  const fake = fakeService(encryptStripes(fs.readFileSync(preview)));
  const config = require(path.join(ROOT, 'config'));
  const originalArl = config.deezer.arl;
  const originalClient = dz.createClient;
  config.deezer.arl = ARL;
  dz.createClient = () => originalClient({ http: fake.http, arl: ARL });
  const command = require(path.join(ROOT, 'commands/media/deezer'));
  const sent = [];
  const sock = { async sendMessage(_chat, body) { sent.push(body); } };
  try {
    const handled = await command.attempt(sock, { key: { remoteJid: 'self@s.whatsapp.net', id: '1' }, message: {} },
      { from: 'self@s.whatsapp.net' }, { input: 'Example', fallback: true, firstHit: true });
    assert.equal(handled, false);
    assert.equal(sent.some((body) => body.document || body.audio), false);
    assert.equal(fake.calls.some((c) => c.url === CDN), true);
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

test('high or lossless entitlement requests 320, then 128 only if unavailable', async () => {
  const encrypted = encryptStripes(sample());
  for (const [label, quality, formats] of [
    ['high-only', { high: true }, ['MP3_320']],
    ['lossless-only', { premium: true }, ['MP3_320']],
    ['standard', {}, ['MP3_128']],
    ['high-fallback', { high: true, fail320: true }, ['MP3_320', 'MP3_128']],
    ['lossless-fallback', { premium: true, fail320: true }, ['MP3_320', 'MP3_128']],
  ]) {
    const fake = fakeService(encrypted, quality);
    await dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, `${label}.mp3`));
    assert.deepEqual(fake.calls.filter((c) => c.url === MEDIA).map((c) => c.body.media[0].formats[0].format), formats);
    assert.equal(fake.calls.filter((c) => c.url.startsWith(`${GATEWAY}?method=song.getData`)).length, 1);
  }
});

test('high-quality authentication failures do not retry at a lower format', async () => {
  const fake = fakeService(encryptStripes(sample()), { high: true });
  const post = fake.http.post;
  let mediaCalls = 0;
  fake.http.post = async (url, body, options) => {
    if (url === MEDIA) { mediaCalls++; return { status: 403, data: {} }; }
    return post(url, body, options);
  };
  await assert.rejects(dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, 'hq-auth.mp3')), { code: 'DEEZER_AUTH' });
  assert.equal(mediaCalls, 1);
  assert.equal(fake.calls.some((c) => c.url === CDN), false);
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

test('a prematurely closed CDN stream is restarted once and partial files are removed', async () => {
  const plain = sample();
  const encrypted = encryptStripes(plain);
  const fake = fakeService(encrypted);
  const get = fake.http.get;
  let streams = 0;
  fake.http.get = async (url, options) => {
    const response = await get(url, options);
    if (url === CDN && ++streams === 1) {
      response.data.destroy();
      response.data = Readable.from((async function* () {
        yield encrypted.subarray(0, 4096);
        throw Object.assign(new Error('private upstream detail'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
      })());
    }
    return response;
  };
  const dest = path.join(TEMP, 'recovered-stream.mp3');
  await dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, dest);
  assert.equal(streams, 2);
  assert.deepEqual(fs.readFileSync(dest), plain);
});

test('content-length mismatches retry once, then report a safe stream diagnostic', async () => {
  const encrypted = encryptStripes(sample());
  const fake = fakeService(encrypted);
  const get = fake.http.get;
  let streams = 0;
  fake.http.get = async (url, options) => {
    const response = await get(url, options);
    if (url === CDN) { streams++; response.headers['content-length'] = String(encrypted.length + 100); }
    return response;
  };
  const dest = path.join(TEMP, 'wrong-length.mp3');
  await assert.rejects(dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, dest),
    { code: 'DEEZER_NETWORK', stage: 'stream', reason: 'ERR_HTTP_CONTENT_LENGTH_MISMATCH' });
  assert.equal(streams, 2);
  assert.equal(fs.existsSync(dest), false);
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
  await assert.rejects(dz.createClient({ http: fakeService(encrypted).http, arl: ARL }).download(TRACK, existing), { code: 'DEEZER_STORAGE', stage: 'storage', reason: 'EEXIST' });
  assert.equal(fs.readFileSync(existing, 'utf8'), 'preserve');
  const redirect = { get: async () => ({ status: 302, data: {} }) };
  await assert.rejects(dz.createClient({ http: redirect, arl: ARL }).session(), { code: 'DEEZER_NETWORK' });
});

test('request diagnostics identify fixed stages and HTTP status without response data', async () => {
  const cases = [
    { stage: 'search', status: 403, code: 'DEEZER_NETWORK', run: (c) => c.search('Example') },
    { stage: 'metadata', status: 429, code: 'DEEZER_NETWORK', run: (c) => c.getTrack(TRACK) },
    { stage: 'account', status: 401, code: 'DEEZER_AUTH', run: (c) => c.session() },
  ];
  for (const item of cases) {
    const http = { async get() { return { status: item.status, data: { error: `${ARL} ${TOKEN}` } }; } };
    await assert.rejects(item.run(dz.createClient({ http, arl: ARL })), (err) => {
      assert.equal(err.code, item.code);
      assert.deepEqual(dz.diagnosticDetails(err), { stage: item.stage, status: item.status });
      assert.doesNotMatch(`${err.message} ${err.stack} ${JSON.stringify(err)}`, /SYNTHETIC_/);
      return true;
    });
  }

  for (const stage of ['track-token', 'media']) {
    const fake = fakeService(sample());
    const post = fake.http.post;
    fake.http.post = async (url, body, opts) => {
      if ((stage === 'track-token' && url.startsWith(GATEWAY)) || (stage === 'media' && url === MEDIA)) {
        return { status: 503, data: { error: `${ARL} ${SID} ${CSRF} ${LIC} ${TOKEN}` } };
      }
      return post(url, body, opts);
    };
    await assert.rejects(dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, `http-${stage}.mp3`)), (err) => {
      assert.equal(err.code, 'DEEZER_NETWORK');
      assert.deepEqual(dz.diagnosticDetails(err), { stage, status: 503 });
      assert.doesNotMatch(`${err.message} ${err.stack} ${JSON.stringify(err)}`, /SYNTHETIC_/);
      return true;
    });
  }
});

test('network reasons and Deezer API quota are safe, stage-specific diagnostics', async () => {
  const err = Object.assign(new Error(`request ${ARL} ${TOKEN}`), {
    code: `SECRET_${ARL}`, cause: { code: 'EAI_AGAIN', message: SID }, config: { headers: { Cookie: ARL } },
  });
  const client = dz.createClient({ http: { async get() { throw err; } }, arl: ARL });
  await assert.rejects(client.search('example'), (actual) => {
    assert.equal(actual.code, 'DEEZER_NETWORK');
    assert.deepEqual(dz.diagnosticDetails(actual), { stage: 'search', reason: 'EAI_AGAIN' });
    assert.doesNotMatch(`${actual.message} ${actual.stack} ${JSON.stringify(actual)}`, /SYNTHETIC_/);
    return true;
  });
  const quota = dz.createClient({ http: { async get() { return { status: 200, data: { error: { code: 4, message: ARL } } }; } }, arl: ARL });
  await assert.rejects(quota.search('example'), { code: 'DEEZER_NETWORK', stage: 'search', reason: 'RATE_LIMIT' });
  await assert.rejects(quota.getTrack(TRACK), { code: 'DEEZER_NETWORK', stage: 'metadata', reason: 'RATE_LIMIT' });
  assert.deepEqual(dz.diagnosticDetails({ stage: ARL, status: '403', reason: TOKEN }), {});
  assert.equal(dz.diagnosticCode(`DEEZER_${ARL}`), 'DEEZER_ERROR');
});

test('decoder, storage, CDN and stream failures are classified separately', async () => {
  const encrypted = encryptStripes(sample());
  const decoderError = Object.assign(new Error(`decoder ${ARL}`), { code: 'ERR_MODULE_NOT_FOUND' });
  const decoderFile = path.join(TEMP, 'decoder-missing.mp3');
  const decoder = dz.createClient({ http: fakeService(encrypted).http, arl: ARL, makeDecoder: async () => { throw decoderError; } });
  await assert.rejects(decoder.download(TRACK, decoderFile), (err) => {
    assert.equal(err.code, 'DEEZER_DECODER');
    assert.deepEqual(dz.diagnosticDetails(err), { stage: 'decoder', reason: 'ERR_MODULE_NOT_FOUND' });
    assert.doesNotMatch(`${err.message} ${err.stack} ${JSON.stringify(err)}`, /SYNTHETIC_/);
    return true;
  });
  assert.equal(fs.existsSync(decoderFile), false);
  await assert.rejects(dz.createClient({ http: fakeService(encrypted).http, arl: ARL }).download(TRACK, path.join(TEMP, 'missing-parent', 'track.mp3')),
    { code: 'DEEZER_STORAGE', stage: 'storage', reason: 'ENOENT' });
  const failedOpen = path.join(TEMP, 'failed-open.mp3');
  const open = fs.openSync;
  try {
    fs.openSync = (file, ...args) => {
      if (file === failedOpen) throw Object.assign(new Error(ARL), { code: 'UNKNOWN_FS_ERROR' });
      return open(file, ...args);
    };
    await assert.rejects(dz.createClient({ http: fakeService(encrypted).http, arl: ARL }).download(TRACK, failedOpen), (err) => {
      assert.equal(err.code, 'DEEZER_STORAGE');
      assert.deepEqual(dz.diagnosticDetails(err), { stage: 'storage' });
      assert.doesNotMatch(`${err.message} ${err.stack} ${JSON.stringify(err)}`, /SYNTHETIC_/);
      return true;
    });
  } finally { fs.openSync = open; }
  assert.equal(fs.existsSync(failedOpen), false);

  const cdn = fakeService(encrypted);
  const getCdn = cdn.http.get;
  cdn.http.get = async (url, opts) => {
    if (url === CDN) throw Object.assign(new Error(`signed ${TOKEN}`), { code: 'ETIMEDOUT' });
    return getCdn(url, opts);
  };
  await assert.rejects(dz.createClient({ http: cdn.http, arl: ARL }).download(TRACK, path.join(TEMP, 'cdn-fail.mp3')),
    { code: 'DEEZER_NETWORK', stage: 'cdn', reason: 'ETIMEDOUT' });
  for (const [status, code] of [[403, 'DEEZER_UNAVAILABLE'], [503, 'DEEZER_NETWORK']]) {
    const fake = fakeService(encrypted);
    const get = fake.http.get;
    fake.http.get = async (url, opts) => url === CDN ? { status, data: Readable.from([]), headers: {} } : get(url, opts);
    await assert.rejects(dz.createClient({ http: fake.http, arl: ARL }).download(TRACK, path.join(TEMP, `cdn-${status}.mp3`)), { code, stage: 'cdn', status });
  }

  const broken = fakeService(encrypted);
  const getStream = broken.http.get;
  broken.http.get = async (url, opts) => {
    const response = await getStream(url, opts);
    if (url === CDN) {
      response.data.destroy();
      response.data = Readable.from((async function* () {
        yield encrypted.subarray(0, 4096);
        throw Object.assign(new Error(`stream ${TOKEN}`), { code: 'ECONNRESET' });
      })());
    }
    return response;
  };
  const partial = path.join(TEMP, 'classified-partial.mp3');
  await assert.rejects(dz.createClient({ http: broken.http, arl: ARL }).download(TRACK, partial),
    { code: 'DEEZER_NETWORK', stage: 'stream', reason: 'ECONNRESET' });
  assert.equal(fs.existsSync(partial), false);
});

test('read-only status checks never download or return account data or signed media URLs', async () => {
  const signature = 'SYNTHETIC_SIGNED_CDN_SECRET';
  const fake = fakeService(sample(), { high: true, fail320: true, mediaUrl: `${CDN}?sig=${signature}` });
  const report = await dz.createClient({ http: fake.http, arl: ARL }).diagnose(TRACK);
  assert.deepEqual(report, {
    search: { ok: true }, metadata: { ok: true }, account: { ok: true }, trackToken: { ok: true }, media: { ok: true },
  });
  assert.equal(fake.calls.filter((c) => c.url === MEDIA).length, 2, 'status uses the playback quality fallback');
  assert.equal(fake.calls.some((c) => c.url.startsWith(CDN)), false, 'status does not fetch audio');
  for (const secret of [ARL, LIC, TOKEN, CSRF, SID, signature, CDN]) assert.equal(JSON.stringify(report).includes(secret), false);

  const loggedOut = fakeService(sample(), { userId: '0' });
  const failed = await dz.createClient({ http: loggedOut.http, arl: ARL }).diagnose(TRACK);
  assert.deepEqual(failed.account, { ok: false, code: 'DEEZER_AUTH', stage: 'account' });
  assert.deepEqual(failed.trackToken, { skipped: true });
  assert.deepEqual(failed.media, { skipped: true });
  assert.equal(loggedOut.calls.some((c) => c.method === 'post'), false);

  const noConfig = fakeService(sample());
  const unconfigured = await dz.createClient({ http: noConfig.http, arl: '' }).diagnose(TRACK);
  assert.deepEqual(unconfigured.account, { ok: false, code: 'DEEZER_CONFIG', stage: 'account' });
  assert.deepEqual(unconfigured.media, { skipped: true });
  assert.equal(noConfig.calls.some((c) => c.url.startsWith(GATEWAY)), false);

  const noSearch = fakeService(sample());
  const get = noSearch.http.get;
  noSearch.http.get = async (url, opts) => url.includes('/search/track?') ? { status: 403, data: ARL } : get(url, opts);
  const directOnly = await dz.createClient({ http: noSearch.http, arl: ARL }).diagnose(TRACK);
  assert.deepEqual(directOnly.search, { ok: false, code: 'DEEZER_NETWORK', stage: 'search', status: 403 });
  assert.deepEqual(directOnly.media, { ok: true }, 'a search failure does not block independent direct-track checks');
  assert.doesNotMatch(JSON.stringify(directOnly), /SYNTHETIC_/);

  const badToken = fakeService(sample(), { gatewayError: [{ message: ARL }] });
  const unavailable = await dz.createClient({ http: badToken.http, arl: ARL }).diagnose(TRACK);
  assert.deepEqual(unavailable.trackToken, { ok: false, code: 'DEEZER_UNAVAILABLE', stage: 'track-token' });
  assert.deepEqual(unavailable.media, { skipped: true });
  assert.doesNotMatch(JSON.stringify(unavailable), /SYNTHETIC_/);
});
