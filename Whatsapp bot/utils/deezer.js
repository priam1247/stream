/**
 * Deezer track search and streaming, adapted from the MIT-licensed
 * kmille/deezer-downloader (https://github.com/kmille/deezer-downloader).
 * Copyright (c) 2021 kmille; see docs/third-party/deezer-downloader-LICENSE.
 *
 * Only the owner's ARL is sent to Deezer's fixed login endpoint. The returned
 * license token is sent only to Deezer's media endpoint; CDN requests carry
 * neither credential. No account data or request bodies are logged.
 */
const fs = require('fs');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const config = require('../config');

const API = 'https://api.deezer.com';
const USER_URL = 'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=';
const MEDIA_URL = 'https://media.deezer.com/v1/get_url';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0';
const BLOCK = 2048;
const STRIPE_KEY = Buffer.from('g4el58wc0zvf9na1', 'ascii');
const IV = Buffer.from('0001020304050607', 'hex');

function failure(code, message) {
  return Object.assign(new Error(message), { code });
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

function createClient({ http = axios, arl = config.deezer?.arl || '' } = {}) {
  const cookie = String(arl).trim();
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  const options = { timeout: 15_000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, validateStatus: () => true };

  async function request(method, url, body, extra = {}) {
    let response;
    try {
      const opts = { ...options, ...extra, headers: { ...headers, ...(extra.headers || {}) } };
      response = method === 'post' ? await http.post(url, body, opts) : await http.get(url, opts);
    } catch { throw failure('DEEZER_NETWORK', 'Deezer request failed'); }
    if (response.status === 401 || response.status === 403) throw failure('DEEZER_AUTH', 'Deezer did not accept the account');
    if (response.status < 200 || response.status >= 300) throw failure('DEEZER_NETWORK', 'Deezer request failed');
    return response.data;
  }

  async function search(query, { limit = 5 } = {}) {
    const text = String(query || '').trim().slice(0, 300);
    if (!text) return [];
    const params = new URLSearchParams({ q: text, limit: String(Math.max(1, Math.min(10, Number(limit) || 5))) });
    const data = await request('get', `${API}/search/track?${params}`);
    if (!data || data.error || !Array.isArray(data.data)) throw failure('DEEZER_NETWORK', 'Deezer search failed');
    return data.data.map(normalizedTrack).filter(Boolean).slice(0, 10);
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
      } catch { throw failure('DEEZER_NETWORK', 'Deezer link could not be opened'); }
      response.data?.destroy?.();
      if (response.status < 300 || response.status >= 400 || !response.headers?.location) break;
      try { url = deezerUrl(new URL(response.headers.location, url).href); } catch { url = null; }
      if (!url || url.protocol !== 'https:') break;
      const id = trackId(url.href);
      if (id) return id;
    }
    throw failure('DEEZER_TRACK', 'Use a Deezer track link');
  }

  async function getTrack(id) {
    if (!/^\d{1,16}$/.test(String(id))) throw failure('DEEZER_TRACK', 'Invalid track ID');
    const data = await request('get', `${API}/track/${id}`);
    const track = normalizedTrack(data);
    if (!track || track.id !== String(id) || typeof data.track_token !== 'string' || !data.track_token || data.track_token.length > 4096) {
      throw failure('DEEZER_TRACK', 'Track unavailable');
    }
    return { ...track, trackToken: data.track_token };
  }

  async function session() {
    if (!cookie) throw failure('DEEZER_CONFIG', 'Deezer is not configured');
    // Restrict cookie syntax so a misconfigured value cannot inject headers or
    // append additional cookies. Never include the value in an error.
    if (!/^[A-Za-z0-9_-]{10,512}$/.test(cookie)) throw failure('DEEZER_AUTH', 'Invalid Deezer cookie');
    const data = await request('get', USER_URL, null, { headers: {
      Cookie: `arl=${cookie}; comeback=1`, Origin: 'https://www.deezer.com',
      Referer: 'https://www.deezer.com/', 'X-Requested-With': 'XMLHttpRequest',
    } });
    const user = data?.results?.USER?.OPTIONS;
    if (typeof user?.license_token !== 'string' || !user.license_token || user.license_token.length > 4096) {
      throw failure('DEEZER_AUTH', 'Deezer did not accept the account');
    }
    return { licenseToken: user.license_token, premium: user.web_sound_quality?.lossless === true };
  }

  async function media(track, auth, format) {
    const data = await request('post', MEDIA_URL, {
      license_token: auth.licenseToken,
      media: [{ type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format }] }],
      track_tokens: [track.trackToken],
    }, { headers: { 'Content-Type': 'application/json' } });
    const item = data?.data?.[0];
    const candidate = Array.isArray(item?.media) ? item.media.find((m) => Array.isArray(m?.sources) && m.sources.length) : null;
    const cipher = typeof candidate?.cipher === 'string' ? candidate.cipher : candidate?.cipher?.type;
    if (!candidate || item.errors || (cipher && cipher !== 'BF_CBC_STRIPE')) throw failure('DEEZER_UNAVAILABLE', 'Track unavailable for this account');
    const source = candidate.sources.find((s) => validMediaUrl(s?.url));
    if (!source) throw failure('DEEZER_UNAVAILABLE', 'Track unavailable for this account');
    return source.url;
  }

  async function download(id, dest, { maxBytes = 120 * 1024 * 1024, maxSeconds = 0, expected = null } = {}) {
    const track = await getTrack(id);
    if (!sameRecording(track, expected, { requireIsrc: true })) throw failure('BAD_SOURCE', 'Track metadata did not match');
    if (maxSeconds && track.duration > maxSeconds) throw failure('TOO_LONG', 'Track exceeds duration limit');
    const auth = await session();
    let url;
    // Premium can use 320 kbps; if that format is unavailable, try 128 kbps.
    try { url = await media(track, auth, auth.premium ? 'MP3_320' : 'MP3_128'); }
    catch (e) {
      if (!auth.premium || e.code !== 'DEEZER_UNAVAILABLE') throw e;
      url = await media(track, auth, 'MP3_128');
    }
    const signal = AbortSignal.timeout(180_000);
    let response;
    let nextUrl = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      try {
        response = await http.get(nextUrl, { ...options, timeout: 180_000, signal, responseType: 'stream',
          headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity' } });
      } catch { throw failure('DEEZER_NETWORK', 'Deezer download failed'); }
      if (response.status < 300 || response.status >= 400) break;
      response.data?.destroy?.();
      if (redirects === 3 || !response.headers?.location) throw failure('DEEZER_UNAVAILABLE', 'Invalid Deezer redirect');
      try { nextUrl = new URL(response.headers.location, nextUrl).href; } catch { nextUrl = ''; }
      if (!validMediaUrl(nextUrl)) throw failure('DEEZER_UNAVAILABLE', 'Invalid Deezer redirect');
    }
    if (response.status < 200 || response.status >= 300) {
      response.data?.destroy?.();
      throw failure('DEEZER_UNAVAILABLE', 'Track unavailable for this account');
    }
    const type = String(response.headers?.['content-type'] || '').toLowerCase();
    const length = Number(response.headers?.['content-length']) || 0;
    if (type.includes('text/') || type.includes('json') || (length && length > maxBytes)) {
      response.data?.destroy?.();
      throw failure(length > maxBytes ? 'TOO_BIG' : 'BAD_SOURCE', 'Invalid track response');
    }
    let created = false;
    try {
      const decoder = await stripeDecoder(track.id, maxBytes);
      const fd = fs.openSync(dest, 'wx', 0o600);
      created = true;
      await pipeline(response.data, decoder, fs.createWriteStream(dest, { fd, autoClose: true }), { signal });
      const bytes = fs.statSync(dest).size;
      if (bytes < 10 * 1024) throw failure('BAD_SOURCE', 'Track is too small');
      const { trackToken: _trackToken, ...safeTrack } = track;
      return { ...safeTrack, file: dest, bytes };
    } catch (e) {
      response.data?.destroy?.();
      if (created) { try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ } }
      if (['TOO_BIG', 'BAD_SOURCE'].includes(e.code)) throw e;
      if (e.code === 'ENOSPC' || e.code === 'EDQUOT') throw failure('NOT_ENOUGH_DISK', 'Server storage is full');
      throw failure('DEEZER_NETWORK', 'Deezer download failed');
    }
  }

  return { search, getTrack, resolveTrackId, session, download };
}

module.exports = { configured, deezerUrl, trackId, validMediaUrl, createClient, songKey, stripeDecoder, sameRecording };
