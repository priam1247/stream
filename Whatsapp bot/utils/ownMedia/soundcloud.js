'use strict';

/**
 * Brick 4 — SoundCloud direct streams.
 *
 * Independent audio source that does not depend on YouTube at all. The public
 * web API needs a client_id that SoundCloud ships inside its own JS bundles;
 * we scrape it once (same trick yt-dlp uses), resolve a track, then follow
 * `media.transcodings` to a progressive MP3 URL that ffmpeg can read directly.
 */

const C = require('./constants');
const http = require('./http');
const { EngineError } = http;

const SCRIPT_RE = /<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/gi;
const CLIENT_ID_RE = /client_id\s*:\s*"([a-zA-Z0-9]{32})"/;
const clean = (value) => String(value ?? '').trim();

let clientId = null;
let clientIdAt = 0;
const TTL = 30 * 60 * 1000;

async function scrapeClientId() {
  const html = await http.getText(C.SOUNDCLOUD_HOME, { headers: { Accept: 'text/html' } });
  const scripts = [...html.matchAll(SCRIPT_RE)].map((m) => m[1]).reverse().slice(0, 12);
  for (const url of scripts) {
    try {
      const js = await http.getText(url, { headers: { Accept: '*/*' } });
      const match = js.match(CLIENT_ID_RE);
      if (match) return match[1];
    } catch { /* try the previous bundle */ }
  }
  throw new EngineError('NO_CLIENT_ID', 'SoundCloud client id not found in public bundles');
}

async function getClientId(force = false) {
  if (!force && clientId && Date.now() - clientIdAt < TTL) return clientId;
  clientId = await scrapeClientId();
  clientIdAt = Date.now();
  return clientId;
}

/** Build an API URL with the client_id appended. */
const apiUrl = (path, params, id) => {
  const u = new URL(`${C.SOUNDCLOUD_API}${path}`);
  for (const [key, value] of Object.entries({ ...params, client_id: id })) {
    if (value !== undefined && value !== null) u.searchParams.set(key, String(value));
  }
  return u.toString();
};

async function call(path, params = {}, { retry = true } = {}) {
  const id = await getClientId(!retry);
  try {
    return await http.getJson(apiUrl(path, params, id), {
      headers: { Accept: 'application/json', Origin: 'https://soundcloud.com', Referer: 'https://soundcloud.com/' },
    });
  } catch (err) {
    if (retry && ['HTTP_401', 'HTTP_403'].includes(err.code)) return call(path, params, { retry: false });
    throw err;
  }
}

async function resolve(url) {
  const data = await call('/resolve', { url });
  if (!data || data.errors || !data.id) {
    throw new EngineError('NOT_FOUND', 'SoundCloud could not resolve that link');
  }
  return data;
}

/**
 * Follow media.transcodings to a real stream URL.
 * Progressive MP3 is preferred: it downloads in one request with no m3u8
 * parsing and ffmpeg can turn it into a tagged MP3 without re-encoding.
 */
async function streamUrl(track) {
  const transcodings = Array.isArray(track?.media?.transcodings) ? track.media.transcodings : [];
  const progressive = transcodings.filter((t) => /progressive/i.test(t?.format?.protocol || ''));
  const hls = transcodings.filter((t) => /hls/i.test(t?.format?.protocol || ''));
  const ordered = [...progressive, ...hls];
  if (!ordered.length) throw new EngineError('NO_FORMATS', 'SoundCloud track has no public stream');

  const id = await getClientId();
  for (const entry of ordered) {
    if (!entry?.url) continue;
    try {
      const u = new URL(entry.url);
      u.searchParams.set('client_id', id);
      const data = await http.getJson(u.toString(), {
        headers: { Accept: 'application/json', Origin: 'https://soundcloud.com' },
      });
      if (data?.url) {
        return {
          url: String(data.url),
          protocol: /hls/i.test(entry?.format?.protocol || '') ? 'hls' : 'progressive',
          mime: clean(entry?.format?.mime_type) || 'audio/mpeg',
        };
      }
    } catch { /* try the next transcoding */ }
  }
  throw new EngineError('NO_FORMATS', 'SoundCloud stream URL was not returned');
}

async function search(query, { limit = 8 } = {}) {
  const q = clean(query);
  if (!q) return [];
  const data = await call('/search/tracks', { q, limit: Math.min(20, Math.max(1, limit)) });
  const rows = Array.isArray(data?.collection) ? data.collection : [];
  return rows
    .filter((item) => item?.id && item?.permalink_url && item?.streamable !== false
      && item?.policy !== 'BLOCK' && item?.monetization_model !== 'SUBSCRIPTION')
    .map((item) => ({
      id: String(item.id),
      title: clean(item.title),
      author: clean(item.user?.username || item.publisher_metadata?.artist),
      durationMs: Number(item.duration) || 0,
      url: clean(item.permalink_url),
      cover: clean(item.artwork_url || item.user?.avatar_url).replace(/-large\./, '-t500x500.'),
      track: item,
    }));
}

function pickByDuration(rows, durationMs = 0, driftSeconds = 20) {
  if (!rows.length) return null;
  if (!durationMs) return rows[0];
  const target = durationMs / 1000;
  const within = rows
    .map((row) => ({ row, drift: Math.abs((row.durationMs || 0) / 1000 - target) }))
    .filter((entry) => entry.drift <= driftSeconds)
    .sort((a, b) => a.drift - b.drift);
  return within[0]?.row || rows[0];
}

module.exports = {
  getClientId, resolve, streamUrl, search, pickByDuration,
  _resetForTests: () => { clientId = null; clientIdAt = 0; },
};
