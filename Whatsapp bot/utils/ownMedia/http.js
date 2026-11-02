'use strict';

/**
 * Brick 1 — transport.
 *
 * Plain HTTPS with an allowlisted host, bounded response sizes and a streamed
 * downloader. `setTransportForTests` / `setDownloadForTests` make the whole
 * engine testable offline without a YouTube connection.
 */

const fs = require('fs');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const C = require('./constants');

class EngineError extends Error {
  constructor(code, message, detail = '') {
    super(message || code);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }
}

function assertSafe(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); }
  catch { throw new EngineError('BAD_URL', 'Not a valid URL'); }
  if (parsed.protocol !== 'https:') throw new EngineError('UNSAFE_URL', 'Only https is allowed');
  if (parsed.username || parsed.password) throw new EngineError('UNSAFE_URL', 'URL credentials are not allowed');
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = C.STREAM_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!allowed) throw new EngineError('UNSAFE_URL', `Host not allowed: ${host}`);
  return parsed;
}

let transport = null;
let downloader = null;
const setTransportForTests = (fn) => { transport = typeof fn === 'function' ? fn : null; };
const setDownloadForTests = (fn) => { downloader = typeof fn === 'function' ? fn : null; };

function normalize(res) {
  if (res == null) return { status: 204, body: '', headers: {} };
  if (typeof res === 'string' || Buffer.isBuffer(res)) return { status: 200, body: res, headers: {} };
  return {
    status: Number(res.status ?? res.statusCode ?? 200),
    body: res.body ?? res.data ?? '',
    headers: res.headers || {},
  };
}

/** @returns {Promise<{status:number,body:any,headers:object}>} */
async function request(method, url, { body = null, headers = {}, timeout = C.REQUEST_TIMEOUT_MS } = {}) {
  const target = assertSafe(url);
  const requestHeaders = {
    'User-Agent': C.UA_DESKTOP,
    Accept: 'application/json',
    ...headers,
  };
  let result;
  if (transport) {
    result = normalize(await transport(String(target), { method, headers: requestHeaders, body, timeout }));
  } else {
    const res = await axios.request({
      url: String(target), method,
      headers: requestHeaders,
      data: body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      timeout,
      responseType: 'text',
      maxContentLength: 8 * 1024 * 1024,
      maxRedirects: 3,
      validateStatus: () => true,
      beforeRedirect: (redirectOptions) => {
        const proto = redirectOptions.protocol || 'https:';
        const host = redirectOptions.hostname || redirectOptions.host || '';
        assertSafe(`${proto}//${host}${redirectOptions.path || '/'}`);
      },
    });
    result = { status: res.status, body: res.data, headers: res.headers || {} };
  }
  if (result.status < 200 || result.status >= 300) {
    throw new EngineError(`HTTP_${result.status}`, `Source answered HTTP ${result.status}`);
  }
  return result;
}

async function postJson(url, body, opts = {}) {
  const res = await request('POST', url, {
    ...opts,
    body,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });
  try { return typeof res.body === 'string' ? JSON.parse(res.body) : res.body; }
  catch { throw new EngineError('BAD_JSON', 'Source returned unreadable JSON'); }
}

async function getJson(url, opts = {}) {
  const res = await request('GET', url, opts);
  try { return typeof res.body === 'string' ? JSON.parse(res.body) : res.body; }
  catch { throw new EngineError('BAD_JSON', 'Source returned unreadable JSON'); }
}

async function getText(url, opts = {}) {
  const res = await request('GET', url, opts);
  return String(res.body ?? '');
}

/**
 * Stream a media URL to disk. Never buffers the whole file in memory.
 * @returns {Promise<{file:string,bytes:number,contentType:string}>}
 */
async function streamTo(url, dest, {
  maxBytes = C.MAX_VIDEO_MB * 1024 * 1024,
  timeout = C.DOWNLOAD_TIMEOUT_MS,
  headers = {},
} = {}) {
  assertSafe(url);
  if (downloader) return downloader(String(url), dest, { maxBytes, timeout, headers });

  const res = await axios.get(String(url), {
    responseType: 'stream',
    timeout,
    maxRedirects: 5,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: { 'User-Agent': C.UA_DESKTOP, Accept: '*/*', 'Accept-Encoding': 'identity', ...headers },
    validateStatus: () => true,
    beforeRedirect: (redirectOptions) => {
      const proto = redirectOptions.protocol || 'https:';
      const host = redirectOptions.hostname || redirectOptions.host || '';
      assertSafe(`${proto}//${host}${redirectOptions.path || '/'}`);
    },
  });

  if (res.status >= 400) {
    try { res.data.destroy(); } catch { /* ignore */ }
    throw new EngineError(`HTTP_${res.status}`, `Media host answered HTTP ${res.status}`);
  }
  const contentType = String(res.headers['content-type'] || '');
  if (/text\/|json/.test(contentType)) {
    try { res.data.destroy(); } catch { /* ignore */ }
    throw new EngineError('BAD_SOURCE', 'Media host returned a web page instead of a file');
  }

  const expected = Number(res.headers['content-length']) || 0;
  if (expected && expected > maxBytes) {
    res.data.destroy();
    throw new EngineError('TOO_BIG', 'File exceeds the size limit');
  }

  let bytes = 0;
  res.data.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      res.data.destroy(Object.assign(new Error('file exceeds the size limit'), { code: 'TOO_BIG' }));
    }
  });

  try {
    await pipeline(res.data, fs.createWriteStream(dest));
  } catch (err) {
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    throw new EngineError(err.code === 'TOO_BIG' ? 'TOO_BIG' : 'DOWNLOAD_FAILED', err.message);
  }
  if (bytes < 10 * 1024) {
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    throw new EngineError('BAD_SOURCE', 'Downloaded file is too small to be media');
  }
  return { file: dest, bytes, contentType };
}

module.exports = {
  EngineError, assertSafe, request, postJson, getJson, getText, streamTo,
  setTransportForTests, setDownloadForTests,
};
