const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { isPublicAddress, publicLookup, retryDelay, safeUrl, downloadPublicFile } = require('../lib/publicMediaDownload');
const { createPublicHttp, credentialHeaders } = require('../lib/publicHttp');

const response = (status, body = Buffer.alloc(11000), headers = {}) => ({ status, data: Readable.from([body]), headers });
const tempFile = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-public-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'file.bin');
};
const lookup = (fn, hostname, options = {}) => new Promise((resolve, reject) => {
  fn(hostname, options, (err, ...rows) => err ? reject(err) : resolve(rows));
});

test('public HTTP never inherits global credentials, headers or query parameters', async () => {
  const axios = require('axios');
  const old = { auth: axios.defaults.auth, params: axios.defaults.params,
    authorization: axios.defaults.headers.common.Authorization, cookie: axios.defaults.headers.common.Cookie,
    apiKey: axios.defaults.headers.common['X-Api-Key'], proxyAuthorization: axios.defaults.headers.common['Proxy-Authorization'] };
  axios.defaults.auth = { username: 'fixture', password: 'secret' };
  axios.defaults.params = { token: 'fixture' };
  axios.defaults.headers.common.Authorization = 'fixture';
  axios.defaults.headers.common.Cookie = 'fixture';
  axios.defaults.headers.common['X-Api-Key'] = 'fixture';
  axios.defaults.headers.common['Proxy-Authorization'] = 'fixture';
  try {
    const client = createPublicHttp(async (config) => {
      assert.equal(config.auth, null);
      assert.equal(config.proxy, false);
      assert.deepEqual(config.params, { query: 'song' });
      for (const key of ['Authorization', 'Cookie', 'X-Api-Key', 'Proxy-Authorization']) assert.equal(config.headers.has(key), false);
      return { status: 200, data: {}, headers: {}, config };
    });
    await client.get('https://media.example.org/v1/tracks/search', { params: { query: 'song' }, headers: { ...credentialHeaders } });
  } finally {
    for (const [key, value] of [['auth', old.auth], ['params', old.params]]) {
      if (value === undefined) delete axios.defaults[key]; else axios.defaults[key] = value;
    }
    for (const [key, value] of [['Authorization', old.authorization], ['Cookie', old.cookie], ['X-Api-Key', old.apiKey], ['Proxy-Authorization', old.proxyAuthorization]]) {
      if (value === undefined) delete axios.defaults.headers.common[key]; else axios.defaults.headers.common[key] = value;
    }
  }
});

test('public address checking rejects private, local, reserved and mapped addresses', () => {
  for (const addr of ['127.0.0.1', '10.3.2.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '192.0.2.1', '198.18.1.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1', 'not-an-ip']) {
    assert.equal(isPublicAddress(addr), false, addr);
  }
  for (const addr of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) assert.equal(isPublicAddress(addr), true, addr);
});

test('DNS lookup pins a public answer and rejects mixed or private results', async () => {
  const publicRows = [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }];
  const fn = publicLookup(async () => publicRows);
  assert.deepEqual(await lookup(fn, 'example.org'), ['8.8.8.8', 4]);
  assert.deepEqual(await lookup(fn, 'example.org', { all: true, family: 6 }), [[publicRows[1]]]);
  for (const rows of [[], [{ address: '127.0.0.1', family: 4 }], [publicRows[0], { address: '10.0.0.2', family: 4 }]]) {
    await assert.rejects(lookup(publicLookup(async () => rows), 'example.org'), { code: 'UNSAFE_SOURCE' });
  }
  await assert.rejects(lookup(publicLookup(async () => { throw new Error('dns failed'); }), 'example.org'), { code: 'MEDIA_NETWORK' });
});

test('only HTTPS DNS names on allowed ports and optional exact hosts are accepted', () => {
  assert.equal(safeUrl('https://media.example.org/audio').hostname, 'media.example.org');
  for (const url of ['http://media.example.org/file', 'https://user:pass@media.example.org/file', 'https://media.example.org:8443/file',
    'https://127.0.0.1/file', 'https://2130706433/file', 'https://[::1]/file', 'https://localhost/file',
    'https://sub.localhost./file', 'https://router.local/file', 'not a url']) {
    assert.throws(() => safeUrl(url), { code: 'UNSAFE_SOURCE' }, url);
  }
  const allowed = new Set(['upload.wikimedia.org']);
  assert.equal(safeUrl('https://upload.wikimedia.org/file', allowed).hostname, 'upload.wikimedia.org');
  assert.throws(() => safeUrl('https://upload.wikimedia.org.evil.test/file', allowed), { code: 'UNSAFE_SOURCE' });
});

test('public downloads allow a browser agent but discard supplied credentials and unsafe headers', async (t) => {
  const dest = tempFile(t);
  const request = async (_url, opts) => {
    assert.equal(opts.headers['User-Agent'], 'Public browser');
    assert.equal(opts.headers.Referer, 'https://www.youtube.com/');
    assert.equal(opts.headers.Cookie, undefined);
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(opts.headers['X-Api-Key'], undefined);
    return response(200, Buffer.alloc(12000), { 'content-length': '12000' });
  };
  await downloadPublicFile('https://media.example.org/file', dest, {
    maxBytes: 20000, request,
    headers: { 'User-Agent': 'Public browser', Referer: 'https://www.youtube.com/', Cookie: 'secret', Authorization: 'secret', 'X-Api-Key': 'secret' },
  });
});

test('a permitted public redirect is streamed to disk with hardened request options', async (t) => {
  const dest = tempFile(t);
  const calls = [];
  const bytes = Buffer.alloc(12000, 0x5a);
  const request = async (url, opts) => {
    calls.push(url);
    assert.equal(opts.proxy, false);
    assert.equal(opts.maxRedirects, 0);
    assert.equal(opts.headers['Accept-Encoding'], 'identity');
    assert.equal(opts.headers.Cookie, undefined);
    assert.deepEqual(await lookup(opts.httpsAgent.options.lookup, new URL(url).hostname), ['8.8.8.8', 4]);
    return calls.length === 1
      ? response(302, Buffer.alloc(0), { location: 'https://node.example.org/track' })
      : response(200, bytes, { 'content-length': String(bytes.length), 'content-type': 'audio/mpeg' });
  };
  const result = await downloadPublicFile('https://media.example.org/download', dest, {
    maxBytes: 20000, request, resolve: async () => [{ address: '8.8.8.8', family: 4 }],
  });
  assert.deepEqual(calls, ['https://media.example.org/download', 'https://node.example.org/track']);
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(fs.readFileSync(dest), bytes);
});

test('unsafe, cross-host restricted, and excessive redirects never reach their targets', async (t) => {
  for (const [location, extra, code] of [
    ['http://node.example.org/a', {}, 'UNSAFE_SOURCE'],
    ['https://127.0.0.1/a', {}, 'UNSAFE_SOURCE'],
    ['https://user@node.example.org/a', {}, 'UNSAFE_SOURCE'],
    ['https://node.example.org/a', { allowedHosts: ['upload.wikimedia.org'] }, 'UNSAFE_SOURCE'],
    ['https://upload.wikimedia.org/again', { allowedHosts: ['upload.wikimedia.org'], maxRedirects: 0 }, 'BAD_SOURCE'],
  ]) {
    const dest = tempFile(t);
    let calls = 0;
    await assert.rejects(downloadPublicFile('https://upload.wikimedia.org/start', dest, {
      maxBytes: 20000, ...extra, request: async () => { calls++; return response(302, Buffer.alloc(0), { location }); },
    }), { code });
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(dest), false);
  }
});

test('disabled downloads, partial replies, pages and oversized bodies are refused', async (t) => {
  for (const [res, code] of [
    [response(403), 'MEDIA_UNAVAILABLE'], [response(404), 'MEDIA_UNAVAILABLE'], [response(429), 'MEDIA_RATE_LIMIT'],
    [response(206), 'MEDIA_NETWORK'],
    [response(200, Buffer.alloc(11000), { 'content-type': 'text/html' }), 'BAD_SOURCE'],
    [response(200, Buffer.alloc(11000), { 'content-type': 'application/json' }), 'BAD_SOURCE'],
    [response(200, Buffer.alloc(11000), { 'content-length': '999999' }), 'TOO_BIG'],
    [response(200, Buffer.alloc(21000)), 'TOO_BIG'],
    [response(200, Buffer.alloc(11000), { 'content-length': '12000' }), 'BAD_SOURCE'],
    [response(200, Buffer.alloc(300)), 'BAD_SOURCE'],
  ]) {
    const dest = tempFile(t);
    await assert.rejects(downloadPublicFile('https://media.example.org/file', dest, { maxBytes: 20000, request: async () => res }), { code });
    assert.equal(fs.existsSync(dest), false);
  }
});

test('honors a short Retry-After once and never bypasses repeated or long rate limits', async (t) => {
  const dest = tempFile(t);
  const bytes = Buffer.alloc(11000, 1);
  let calls = 0;
  const waits = [];
  const result = await downloadPublicFile('https://media.example.org/file', dest, {
    maxBytes: 20000, wait: async (ms) => { waits.push(ms); },
    request: async () => ++calls === 1 ? response(429, Buffer.alloc(0), { 'retry-after': '10' }) : response(200, bytes),
  });
  assert.equal(result.bytes, bytes.length);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [10000]);
  for (const header of ['60', 'nonsense', '']) {
    const blocked = tempFile(t);
    let attempts = 0;
    await assert.rejects(downloadPublicFile('https://media.example.org/file', blocked, {
      maxBytes: 20000, wait: async () => { throw new Error('must not retry'); },
      request: async () => { attempts++; return response(429, Buffer.alloc(0), { 'retry-after': header }); },
    }), { code: 'MEDIA_RATE_LIMIT' });
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await assert.rejects(downloadPublicFile('https://media.example.org/file', tempFile(t), {
    maxBytes: 20000, wait: async () => {},
    request: async () => { attempts++; return response(429, Buffer.alloc(0), { 'retry-after': '1' }); },
  }), { code: 'MEDIA_RATE_LIMIT' });
  assert.equal(attempts, 2);
  assert.equal(retryDelay('10'), 10000);
  assert.equal(retryDelay('60'), null);
  assert.equal(retryDelay(new Date(101000).toUTCString(), 100000), 1000);
});

test('unexpected HTTP status diagnostics expose only the status', async (t) => {
  const dest = tempFile(t);
  await assert.rejects(downloadPublicFile('https://media.example.org/file?signature=secret', dest, {
    maxBytes: 20000, request: async () => response(503),
  }), (err) => err.code === 'MEDIA_NETWORK' && err.status === 503 && !err.message.includes('secret'));
});

test('a pre-existing destination is never overwritten or deleted', async (t) => {
  const dest = tempFile(t);
  fs.writeFileSync(dest, 'do not delete');
  await assert.rejects(downloadPublicFile('https://media.example.org/file', dest, { maxBytes: 20000, request: async () => response(200) }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'do not delete');
});
