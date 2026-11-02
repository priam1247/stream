'use strict';

/**
 * Small, allowlisted HTTP client for the keyless music catalogs.
 *
 * Only https URLs on the hosts below are ever fetched, and every URL is built
 * from an id we parsed ourselves — a chat message can never make the bot fetch
 * an arbitrary host. `setTransportForTests` swaps in an offline transport so
 * the regression tests never touch the network.
 */

const axios = require('axios');
const C = require('./constants');

class MusicSourceError extends Error {
  constructor(code, message, source = '') {
    super(message || code);
    this.name = 'MusicSourceError';
    this.code = code;
    this.source = source;
  }
}

// Host suffixes accepted for metadata, lyrics and artwork. Exact host or a
// subdomain of one of these; no IP literals, no userinfo, no plain http.
const ALLOWED_SUFFIXES = [
  'api.deezer.com', 'cdn-images.dzcdn.net',
  'itunes.apple.com', 'mzstatic.com',
  'open.spotify.com', 'api-partner.spotify.com', 'i.scdn.co',
  'soundcloud.com', 'api-v2.soundcloud.com', 'a-v2.sndcdn.com', 'sndcdn.com',
  'lrclib.net',
  'mobiles.kugou.com', 'lyrics.kugou.com',
  'music.163.com', 'music.126.net',
  'lyrics-api.binimum.org',
  'youtube.com', 'i.ytimg.com',
];

function assertSafe(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); }
  catch { throw new MusicSourceError('BAD_URL', 'Not a valid URL'); }
  if (parsed.protocol !== 'https:') throw new MusicSourceError('UNSAFE_URL', 'Only https is allowed');
  if (parsed.username || parsed.password) throw new MusicSourceError('UNSAFE_URL', 'URL credentials are not allowed');
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const ok = ALLOWED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!ok) throw new MusicSourceError('UNSAFE_URL', `Host not allowed: ${host}`);
  return parsed;
}

let transport = null;
/** Inject `(url, opts) => {status, body, headers}` for offline tests. */
function setTransportForTests(fn) { transport = typeof fn === 'function' ? fn : null; }

function normalizeResponse(res) {
  if (res === undefined || res === null) return { status: 204, body: '', headers: {} };
  if (typeof res === 'string' || Buffer.isBuffer(res)) return { status: 200, body: res, headers: {} };
  const status = Number(res.status ?? res.statusCode ?? 200);
  return { status, body: res.body ?? res.data ?? '', headers: res.headers || {} };
}

function asBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(String(body || ''), 'utf8');
}

/**
 * @param {'GET'|'POST'} method
 * @param {string} url absolute https URL
 * @param {{params?:object, headers?:object, body?:string|object, timeout?:number,
 *          binary?:boolean, maxBytes?:number}} [opts]
 */
async function raw(method, url, opts = {}) {
  const {
    params = null, headers = {}, body = null, timeout = C.REQUEST_TIMEOUT_MS,
    binary = false, maxBytes = C.MAX_RESPONSE_BYTES,
  } = opts;

  const target = new URL(String(url));
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
  }
  const finalUrl = target.toString();
  assertSafe(finalUrl);

  const requestHeaders = {
    'User-Agent': C.UA,
    Accept: binary ? '*/*' : 'application/json, text/html;q=0.9, */*;q=0.8',
    ...headers,
  };

  let result;
  if (transport) {
    result = normalizeResponse(await transport(finalUrl, {
      method, headers: requestHeaders, body, timeout, binary,
    }));
  } else {
    const payload = body === null ? undefined
      : (typeof body === 'string' ? body : JSON.stringify(body));
    const res = await axios.request({
      url: finalUrl,
      method,
      headers: requestHeaders,
      data: payload,
      timeout,
      responseType: binary ? 'arraybuffer' : 'text',
      maxContentLength: maxBytes,
      maxBodyLength: 1024 * 1024,
      maxRedirects: 3,
      validateStatus: null,
      // A provider can redirect, but only to another allowlisted host. Without
      // this a crafted `next` URL / redirect could turn the bot into an SSRF
      // client for arbitrary internal hosts.
      beforeRedirect: (redirectOptions) => {
        const protocol = redirectOptions.protocol || 'https:';
        const host = redirectOptions.hostname || redirectOptions.host || '';
        const path = redirectOptions.path || '/';
        assertSafe(`${protocol}//${host}${path}`);
      },
    });
    result = { status: res.status, body: res.data, headers: res.headers || {} };
  }

  if (result.status < 200 || result.status >= 300) {
    throw new MusicSourceError(`HTTP_${result.status}`, `Source answered HTTP ${result.status}`);
  }
  return { ...result, body: binary ? asBuffer(result.body) : result.body };
}

const getJson = async (url, opts = {}) => {
  const res = await raw('GET', url, opts);
  try { return JSON.parse(String(res.body)); }
  catch { throw new MusicSourceError('BAD_JSON', 'Source returned unreadable JSON'); }
};

const postJson = async (url, opts = {}) => {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts.headers || {}) };
  const res = await raw('POST', url, { ...opts, headers });
  try { return JSON.parse(String(res.body)); }
  catch { throw new MusicSourceError('BAD_JSON', 'Source returned unreadable JSON'); }
};

const getText = async (url, opts = {}) => String((await raw('GET', url, opts)).body || '');

const getBuffer = async (url, opts = {}) => asBuffer((await raw('GET', url, { ...opts, binary: true })).body);

/** Race a promise against a timeout without leaking an unhandled rejection. */
async function withTimeout(promise, ms, fallback = null) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = {
  MusicSourceError, assertSafe, setTransportForTests,
  raw, getJson, postJson, getText, getBuffer, withTimeout,
};
