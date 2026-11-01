/**
 * Deezer track search and streaming, adapted from the MIT-licensed
 * kmille/deezer-downloader (https://github.com/kmille/deezer-downloader).
 * Copyright (c) 2021 kmille; see docs/third-party/deezer-downloader-LICENSE.
 *
 * The owner's ARL and session credentials go only to Deezer's fixed gateway.
 * The license and track tokens go only to Deezer's media endpoint; CDN
 * requests carry none of them. No account data or request bodies are logged.
 */
const fs = require('fs');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const config = require('../config');

const API = 'https://api.deezer.com';
const GATEWAY = 'https://www.deezer.com/ajax/gw-light.php';
const USER_URL = `${GATEWAY}?method=deezer.getUserData&input=3&api_version=1.0&api_token=`;
const MEDIA_URL = 'https://media.deezer.com/v1/get_url';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0';
const BLOCK = 2048;
const STRIPE_KEY = Buffer.from('g4el58wc0zvf9na1', 'ascii');
const IV = Buffer.from('0001020304050607', 'hex');

// Diagnostics are restricted to these fixed labels; never copy a request,
// response body, URL, cookie, token, or arbitrary upstream error into logs.
const DIAGNOSTIC_STAGES = new Set(['search', 'metadata', 'gateway-search', 'gateway-metadata', 'account', 'track-token', 'media', 'cdn', 'stream', 'decoder', 'storage', 'share']);
const DIAGNOSTIC_REASONS = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_NETWORK',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EROFS', 'ENOSPC', 'EDQUOT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG',
  'EMFILE', 'ENFILE', 'EFBIG', 'EIO', 'EBADF', 'ABORT_ERR', 'RATE_LIMIT', 'INVALID_RESPONSE',
]);
const STORAGE_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EROFS', 'ENOSPC', 'EDQUOT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'EMFILE', 'ENFILE', 'EFBIG', 'EIO', 'EBADF']);
const STORAGE_SYSCALLS = new Set(['open', 'write', 'writev', 'stat', 'fstat', 'fsync', 'close']);
// A different authenticated Deezer endpoint can help when only the public API
// is unreachable. Never use it to get around a quota, access denial or an
// unavailable track.
const PUBLIC_API_TRANSPORT_FAILURES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_NETWORK',
]);
const DIAGNOSTIC_CODES = new Set([
  'DEEZER_CONFIG', 'DEEZER_AUTH', 'DEEZER_NETWORK', 'DEEZER_TRACK', 'DEEZER_UNAVAILABLE', 'DEEZER_DECODER',
  'DEEZER_STORAGE', 'DEEZER_VERIFY', 'DEEZER_ERROR', 'BAD_SOURCE', 'TOO_BIG', 'TOO_LONG', 'NOT_ENOUGH_DISK',
]);

function diagnosticDetails(value) {
  const info = {};
  if (DIAGNOSTIC_STAGES.has(value?.stage)) info.stage = value.stage;
  if (Number.isInteger(value?.status) && value.status >= 100 && value.status <= 599) info.status = value.status;
  if (DIAGNOSTIC_REASONS.has(value?.reason)) info.reason = value.reason;
  return info;
}

function diagnosticCode(value) {
  return typeof value === 'string' && DIAGNOSTIC_CODES.has(value) ? value : 'DEEZER_ERROR';
}

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, diagnosticDetails(details));
}

function errorReason(err) {
  for (const value of [err?.code, err?.cause?.code]) {
    if (DIAGNOSTIC_REASONS.has(value)) return value;
  }
  return undefined;
}

function isStorageCode(code) {
  return STORAGE_CODES.has(code);
}

function storageFailure(err) {
  const full = err?.code === 'ENOSPC' || err?.code === 'EDQUOT';
  return failure(full ? 'NOT_ENOUGH_DISK' : 'DEEZER_STORAGE', full ? 'Server storage is full' : 'Deezer could not write the audio file',
    { stage: 'storage', reason: errorReason(err) });
}

function hasErrors(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

const configured = () => Boolean(String(config.deezer?.arl || '').trim());

/** Only recognize actual Deezer hosts; a look-alike domain is not a Deezer link. */
function deezerUrl(input) {
  try {
    const raw = String(input || '').trim();
    const url = new URL(/^(?:www\.)?deezer\.com\//i.test(raw) ? `https://${raw}` : raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return ['deezer.com', 'www.deezer.com', 'link.deezer.com', 'deezer.page.link'].includes(host) ? url : null;
  } catch { return null; }
}

function trackId(input) {
  const url = deezerUrl(input);
  if (!url || !['deezer.com', 'www.deezer.com'].includes(url.hostname.toLowerCase().replace(/\.$/, ''))) return null;
  const match = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?track\/(\d{1,16})\/?$/i);
  return match ? match[1] : null;
}

/** Full streams come from Deezer's CDN, never an arbitrary API-supplied host. */
function validMediaUrl(value) {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      (h === 'dzcdn.net' || h.endsWith('.dzcdn.net') || h === 'deezer.com' || h.endsWith('.deezer.com'));
  } catch { return false; }
}

function songKey(id) {
  if (!/^\d{1,16}$/.test(String(id))) throw failure('DEEZER_TRACK', 'Invalid track ID');
  const hash = Buffer.from(crypto.createHash('md5').update(String(id)).digest('hex'), 'ascii');
  return Buffer.from(Array.from({ length: 16 }, (_, i) => hash[i] ^ hash[i + 16] ^ STRIPE_KEY[i]));
}

/** Decrypt complete stripes and preserve partial blocks and trailing zero bytes. */
async function stripeDecoder(id, maxBytes) {
  const { Blowfish } = await import('egoroof-blowfish');
  const cipher = new Blowfish(songKey(id), Blowfish.MODE.CBC, Blowfish.PADDING.NULL);
  cipher.setIv(IV);
  let index = 0;
  let pending = Buffer.alloc(0);
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      try {
        bytes += chunk.length;
        if (bytes > maxBytes) return done(failure('TOO_BIG', 'Track exceeds size limit'));
        const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let offset = 0;
        while (offset + BLOCK <= data.length) {
          const block = data.subarray(offset, offset + BLOCK);
          if (index % 3 === 0) {
            // NULL unpadding can remove real zeros; restore them to the known
            // 2048-byte stripe size. Each stripe uses the original IV.
            const decoded = Buffer.from(cipher.decode(block, Blowfish.TYPE.UINT8_ARRAY));
            this.push(decoded.length === BLOCK ? decoded : Buffer.concat([decoded, Buffer.alloc(BLOCK - decoded.length)]));
          } else this.push(block);
          index++;
          offset += BLOCK;
        }
        pending = Buffer.from(data.subarray(offset));
        done();
      } catch { done(failure('BAD_SOURCE', 'Could not decode the track')); }
    },
    flush(done) { if (pending.length) this.push(pending); done(); },
  });
}

function sameRecording(track, expected, { requireIsrc = false } = {}) {
  if (!expected) return true;
  const norm = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  const wanted = norm(expected.title);
  const actual = norm(track.title);
  if (!wanted || wanted !== actual) return false;
  const first = norm(String(expected.artist || '').split(/[,·]/)[0]);
  const artist = norm(track.artist);
  if (!first || !artist || first !== artist) return false;
  const wantedIsrc = String(expected.isrc || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  const actualIsrc = String(track.isrc || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (wantedIsrc && (actualIsrc ? wantedIsrc !== actualIsrc : requireIsrc)) return false;
  const seconds = Number(expected.duration) || 0;
  return !seconds || (track.duration > 0 && Math.abs(seconds - track.duration) <= Math.max(12, seconds * 0.08));
}

function normalizedTrack(row) {
  const id = String(row?.id || '');
  if (!/^\d{1,16}$/.test(id) || !row?.title) return null;
  return {
    id, url: `https://www.deezer.com/track/${id}`,
    title: String(row.title).slice(0, 250),
    artist: String(row.artist?.name || '').slice(0, 200),
    album: String(row.album?.title || '').slice(0, 250),
    isrc: typeof row.isrc === 'string' ? row.isrc.slice(0, 30) : '',
    duration: Math.max(0, Number(row.duration) || 0),
    thumbnail: String(row.album?.cover_medium || '').slice(0, 1000),
  };
}

// The account gateway uses a different response shape from the public API.
// Keep only display metadata; in particular, never return its track token.
function normalizedGatewayTrack(row) {
  if (typeof row?.SNG_TITLE !== 'string') return null;
  const title = row.SNG_TITLE.trim();
  const version = typeof row.VERSION === 'string' ? row.VERSION.trim().slice(0, 150) : '';
  const versionText = version.replace(/^\((.*)\)$/, '$1').trim();
  const lowerTitle = title.toLowerCase();
  const lowerVersion = versionText.toLowerCase();
  const versionSuffixes = [` (${lowerVersion})`, ` [${lowerVersion}]`, ` - ${lowerVersion}`, ` – ${lowerVersion}`, ` — ${lowerVersion}`];
  const hasVersionSuffix = lowerTitle === lowerVersion || versionSuffixes.some((suffix) => lowerTitle.endsWith(suffix));
  const fullTitle = title && versionText && !hasVersionSuffix ? `${title} (${versionText})` : title;
  const primaryArtist = Array.isArray(row?.ARTISTS) ? row.ARTISTS[0]?.ART_NAME : '';
  return normalizedTrack({
    id: row?.SNG_ID,
    title: fullTitle,
    artist: { name: row?.ART_NAME || primaryArtist || '' },
    album: { title: row?.ALB_TITLE || '' },
    isrc: row?.ISRC,
    duration: row?.DURATION,
  });
}

function createClient({ http = axios, arl = config.deezer?.arl || '', makeDecoder = stripeDecoder } = {}) {
  const cookie = String(arl).trim();
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  const options = { timeout: 15_000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, validateStatus: () => true };

  async function request(method, url, body, { stage, ...extra } = {}) {
    let response;
    try {
      const opts = { ...options, ...extra, headers: { ...headers, ...(extra.headers || {}) } };
      response = method === 'post' ? await http.post(url, body, opts) : await http.get(url, opts);
    } catch (err) { throw failure('DEEZER_NETWORK', 'Deezer request failed', { stage, reason: errorReason(err) }); }
    const status = response?.status;
    if (!Number.isInteger(status)) throw failure('DEEZER_NETWORK', 'Deezer request failed', { stage, reason: 'INVALID_RESPONSE' });
    if (status === 401 || status === 403) {
      const code = ['account', 'gateway-search', 'gateway-metadata', 'track-token', 'media'].includes(stage) ? 'DEEZER_AUTH' : 'DEEZER_NETWORK';
      throw failure(code, 'Deezer rejected the request', { stage, status });
    }
    if (status < 200 || status >= 300) {
      const retryAfter = response?.headers?.['retry-after'] || response?.headers?.['Retry-After'];
      const reason = retryAfter && (status === 429 || status === 503) ? 'RATE_LIMIT' : undefined;
      throw failure('DEEZER_NETWORK', 'Deezer request failed', { stage, status, reason });
    }
    return response.data;
  }

  function canTryGateway(err) {
    return Boolean(cookie) && err?.code === 'DEEZER_NETWORK' && err.reason !== 'RATE_LIMIT' &&
      (PUBLIC_API_TRANSPORT_FAILURES.has(err.reason) || [502, 503, 504].includes(err.status));
  }

  async function gatewayRequest(method, payload, auth, stage) {
    const params = new URLSearchParams({ method, input: '3', api_version: '1.0', api_token: auth.apiToken });
    const data = await request('post', `${GATEWAY}?${params}`, payload, { stage, headers: {
      Cookie: `arl=${cookie}; comeback=1; sid=${auth.sessionId}`, Origin: 'https://www.deezer.com',
      Referer: 'https://www.deezer.com/', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json',
    } });
    if (!data || hasErrors(data.error) || !Array.isArray(data?.results?.data)) {
      throw failure('DEEZER_NETWORK', 'Deezer gateway lookup failed', { stage, reason: 'INVALID_RESPONSE' });
    }
    return data.results.data;
  }

  async function publicSearch(text, count) {
    const params = new URLSearchParams({ q: text, limit: String(count) });
    const data = await request('get', `${API}/search/track?${params}`, null, { stage: 'search' });
    if (!data || data.error || !Array.isArray(data.data)) {
      const reason = Number(data?.error?.code) === 4 ? 'RATE_LIMIT' : 'INVALID_RESPONSE';
      throw failure('DEEZER_NETWORK', 'Deezer search failed', { stage: 'search', reason });
    }
    return data.data.map(normalizedTrack).filter(Boolean).slice(0, count);
  }

  async function gatewaySearch(text, count, auth) {
    const rows = await gatewayRequest('search.music', {
      query: text, output: 'TRACK', filter: 'all', start: 0, nb: count,
    }, auth, 'gateway-search');
    return rows.map(normalizedGatewayTrack).filter(Boolean).slice(0, count);
  }

  async function search(query, { limit = 5 } = {}) {
    const text = String(query || '').trim().slice(0, 300);
    if (!text) return [];
    const count = Math.max(1, Math.min(10, Math.floor(Number(limit) || 5)));
    try { return await publicSearch(text, count); }
    catch (err) {
      if (!canTryGateway(err)) throw err;
      // Preserve the public-API diagnostic if the account gateway also fails.
      try { return await gatewaySearch(text, count, await session()); }
      catch { throw err; }
    }
  }

  async function resolveTrackId(input) {
    const fullId = trackId(input);
    if (fullId) return fullId;
    let url = deezerUrl(input);
    const shortHosts = new Set(['link.deezer.com', 'deezer.page.link']);
    for (let i = 0; i < 4 && url && shortHosts.has(url.hostname.toLowerCase()); i++) {
      if (url.protocol !== 'https:') break;
      let response;
      try {
        // Do not follow a share link automatically: it could redirect anywhere.
        response = await http.get(url.href, { ...options, responseType: 'stream', headers });
      } catch (err) { throw failure('DEEZER_NETWORK', 'Deezer link could not be opened', { stage: 'share', reason: errorReason(err) }); }
      response?.data?.destroy?.();
      if (!Number.isInteger(response?.status) || response.status >= 400) {
        throw failure('DEEZER_NETWORK', 'Deezer link could not be opened', { stage: 'share', status: response?.status });
      }
      if (response.status < 300 || response.status >= 400 || !response.headers?.location) break;
      try { url = deezerUrl(new URL(response.headers.location, url).href); } catch { url = null; }
      if (!url || url.protocol !== 'https:') break;
      const id = trackId(url.href);
      if (id) return id;
    }
    throw failure('DEEZER_TRACK', 'Use a Deezer track link');
  }

  async function publicTrack(id) {
    if (!/^\d{1,16}$/.test(String(id))) throw failure('DEEZER_TRACK', 'Invalid track ID');
    const data = await request('get', `${API}/track/${id}`, null, { stage: 'metadata' });
    if (Number(data?.error?.code) === 4) throw failure('DEEZER_NETWORK', 'Deezer track lookup was rate limited', { stage: 'metadata', reason: 'RATE_LIMIT' });
    const track = normalizedTrack(data);
    if (!track || track.id !== String(id)) throw failure('DEEZER_TRACK', 'Track unavailable', { stage: 'metadata' });
    return track;
  }

  async function gatewayTrack(id, auth) {
    const rows = await gatewayRequest('song.getListData', { sng_ids: [String(id)] }, auth, 'gateway-metadata');
    const track = rows.map(normalizedGatewayTrack).find((item) => item?.id === String(id));
    if (!track) throw failure('DEEZER_TRACK', 'Track unavailable', { stage: 'gateway-metadata' });
    return track;
  }

  async function getTrack(id) {
    if (!/^\d{1,16}$/.test(String(id))) throw failure('DEEZER_TRACK', 'Invalid track ID');
    try { return await publicTrack(id); }
    catch (err) {
      if (!canTryGateway(err)) throw err;
      try { return await gatewayTrack(id, await session()); }
      catch { throw err; }
    }
  }

  async function session() {
    if (!cookie) throw failure('DEEZER_CONFIG', 'Deezer is not configured', { stage: 'account' });
    // Restrict cookie syntax so a misconfigured value cannot inject headers or
    // append additional cookies. Never include the value in an error.
    if (!/^[A-Za-z0-9_-]{10,512}$/.test(cookie)) throw failure('DEEZER_AUTH', 'Invalid Deezer cookie', { stage: 'account' });
    const data = await request('get', USER_URL, null, { stage: 'account', headers: {
      Cookie: `arl=${cookie}; comeback=1`, Origin: 'https://www.deezer.com',
      Referer: 'https://www.deezer.com/', 'X-Requested-With': 'XMLHttpRequest',
    } });
    const results = data?.results;
    const user = results?.USER;
    const licenseToken = user?.OPTIONS?.license_token;
    const apiToken = results?.checkForm;
    const sessionId = results?.SESSION_ID;
    // Logged-out sessions can also have a license token; require a real user
    // and the session/CSRF values needed for the account-scoped track request.
    if (hasErrors(data?.error) || !/^[1-9]\d{0,20}$/.test(String(user?.USER_ID || '')) ||
        typeof licenseToken !== 'string' || !licenseToken || licenseToken.length > 4096 || /\s/.test(licenseToken) ||
        typeof apiToken !== 'string' || !apiToken || apiToken.length > 4096 || /\s/.test(apiToken) ||
        typeof sessionId !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(sessionId)) {
      throw failure('DEEZER_AUTH', 'Deezer did not accept the account', { stage: 'account' });
    }
    const quality = user.OPTIONS.web_sound_quality;
    return { licenseToken, apiToken, sessionId, premium: quality?.high === true || quality?.lossless === true };
  }

  async function trackToken(id, auth) {
    const params = new URLSearchParams({ method: 'song.getData', input: '3', api_version: '1.0', api_token: auth.apiToken });
    const data = await request('post', `${GATEWAY}?${params}`, { sng_id: String(id) }, { stage: 'track-token', headers: {
      Cookie: `arl=${cookie}; comeback=1; sid=${auth.sessionId}`, Origin: 'https://www.deezer.com',
      Referer: 'https://www.deezer.com/', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json',
    } });
    const result = data?.results;
    if (hasErrors(data?.error) || String(result?.SNG_ID || '') !== String(id) ||
        typeof result?.TRACK_TOKEN !== 'string' || !result.TRACK_TOKEN || result.TRACK_TOKEN.length > 4096 || /\s/.test(result.TRACK_TOKEN)) {
      throw failure('DEEZER_UNAVAILABLE', 'Track unavailable for this account', { stage: 'track-token' });
    }
    return result.TRACK_TOKEN;
  }

  async function media(token, auth, format) {
    const data = await request('post', MEDIA_URL, {
      license_token: auth.licenseToken,
      media: [{ type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format }] }],
      track_tokens: [token],
    }, { stage: 'media', headers: { 'Content-Type': 'application/json' } });
    const item = data?.data?.[0];
    const candidate = Array.isArray(item?.media) ? item.media.find((m) => Array.isArray(m?.sources) && m.sources.length) : null;
    const cipher = typeof candidate?.cipher === 'string' ? candidate.cipher : candidate?.cipher?.type;
    if (!candidate || hasErrors(item.errors) || (cipher && cipher !== 'BF_CBC_STRIPE')) throw failure('DEEZER_UNAVAILABLE', 'Track unavailable for this account', { stage: 'media' });
    const source = candidate.sources.find((s) => validMediaUrl(s?.url));
    if (!source) throw failure('DEEZER_UNAVAILABLE', 'Track unavailable for this account', { stage: 'media' });
    return source.url;
  }

  async function resolveMedia(token, auth) {
    // High-quality accounts can use 320 kbps; if unavailable, try 128 kbps.
    try { return await media(token, auth, auth.premium ? 'MP3_320' : 'MP3_128'); }
    catch (err) {
      if (!auth.premium || err.code !== 'DEEZER_UNAVAILABLE') throw err;
      return media(token, auth, 'MP3_128');
    }
  }

  /** Read-only checks; the returned report never includes credentials or URLs. */
  async function diagnose(id = '3135553') {
    const report = {};
    const check = async (name, fn) => {
      try {
        const value = await fn();
        report[name] = { ok: true };
        return value;
      } catch (err) {
        report[name] = { ok: false, code: diagnosticCode(err?.code), ...diagnosticDetails(err) };
        return null;
      }
    };
    let [, track, auth] = await Promise.all([
      check('search', () => publicSearch('Daft Punk One More Time', 1)),
      check('metadata', () => publicTrack(id)),
      check('account', () => session()),
    ]);
    // Show public failures separately; use the same verified account to report
    // whether the narrow network fallback is actually reachable on this host.
    if (auth && canTryGateway(report.search)) {
      await check('gatewaySearch', () => gatewaySearch('Daft Punk One More Time', 1, auth));
    }
    if (auth && !track && canTryGateway(report.metadata)) {
      track = await check('gatewayMetadata', () => gatewayTrack(id, auth));
    }
    if (track && auth) {
      const token = await check('trackToken', () => trackToken(track.id, auth));
      if (token) await check('media', () => resolveMedia(token, auth));
    }
    if (!report.trackToken) report.trackToken = { skipped: true };
    if (!report.media) report.media = { skipped: true };
    return report;
  }

  async function download(id, dest, { maxBytes = 120 * 1024 * 1024, maxSeconds = 0, expected = null } = {}) {
    const track = await getTrack(id);
    if (!sameRecording(track, expected, { requireIsrc: true })) throw failure('BAD_SOURCE', 'Track metadata did not match');
    if (maxSeconds && track.duration > maxSeconds) throw failure('TOO_LONG', 'Track exceeds duration limit');
    const auth = await session();
    // Public track metadata does not reliably contain a usable token. Obtain a
    // fresh token for this exact track within the authenticated session.
    const token = await trackToken(track.id, auth);
    const url = await resolveMedia(token, auth);
    const signal = AbortSignal.timeout(180_000);
    let response;
    let nextUrl = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      try {
        response = await http.get(nextUrl, { ...options, timeout: 180_000, signal, responseType: 'stream',
          headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity' } });
      } catch (err) { throw failure('DEEZER_NETWORK', 'Deezer download failed', { stage: 'cdn', reason: errorReason(err) }); }
      if (!Number.isInteger(response?.status)) {
        response?.data?.destroy?.();
        throw failure('DEEZER_NETWORK', 'Deezer download failed', { stage: 'cdn', reason: 'INVALID_RESPONSE' });
      }
      if (response.status < 300 || response.status >= 400) break;
      response.data?.destroy?.();
      if (redirects === 3 || !response.headers?.location) throw failure('DEEZER_UNAVAILABLE', 'Invalid Deezer redirect', { stage: 'cdn', status: response.status });
      try { nextUrl = new URL(response.headers.location, nextUrl).href; } catch { nextUrl = ''; }
      if (!validMediaUrl(nextUrl)) throw failure('DEEZER_UNAVAILABLE', 'Invalid Deezer redirect', { stage: 'cdn', status: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
      response.data?.destroy?.();
      const network = response.status === 429 || response.status >= 500;
      throw failure(network ? 'DEEZER_NETWORK' : 'DEEZER_UNAVAILABLE', network ? 'Deezer download failed' : 'Track unavailable for this account',
        { stage: 'cdn', status: response.status });
    }
    const type = String(response.headers?.['content-type'] || '').toLowerCase();
    const length = Number(response.headers?.['content-length']) || 0;
    if (type.includes('text/') || type.includes('json') || (length && length > maxBytes)) {
      response.data?.destroy?.();
      throw failure(length > maxBytes ? 'TOO_BIG' : 'BAD_SOURCE', 'Invalid track response');
    }
    let decoder;
    try { decoder = await makeDecoder(track.id, maxBytes); }
    catch (err) {
      response.data?.destroy?.();
      throw failure('DEEZER_DECODER', 'Deezer decoder is unavailable', { stage: 'decoder', reason: errorReason(err) });
    }
    let created = false;
    let fd, output;
    try {
      try { fd = fs.openSync(dest, 'wx', 0o600); }
      catch (err) { throw storageFailure(err); }
      created = true;
      try { output = fs.createWriteStream(dest, { fd, autoClose: true }); }
      catch (err) { throw storageFailure(err); }
      fd = undefined; // the stream now owns the descriptor
      await pipeline(response.data, decoder, output, { signal });
      let bytes;
      try { bytes = fs.statSync(dest).size; }
      catch (err) { throw storageFailure(err); }
      if (bytes < 10 * 1024) throw failure('BAD_SOURCE', 'Track is too small');
      return { ...track, file: dest, bytes };
    } catch (err) {
      response.data?.destroy?.();
      decoder?.destroy?.();
      output?.destroy?.();
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
      if (created) { try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ } }
      if (['TOO_BIG', 'BAD_SOURCE', 'DEEZER_STORAGE', 'NOT_ENOUGH_DISK'].includes(err.code)) throw err;
      if (isStorageCode(err?.code) || STORAGE_SYSCALLS.has(err?.syscall)) throw storageFailure(err);
      throw failure('DEEZER_NETWORK', 'Deezer download failed', { stage: 'stream', reason: errorReason(err) });
    }
  }

  return { search, getTrack, resolveTrackId, session, diagnose, download };
}

module.exports = { configured, deezerUrl, trackId, validMediaUrl, createClient, songKey, stripeDecoder, sameRecording, diagnosticDetails, diagnosticCode, isStorageCode };
