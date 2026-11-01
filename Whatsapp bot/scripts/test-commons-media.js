const test = require('node:test');
const assert = require('node:assert/strict');
const commons = require('../utils/commonsMedia');

const metadata = () => ({
  ObjectName: { value: 'Bach BWV 939' }, Artist: { value: '<a>Gérard Janot</a>' }, Credit: { value: 'Own work' },
  LicenseShortName: { value: 'CC BY-SA 3.0' }, License: { value: 'cc-by-sa-3.0' },
  LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/3.0' },
  AttributionRequired: { value: 'true' }, Restrictions: { value: '' },
});
const page = (changes = {}) => ({
  pageid: 1234, title: 'File:Bach.ogv', index: 1,
  imageinfo: [{
    mediatype: 'VIDEO', mime: 'application/ogg', size: 800000, duration: 32.2,
    url: 'https://upload.wikimedia.org/wikipedia/commons/6/60/Bach.ogv',
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Bach.ogv', extmetadata: metadata(), ...changes,
  }],
});

test('normalizes an open-licensed video with creator, source and license', () => {
  const item = commons.normalizePage(page(), 'video');
  assert.equal(item.title, 'Bach BWV 939');
  assert.equal(item.artist, 'Gérard Janot');
  assert.equal(item.license, 'CC BY-SA 3.0');
  assert.equal(item.licenseUrl, 'https://creativecommons.org/licenses/by-sa/3.0/');
  assert.equal(item.source, 'https://commons.wikimedia.org/wiki/File:Bach.ogv');
  assert.equal(commons.normalizePage(page(), 'audio'), null);
});

test('strips Commons tracking parameters while keeping other download parameters', () => {
  const item = commons.normalizePage(page({
    url: 'https://upload.wikimedia.org/wikipedia/commons/6/60/Bach.ogv?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original&other=1',
  }), 'video');
  assert.equal(item.url, 'https://upload.wikimedia.org/wikipedia/commons/6/60/Bach.ogv?other=1');
});

test('public-domain records need explicit machine-readable status', () => {
  const meta = metadata();
  meta.LicenseShortName.value = 'Public domain';
  meta.License.value = 'pd';
  meta.Copyrighted = { value: 'False' };
  meta.AttributionRequired.value = 'false';
  assert.equal(commons.licenseInfo(meta).license, 'Public domain');
  delete meta.Copyrighted;
  assert.equal(commons.licenseInfo(meta), null);
});

test('rejects missing, disputed, restricted, unsafe or incomplete metadata', () => {
  for (const mutate of [
    (m) => delete m.Artist, (m) => { m.LicenseShortName.value = 'Unknown'; },
    (m) => { m.License.value = 'different'; }, (m) => { m.LicenseUrl.value = 'https://creativecommons.org.evil.test/'; },
    (m) => { m.Restrictions.value = 'some restriction'; }, (m) => { m.Restrictions.value = 'x'.repeat(500); },
    (m) => { m.Attribution = { value: 'x'.repeat(401) }; }, (m) => { m.Credit.value = 'x'.repeat(401); },
    (m) => { m.Attribution = { value: '<a href="javascript:alert(1)">bad</a>' }; },
  ]) {
    const m = metadata(); mutate(m);
    assert.equal(commons.normalizePage(page({ extmetadata: m }), 'video'), null);
  }
  for (const fields of [
    { url: 'https://127.0.0.1/wikipedia/commons/a/file' },
    { url: 'https://upload.wikimedia.org.evil.test/wikipedia/commons/a/file' },
    { url: 'https://upload.wikimedia.org/other/file' },
    { descriptionurl: 'https://commons.wikimedia.org.evil.test/wiki/File:Bach.ogv' },
    { descriptionurl: 'https://commons.wikimedia.org/wiki/User:Person' },
    { duration: 0 }, { size: 0 },
  ]) assert.equal(commons.normalizePage(page(fields), 'video'), null, JSON.stringify(fields));
});

test('credit text includes custom attribution, source, license and conversion notice', () => {
  const meta = metadata();
  meta.Attribution = { value: '<b>Credit the performer</b> <a href="https://commons.wikimedia.org/wiki/User:Musician">profile</a>' };
  meta.Credit = { value: 'Recording by performer' };
  const credit = commons.attributionFor(commons.normalizePage(page({ extmetadata: meta }), 'video'));
  assert.match(credit, /Gérard Janot/);
  assert.match(credit, /Attribution: Credit the performer/);
  assert.match(credit, /profile \(https:\/\/commons\.wikimedia\.org\/wiki\/User:Musician\)/);
  assert.match(credit, /Credit: Recording by performer/);
  assert.match(credit, /License: CC BY-SA 3\.0/);
  assert.match(credit, /creativecommons\.org\/licenses\/by-sa\/3\.0/);
  assert.match(credit, /Source: https:\/\/commons\.wikimedia\.org/);
  assert.match(credit, /Converted or tagged/);
  assert.doesNotMatch(credit, /<b>/);
});

test('search uses MediaWiki media type and metadata fields, then sorts by relevance', async () => {
  let request;
  const first = page(); first.index = 1;
  const second = page(); second.pageid = 2222; second.index = 2;
  const invalid = page({ mediatype: 'AUDIO' }); invalid.index = 0;
  const client = commons.createClient({ get: async (url, options) => {
    request = { url, options };
    return { data: { query: { pages: [second, invalid, first] } } };
  } });
  const found = await client.search('Bach', { kind: 'video', limit: 2 });
  assert.deepEqual(found.map((x) => x.id), [1234, 2222]);
  assert.equal(request.url, commons.API);
  assert.equal(request.options.params.gsrsearch, 'Bach filetype:video');
  assert.match(request.options.params.iiprop, /extmetadata/);
  assert.equal(request.options.maxRedirects, 0);
  assert.equal(request.options.proxy, false);
  await assert.rejects(client.search('x'.repeat(201)), { code: 'COMMONS_QUERY' });
});

test('a selected file is rechecked and confined to Wikimedia uploads', async () => {
  let call;
  const client = commons.createClient({
    get: async (_url, options) => {
      assert.equal(options.params.pageids, '1234');
      return { data: { query: { pages: [page()] } } };
    },
    download: async (...args) => { call = args; return { bytes: 800000 }; },
  });
  const item = await client.downloadItem(1234, '/tmp/fixture', { kind: 'video', maxBytes: 900000, maxSeconds: 40 });
  assert.equal(item.bytes, 800000);
  assert.equal(call[1], '/tmp/fixture');
  assert.deepEqual(call[2].allowedHosts, ['upload.wikimedia.org']);
  await assert.rejects(client.downloadItem(1234, '/tmp/fixture', { kind: 'video', maxBytes: 100000, maxSeconds: 40 }), { code: 'TOO_BIG' });
  await assert.rejects(client.downloadItem(1234, '/tmp/fixture', { kind: 'video', maxBytes: 900000, maxSeconds: 5 }), { code: 'TOO_LONG' });
  await assert.rejects(client.downloadItem(1234, '/tmp/fixture', { kind: 'audio', maxBytes: 900000 }), { code: 'MEDIA_UNAVAILABLE' });
});

test('MediaWiki busy/error responses are not presented as no results', async () => {
  const client = commons.createClient({ get: async () => ({ data: { error: { code: 'cirrussearch-too-busy-error' } } }) });
  await assert.rejects(client.search('Bach'), { code: 'COMMONS_NETWORK' });
});
