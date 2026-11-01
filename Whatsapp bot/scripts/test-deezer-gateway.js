'use strict';

// Synthetic responses only. Never load a real account, host config, or session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deezer-gateway-test-'));
const ROOT = createBotFixture(TEMP);
process.chdir(TEMP);
const deezer = require(path.join(ROOT, 'utils/deezer'));
test.after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const ARL = 'SYNTHETIC_GATEWAY_ARL';
const SID = 'SYNTHETIC_GATEWAY_SID';
const CSRF = 'SYNTHETIC_GATEWAY_CSRF';
const LICENSE = 'SYNTHETIC_GATEWAY_LICENSE';
const TOKEN = 'SYNTHETIC_GATEWAY_TRACK_TOKEN';
const SIGNED = 'SYNTHETIC_CDN_SIGNATURE';
const ID = '3135553';
const GATEWAY = 'https://www.deezer.com/ajax/gw-light.php';
const MEDIA = 'https://media.deezer.com/v1/get_url';
const CDN = `https://cdn.deezer.com/media/test?sig=${SIGNED}`;
const track = (changes = {}) => ({
  SNG_ID: ID, SNG_TITLE: 'Example', VERSION: '(Live)', DURATION: '200',
  ART_NAME: 'Artist', ALB_TITLE: 'Album', ISRC: 'AB1234567890', TRACK_TOKEN: TOKEN,
  ...changes,
});
const publicTrack = {
  id: Number(ID), title: 'Example', duration: 200, artist: { name: 'Artist' },
  album: { title: 'Album' }, isrc: 'AB1234567890',
};

function fixture({ search = 'ok', metadata = 'ok', userId = '123', rows = [track()], gatewayStatus = 200 } = {}) {
  const calls = [];
  const reply = (mode, data) => {
    if (mode === 'reset' || mode === 'timeout') {
      throw Object.assign(new Error(`${ARL} ${TOKEN}`), { code: mode === 'reset' ? 'ECONNRESET' : 'ETIMEDOUT' });
    }
    if (mode === 'quota') return { status: 200, data: { error: { code: 4, message: ARL } } };
    if (mode === '503retry') return { status: 503, headers: { 'retry-after': '10' }, data: {} };
    if (mode === 'missing') return { status: 200, data: { error: { code: 800 } } };
    if (typeof mode === 'number') return { status: mode, data: { error: ARL } };
    return { status: 200, data };
  };
  const http = {
    async get(url, options) {
      calls.push({ method: 'get', url, options });
      assert.equal(options.maxRedirects, 0);
      if (url.startsWith('https://api.deezer.com/search/track?')) {
        assert.equal(options.headers.Cookie, undefined);
        return reply(search, { data: [publicTrack] });
      }
      if (url === `https://api.deezer.com/track/${ID}`) {
        assert.equal(options.headers.Cookie, undefined);
        return reply(metadata, publicTrack);
      }
      if (url.startsWith(`${GATEWAY}?method=deezer.getUserData`)) {
        assert.equal(options.headers.Cookie, `arl=${ARL}; comeback=1`);
        return { status: 200, data: { error: [], results: {
          checkForm: CSRF, SESSION_ID: SID,
          USER: { USER_ID: userId, OPTIONS: { license_token: LICENSE } },
        } } };
      }
      if (url === CDN) {
        assert.equal(options.headers.Cookie, undefined);
        return { status: 200, headers: { 'content-type': 'audio/mpeg' }, data: Readable.from([Buffer.alloc(12 * 1024, 1)]) };
      }
      throw new Error('unexpected GET');
    },
    async post(url, body, options) {
      calls.push({ method: 'post', url, body, options });
      assert.equal(options.maxRedirects, 0);
      if (url === MEDIA) {
        assert.equal(options.headers.Cookie, undefined);
        assert.equal(body.license_token, LICENSE);
        assert.deepEqual(body.track_tokens, [TOKEN]);
        return { status: 200, data: { data: [{ media: [{ cipher: { type: 'BF_CBC_STRIPE' }, sources: [{ url: CDN }] }] }] } };
      }
      const parsed = new URL(url);
      assert.equal(`${parsed.origin}${parsed.pathname}`, GATEWAY);
      assert.equal(parsed.searchParams.get('api_token'), CSRF);
      assert.equal(options.headers.Cookie, `arl=${ARL}; comeback=1; sid=${SID}`);
      const method = parsed.searchParams.get('method');
      if (method === 'search.music' || method === 'song.getListData') {
        if (gatewayStatus !== 200) return { status: gatewayStatus, headers: { location: 'https://evil.test/steal' }, data: ARL };
        return { status: 200, data: { error: [], results: { data: rows } } };
      }
      if (method === 'song.getData') {
        assert.deepEqual(body, { sng_id: ID });
        return { status: 200, data: { error: [], results: { SNG_ID: ID, TRACK_TOKEN: TOKEN } } };
      }
      throw new Error('unexpected POST');
    },
  };
  return { http, calls };
}

const names = (f) => f.calls.filter((call) => call.method === 'post' && call.url.startsWith(GATEWAY))
  .map((call) => new URL(call.url).searchParams.get('method'));

test('working public search and metadata never use the gateway or account', async () => {
  const f = fixture();
  const client = deezer.createClient({ http: f.http, arl: ARL });
  assert.equal((await client.search('Artist Example'))[0].title, 'Example');
  assert.equal((await client.getTrack(ID)).title, 'Example');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.some((call) => call.url.startsWith(GATEWAY)), false);
});

test('public transport errors use a verified account and normalize gateway search and metadata', async () => {
  const f = fixture({ search: 'reset', metadata: 'timeout', rows: [
    track(),
    track({ SNG_ID: '7654321', SNG_TITLE: 'Second', VERSION: '', ART_NAME: '', ARTISTS: [{ ART_NAME: 'Other Artist' }] }),
    track({ SNG_ID: '../unsafe' }),
  ] });
  const client = deezer.createClient({ http: f.http, arl: ARL });
  const found = await client.search('Artist Example', { limit: 2 });
  assert.deepEqual(found.map((item) => [item.id, item.title, item.artist]), [
    [ID, 'Example (Live)', 'Artist'], ['7654321', 'Second', 'Other Artist'],
  ]);
  assert.deepEqual(await client.getTrack(ID), {
    id: ID, url: `https://www.deezer.com/track/${ID}`, title: 'Example (Live)', artist: 'Artist',
    album: 'Album', isrc: 'AB1234567890', duration: 200, thumbnail: '',
  });
  assert.deepEqual(names(f), ['search.music', 'song.getListData']);
  const lookup = f.calls.find((call) => call.method === 'post' && call.url.includes('method=search.music'));
  assert.deepEqual(lookup.body, { query: 'Artist Example', output: 'TRACK', filter: 'all', start: 0, nb: 2 });
  const list = f.calls.find((call) => call.method === 'post' && call.url.includes('method=song.getListData'));
  assert.deepEqual(list.body, { sng_ids: [ID] });
  assert.doesNotMatch(JSON.stringify(found), /SYNTHETIC_/);
});

test('gateway metadata never accepts a different track id or repeats the version', async () => {
  const matching = fixture({ metadata: 'timeout', rows: [track({ SNG_TITLE: 'Example (Live)', VERSION: '(Live)' })] });
  assert.equal((await deezer.createClient({ http: matching.http, arl: ARL }).getTrack(ID)).title, 'Example (Live)');
  const wrong = fixture({ metadata: 'timeout', rows: [track({ SNG_ID: '999999' })] });
  await assert.rejects(deezer.createClient({ http: wrong.http, arl: ARL }).getTrack(ID),
    { code: 'DEEZER_NETWORK', stage: 'metadata', reason: 'ETIMEDOUT' });
  assert.deepEqual(names(wrong), ['song.getListData']);
  assert.equal(wrong.calls.some((call) => call.url === MEDIA || call.url === CDN), false);
});

test('a 503 public failure tries the authenticated gateway once', async () => {
  const f = fixture({ search: 503 });
  const found = await deezer.createClient({ http: f.http, arl: ARL }).search('Example');
  assert.equal(found[0].id, ID);
  assert.deepEqual(names(f), ['search.music']);
});

test('rate limits, access denials and unavailable tracks never trigger the fallback', async () => {
  for (const mode of [401, 403, 429, 'quota', '503retry']) {
    const f = fixture({ search: mode, metadata: mode });
    const client = deezer.createClient({ http: f.http, arl: ARL });
    await assert.rejects(client.search('Example'), { code: 'DEEZER_NETWORK', stage: 'search' });
    await assert.rejects(client.getTrack(ID), { code: 'DEEZER_NETWORK', stage: 'metadata' });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(names(f), []);
  }
  const missing = fixture({ metadata: 'missing' });
  await assert.rejects(deezer.createClient({ http: missing.http, arl: ARL }).getTrack(ID), { code: 'DEEZER_TRACK' });
  assert.equal(missing.calls.length, 1);
});

test('fallback is not used without a signed-in account and never follows redirects', async () => {
  const noAccount = fixture({ search: 'reset' });
  await assert.rejects(deezer.createClient({ http: noAccount.http, arl: '' }).search('Example'),
    { code: 'DEEZER_NETWORK', stage: 'search', reason: 'ECONNRESET' });
  assert.equal(noAccount.calls.length, 1);

  const loggedOut = fixture({ search: 'reset', userId: '0' });
  await assert.rejects(deezer.createClient({ http: loggedOut.http, arl: ARL }).search('Example'),
    { code: 'DEEZER_NETWORK', stage: 'search', reason: 'ECONNRESET' });
  assert.deepEqual(names(loggedOut), []);

  for (const status of [302, 403, 429]) {
    const blocked = fixture({ search: 'reset', gatewayStatus: status });
    await assert.rejects(deezer.createClient({ http: blocked.http, arl: ARL }).search('Example'), (err) => {
      assert.deepEqual(deezer.diagnosticDetails(err), { stage: 'search', reason: 'ECONNRESET' });
      assert.doesNotMatch(`${err.message} ${err.stack} ${JSON.stringify(err)}`, /SYNTHETIC_|evil\.test/);
      return true;
    });
    assert.deepEqual(names(blocked), ['search.music']);
    assert.equal(blocked.calls.some((call) => call.url.includes('evil.test')), false);
  }
});

test('full download uses exact gateway metadata but still obtains an account-scoped token', async () => {
  const f = fixture({ metadata: 'timeout' });
  const passthrough = async () => new Transform({ transform(chunk, _encoding, done) { done(null, chunk); } });
  const client = deezer.createClient({ http: f.http, arl: ARL, makeDecoder: passthrough });
  const dest = path.join(TEMP, 'synthetic-download.mp3');
  const result = await client.download(ID, dest, { maxBytes: 20 * 1024 });
  assert.equal(result.id, ID);
  assert.equal(result.bytes, 12 * 1024);
  assert.equal(result.trackToken, undefined);
  assert.deepEqual(names(f), ['song.getListData', 'song.getData']);
  assert.equal(f.calls.filter((call) => call.url === MEDIA).length, 1);
  assert.equal(f.calls.filter((call) => call.url === CDN).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_/);
});

test('status distinguishes public failures from working gateway without downloading audio', async () => {
  const f = fixture({ search: 'reset', metadata: 'timeout' });
  const report = await deezer.createClient({ http: f.http, arl: ARL }).diagnose(ID);
  assert.deepEqual(report.search, { ok: false, code: 'DEEZER_NETWORK', stage: 'search', reason: 'ECONNRESET' });
  assert.deepEqual(report.metadata, { ok: false, code: 'DEEZER_NETWORK', stage: 'metadata', reason: 'ETIMEDOUT' });
  assert.deepEqual(report.gatewaySearch, { ok: true });
  assert.deepEqual(report.gatewayMetadata, { ok: true });
  assert.deepEqual(report.account, { ok: true });
  assert.deepEqual(report.trackToken, { ok: true });
  assert.deepEqual(report.media, { ok: true });
  assert.equal(f.calls.some((call) => call.url === CDN), false);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_|cdn\.deezer\.com/);
});
