#!/usr/bin/env node
'use strict';

// Offline tests for the remaining Reddit title search and its index fallbacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-search-'));
const BOT = createBotFixture(TMP);
const botRequire = createRequire(path.join(BOT, 'scripts/test-provider-search.js'));
process.chdir(TMP);
const axios = botRequire('axios');
const search = botRequire('../utils/providerSearch');
const example = 'https://www.reddit.com/r/test/comments/abc123/example/';
const originals = { get: axios.get, post: axios.post };
const success = (data) => ({ status: 200, data: typeof data === 'string' ? data : JSON.stringify(data) });
const denied = async () => { throw new Error('fixture: offline'); };
function duck(rows) {
  return `<div class="results">${rows.map(({ url, title }) => `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}">${title}</a>`).join('')}</div>`;
}
function brave(rows) {
  return `<div id="results">${rows.map(({ url, title }) => `<div class="snippet"><a class="result-header" href="${url}"><span class="snippet-title">${title}</span></a></div>`).join('')}</div>`;
}
test.beforeEach(() => { axios.get = denied; axios.post = denied; });
test.afterEach(() => { axios.get = originals.get; axios.post = originals.post; });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('only Reddit remains searchable and URLs must be individual posts on allowed hosts', async () => {
  assert.deepEqual(Object.keys(search.PROVIDERS), ['reddit']);
  assert.equal(search.normalizeSiteUrl('reddit', example.replace('https:', 'http:')), example);
  for (const url of [
    'https://www.reddit.com.evil.example/r/test/comments/abc123/example/',
    'https://www.reddit.com@evil.example/r/test/comments/abc123/example/',
    'https://user:pass@www.reddit.com/r/test/comments/abc123/example/',
    'https://www.reddit.com:8443/r/test/comments/abc123/example/',
    'file:///r/test/comments/abc123/example/', 'http://127.0.0.1/comments/abc123/',
    'https://www.reddit.com/search?q=cat', 'https://www.reddit.com/r/test/',
  ]) assert.equal(search.normalizeSiteUrl('reddit', url), null, url);
  await assert.rejects(search.searchProvider('unknown', 'title'), /Unknown provider/);
});

test('native Reddit search keeps only video posts and validates each result', async () => {
  axios.get = async (endpoint, opts) => {
    assert.equal(endpoint, 'https://www.reddit.com/search.json');
    assert.equal(opts.params.q, 'cat');
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(opts.headers.Cookie, undefined);
    assert.equal(opts.maxRedirects, 0);
    return success({ data: { children: [
      { data: { is_video: false, permalink: '/r/test/comments/abc000/image/', title: 'Image' } },
      { data: { is_video: true, permalink: '/r/test/comments/abc123/example/', title: 'Cat <b>video</b>', author: 'Creator' } },
      { data: { is_video: true, permalink: '//evil.example/redirect', title: 'Bad' } },
    ] } });
  };
  const found = await search.searchProvider('reddit', 'cat');
  assert.equal(found.source, 'provider');
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].url, example);
  assert.equal(found.results[0].title, 'Cat video');
});

test('DuckDuckGo fallback validates results, deduplicates, and never sends credentials', async () => {
  const calls = [];
  axios.get = async (endpoint, opts) => {
    calls.push({ endpoint, opts });
    if (!endpoint.includes('duckduckgo')) throw new Error('native unavailable');
    return success(duck([
      { url: 'https://evil.example/?next=' + encodeURIComponent(example), title: 'offsite' },
      { url: example, title: 'A &amp; B' }, { url: example, title: 'duplicate' },
    ]));
  };
  const found = await search.searchProvider('reddit', 'cat videos');
  assert.equal(found.source, 'duckduckgo');
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].url, example);
  assert.equal(found.results[0].title, 'A & B');
  const options = calls.at(-1).opts;
  assert.match(options.params.q, /cat videos.*site:reddit\.com/);
  assert.equal(options.headers.Cookie, undefined);
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.maxRedirects, 0);
  assert.equal(options.maxContentLength, 1024 * 1024);
});

test('Brave and Firecrawl are tried in order when earlier searches fail', async () => {
  axios.get = async (endpoint) => {
    if (endpoint.includes('brave')) return success(brave([{ url: example, title: 'Brave result' }]));
    throw new Error('offline');
  };
  assert.equal((await search.searchProvider('reddit', 'title')).source, 'brave');
  axios.get = denied;
  axios.post = async (endpoint, body, opts) => {
    assert.equal(endpoint, 'https://api.firecrawl.dev/v2/search');
    assert.deepEqual(body.includeDomains, ['reddit.com']);
    assert.equal(opts.headers.Cookie, undefined);
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(opts.maxRedirects, 0);
    return success({ success: true, data: { web: [{ url: example, title: 'Public result' }, { url: 'https://evil.example/', title: 'bad' }] } });
  };
  const found = await search.searchProvider('reddit', 'title');
  assert.equal(found.source, 'firecrawl');
  assert.equal(found.results.length, 1);
});

test('inherited Axios authorization and account cookies are not forwarded', async () => {
  const old = { adapter: axios.defaults.adapter, auth: axios.defaults.auth,
    authorization: axios.defaults.headers.common.Authorization, cookie: axios.defaults.headers.common.Cookie };
  axios.get = originals.get;
  axios.defaults.auth = { username: 'fixture', password: 'fixture' };
  axios.defaults.headers.common.Authorization = 'fixture';
  axios.defaults.headers.common.Cookie = 'fixture';
  axios.defaults.adapter = async (config) => {
    assert.equal(config.auth, null);
    assert.equal(config.headers.has('Authorization'), false);
    assert.equal(config.headers.has('Cookie'), false);
    return { status: 200, data: JSON.stringify({ data: { children: [] } }), headers: {}, config };
  };
  try { await search.searchProvider('reddit', 'title'); }
  finally {
    axios.defaults.adapter = old.adapter;
    if (old.auth === undefined) delete axios.defaults.auth; else axios.defaults.auth = old.auth;
    if (old.authorization === undefined) delete axios.defaults.headers.common.Authorization; else axios.defaults.headers.common.Authorization = old.authorization;
    if (old.cookie === undefined) delete axios.defaults.headers.common.Cookie; else axios.defaults.headers.common.Cookie = old.cookie;
  }
});

test('one deadline aborts an in-flight search without trying further sources', async () => {
  let requests = 0;
  const server = http.createServer(() => { requests++; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  const seen = [];
  axios.get = (endpoint, opts) => { seen.push(endpoint); return originals.get(local, { ...opts, proxy: false }); };
  try {
    const found = await search.searchProvider('reddit', 'title', { timeoutMs: 300 });
    assert.equal(found.status, 'unavailable');
    assert.equal(requests, 1);
    assert.equal(seen.length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('empty, unavailable, invalid and oversized searches stay bounded', async () => {
  assert.equal((await search.searchProvider('reddit', '')).status, 'invalid');
  assert.equal((await search.searchProvider('reddit', 'a'.repeat(201))).status, 'invalid');
  assert.equal((await search.searchProvider('reddit', 'title')).status, 'unavailable');
  axios.get = async (endpoint) => endpoint.includes('reddit')
    ? success({ data: { children: [] } }) : success('<div class="no-results"></div>');
  assert.equal((await search.searchProvider('reddit', 'title')).status, 'empty');
  axios.get = async () => success('x'.repeat(1024 * 1024 + 1));
  assert.equal((await search.searchProvider('reddit', 'title')).status, 'unavailable');
});

test('malicious title markup and control characters cannot forge picker lines', () => {
  const rows = search.normalizeRows('reddit', [{ url: example, title: 'Hello<br>*.9 fake*\u202e\nWorld', author: '<b>Person</b>' }], 5);
  assert.equal(rows[0].title, 'Hello.9 fake World');
  assert.equal(rows[0].author, 'Person');
  assert.equal(rows[0].title.includes('\n'), false);
});
