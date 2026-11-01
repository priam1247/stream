const test = require('node:test');
const assert = require('node:assert/strict');
const audius = require('../utils/audius');

const sample = (changes = {}) => ({
  id: 'abc123', title: 'Song', duration: 120, user: { name: 'Artist' },
  is_downloadable: true, is_download_gated: false, access: { download: true },
  download_conditions: null, is_available: true, is_delete: false, is_unlisted: false,
  ...changes,
});

test('Audius only offers explicitly public, ungated downloadable tracks', () => {
  assert.deepEqual(audius.permittedTrack(sample()), { id: 'abc123', title: 'Song', artist: 'Artist', duration: 120 });
  for (const changes of [
    { is_downloadable: false, is_streamable: true }, { is_downloadable: undefined },
    { is_download_gated: true }, { is_download_gated: undefined }, { access: { download: false } },
    { access: undefined }, { download_conditions: { followers: true } }, { is_available: false },
    { is_delete: true }, { is_unlisted: true }, { id: '../../stream' }, { title: '' },
    { user: {} }, { duration: 0 }, { duration: Infinity },
  ]) assert.equal(audius.permittedTrack(sample(changes)), null, JSON.stringify(changes));
  const cleaned = audius.permittedTrack(sample({ title: 'one\n\u202etwo', user: { name: 'Artist\tName' } }));
  assert.equal(cleaned.title, 'one two');
  assert.equal(cleaned.artist, 'Artist Name');
});

test('search independently filters misleading API results, deduplicates and caps results', async () => {
  let call;
  const client = audius.createClient({ get: async (url, options) => {
    call = { url, options };
    return { data: { data: [sample({ id: 'bad', is_downloadable: false }), sample(), sample(), sample({ id: 'second' })] } };
  } });
  const results = await client.search('Artist Song', { limit: 2 });
  assert.deepEqual(results.map((x) => x.id), ['abc123', 'second']);
  assert.equal(call.url, `${audius.API}/tracks/search`);
  assert.equal(call.options.params.only_downloadable, 1);
  assert.equal(call.options.params.query, 'Artist Song');
  assert.equal(call.options.maxRedirects, 0);
  assert.equal(call.options.proxy, false);
  await assert.rejects(client.search('x'.repeat(201)), { code: 'AUDIUS_QUERY' });
});

test('metadata is rechecked and the official download endpoint is used', async () => {
  let downloadCall;
  const client = audius.createClient({
    get: async (url) => { assert.equal(url, `${audius.API}/tracks/abc123`); return { data: { data: sample() } }; },
    download: async (...args) => { downloadCall = args; return { bytes: 12345 }; },
  });
  const hit = await client.downloadTrack('abc123', '/tmp/fixture', { maxBytes: 20000, maxSeconds: 200 });
  assert.equal(hit.title, 'Song');
  assert.equal(hit.bytes, 12345);
  assert.match(downloadCall[0], /^https:\/\/api\.audius\.co\/v1\/tracks\/abc123\/download\?/);
  assert.equal(downloadCall[1], '/tmp/fixture');
  assert.equal(downloadCall[2].maxBytes, 20000);
  assert.doesNotMatch(downloadCall[0], /\/stream/);
});

test('permission changes, invalid ids and length caps never start a download', async () => {
  let calls = 0;
  const revoked = audius.createClient({
    get: async () => ({ data: { data: sample({ is_downloadable: false }) } }),
    download: async () => { calls++; },
  });
  await assert.rejects(revoked.downloadTrack('abc123', '/tmp/fixture', { maxBytes: 20000 }), { code: 'MEDIA_UNAVAILABLE' });
  await assert.rejects(revoked.downloadTrack('../abc', '/tmp/fixture', { maxBytes: 20000 }), { code: 'MEDIA_UNAVAILABLE' });
  const long = audius.createClient({
    get: async () => ({ data: { data: sample({ duration: 600 }) } }), download: async () => { calls++; },
  });
  await assert.rejects(long.downloadTrack('abc123', '/tmp/fixture', { maxBytes: 20000, maxSeconds: 200 }), { code: 'TOO_LONG' });
  assert.equal(calls, 0);
});

test('malformed responses and network errors use safe messages', async () => {
  const broken = audius.createClient({ get: async () => { throw new Error('https://signed.example/private?token=SECRET'); } });
  await assert.rejects(broken.search('song'), (err) => err.code === 'AUDIUS_NETWORK' && !err.message.includes('SECRET'));
  const bad = audius.createClient({ get: async () => ({ data: { data: {} } }) });
  await assert.rejects(bad.search('song'), { code: 'AUDIUS_NETWORK' });
});
