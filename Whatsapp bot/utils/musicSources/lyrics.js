'use strict';

/**
 * Keyless lyrics + cover art for ID3 tags.
 *
 * LRCLIB first (plain + synced LRC, duration-checkable), then Netease and
 * Kugou, whose endpoints/cipher are the public constants from the Sonora
 * lyrics sources. All three answer without an account. Nothing here is
 * required for playback — a miss just leaves the tag out.
 */

const zlib = require('zlib');
const C = require('./constants');
const http = require('./http');
const { clean } = require('./model');

/** LRC/KRC timestamps are not useful inside an ID3 USLT frame. */
function stripTimestamps(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line
      .replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '')
      .replace(/\[\d+,\d+\]/g, '')
      .trimEnd())
    .filter((line, i, all) => line.trim() || (i > 0 && i < all.length - 1))
    .join('\n')
    .trim();
}

/** base64 → drop the 4-byte header → XOR with the 16-byte key → zlib inflate. */
function decodeKugou(content) {
  const buf = Buffer.from(String(content || ''), 'base64');
  if (buf.length <= 4) return '';
  const body = buf.subarray(4);
  for (let i = 0; i < body.length; i++) body[i] ^= C.KUGOU_CIPHER[i % C.KUGOU_CIPHER.length];
  try { return zlib.inflateSync(body).toString('utf8'); }
  catch { return ''; }
}

async function viaLrclib(track) {
  const artist = track.artists?.[0] || '';
  const duration = Math.round((track.durationMs || 0) / 1000);
  const base = { artist_name: artist, track_name: track.title, album_name: track.album || '' };
  const headers = { 'User-Agent': C.LYRICS_UA, Accept: 'application/json' };

  const exact = await http.getJson(`${C.LRCLIB_API}/get`, {
    params: { ...base, ...(duration ? { duration } : {}) }, headers,
  }).catch(() => null);
  if (exact?.plainLyrics || exact?.syncedLyrics) {
    return {
      plain: clean(exact.plainLyrics) || stripTimestamps(exact.syncedLyrics),
      synced: clean(exact.syncedLyrics), source: 'lrclib-get',
    };
  }

  const rows = await http.getJson(`${C.LRCLIB_API}/search`, {
    params: { ...base, q: `${artist} ${track.title}`.trim() }, headers,
  }).catch(() => []);
  const usable = Array.isArray(rows) ? rows : [];
  const wanted = duration || 0;
  const pick = (wanted
    ? usable.find((r) => Math.abs(Number(r.duration) - wanted) <= C.MAX_DURATION_DRIFT)
    : null) || usable[0];
  if (!pick) return null;
  const plain = clean(pick.plainLyrics) || stripTimestamps(pick.syncedLyrics);
  if (!plain) return null;
  return { plain, synced: clean(pick.syncedLyrics), source: 'lrclib-search' };
}

async function viaNetease(track) {
  const query = `${track.artists?.[0] || ''} ${track.title}`.trim();
  const body = new URLSearchParams({
    s: query, type: '1', offset: '0', limit: '3', cp: 'false',
  }).toString();
  const headers = { Referer: C.NETEASE_REFERER, 'User-Agent': C.LYRICS_UA };
  const found = await http.postJson(C.NETEASE_SEARCH, { body, headers }).catch(() => null);
  const song = found?.result?.songs?.[0];
  if (!song?.id) return null;
  const data = await http.getJson(C.NETEASE_LYRIC, {
    params: { id: song.id, lv: 0, tv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 },
    headers,
  }).catch(() => null);
  const plain = stripTimestamps(data?.lrc?.lyric);
  return plain ? { plain, synced: '', source: 'netease' } : null;
}

async function viaKugou(track) {
  const query = `${track.artists?.[0] || ''} ${track.title}`.trim();
  const found = await http.getJson(C.KUGOU_SEARCH, {
    params: { keyword: query, page: 1, pagesize: C.KUGOU_SONGS, krctype: 2 },
    headers: { 'User-Agent': C.LYRICS_UA },
  }).catch(() => null);
  const info = found?.data?.info?.[0];
  if (!info?.hash) return null;
  const candidates = await http.getJson(C.KUGOU_CANDIDATES, {
    params: { ver: 1, man: 'yes', client: 'pc', hash: info.hash },
    headers: { 'User-Agent': C.LYRICS_UA },
  }).catch(() => null);
  const choice = candidates?.candidates?.[0];
  if (!choice?.id || !choice?.accesskey) return null;
  const payload = await http.getJson(C.KUGOU_DOWNLOAD, {
    params: { ver: 1, client: 'pc', id: choice.id, accesskey: choice.accesskey, fmt: 'krc', charset: 'utf8' },
    headers: { 'User-Agent': C.LYRICS_UA },
  }).catch(() => null);
  const plain = stripTimestamps(decodeKugou(payload?.content));
  return plain ? { plain, synced: '', source: 'kugou' } : null;
}

/** @returns {Promise<{plain:string,synced:string,source:string}|null>} */
async function getLyrics(track) {
  if (!track?.title) return null;
  const task = (async () => {
    for (const provider of [viaLrclib, viaNetease, viaKugou]) {
      try {
        const hit = await provider(track);
        if (hit?.plain) return hit;
      } catch { /* next source */ }
    }
    return null;
  })();
  return http.withTimeout(task, C.TAG_TIMEOUT_MS, null);
}

/** Best-effort artwork bytes for an ID3 APIC frame. */
async function fetchCover(url) {
  if (!clean(url)) return null;
  try {
    const buf = await http.withTimeout(
      http.getBuffer(url, { maxBytes: C.MAX_COVER_BYTES, headers: { Accept: 'image/*' } }),
      C.TAG_TIMEOUT_MS, null,
    );
    if (!buf || buf.length < 16) return null;
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const png = buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
    return jpeg || png ? buf : null;
  } catch { return null; }
}

module.exports = { decodeKugou, stripTimestamps, getLyrics, fetchCover };
