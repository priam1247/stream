'use strict';

/**
 * Unified keyless music source layer.
 *
 * A pasted Deezer / Apple Music / Spotify / SoundCloud / YouTube Music link is
 * resolved to normalized track metadata; a plain phrase fans out to Deezer,
 * iTunes, SoundCloud and YouTube in parallel and merges the hits. The chosen
 * track is then matched to a public YouTube (or SoundCloud) upload by duration
 * before the bot's existing yt-dlp pipeline downloads audio or video.
 *
 * No service credentials, no protected streams, no DRM decryption.
 */

const C = require('./constants');
const http = require('./http');
const model = require('./model');
const deezer = require('./deezer');
const itunes = require('./itunes');
const spotify = require('./spotifyEmbed');
const soundcloud = require('./soundcloud');
const youtubeMusic = require('./youtubeMusic');
const lyrics = require('./lyrics');
const YT = require('../youtubedl');
const youtubeSearch = require('../youtubeSearch');

const { clean, makeTrack, makeResult, dedupeKey, relevance } = model;

const rawUrl = (text) => YT.extractUrl(String(text || '').trim()) || String(text || '').trim();

/** A link from one of the supported music services (not a plain YouTube link). */
function isMusicLink(text) {
  const raw = rawUrl(text);
  return Boolean(
    deezer.isDeezerUrl(raw)
    || itunes.isAppleMusicUrl(raw)
    || spotify.isSpotifyUrl(raw)
    || soundcloud.isSoundCloudUrl(raw)
    || youtubeMusic.isYouTubeMusicUrl(raw),
  );
}

/** YouTube / YouTube Music / SoundCloud links yt-dlp can read directly. */
function normalizeDirectUrl(text) {
  const raw = rawUrl(text);
  if (youtubeMusic.isYouTubeMusicUrl(raw)) {
    // Only watch/playlist links carry a playable id; browse pages are not
    // something yt-dlp can download, so reject them with a clear error.
    return youtubeMusic.normalize(raw);
  }
  if (YT.isYouTubeUrl(raw) || YT.isYouTubeUrl(`https://${raw}`)) return YT.normalizeYouTubeUrl(raw);
  if (soundcloud.isSoundCloudUrl(raw)) return soundcloud.parseUrl(raw);
  return null;
}

/** Paste a link → either a direct upload URL or a collection of tracks. */
async function resolveUrl(text) {
  const raw = rawUrl(text);

  if (deezer.isDeezerUrl(raw)) return { type: 'collection', collection: await deezer.resolve(raw) };
  if (itunes.isAppleMusicUrl(raw)) return { type: 'collection', collection: await itunes.resolve(raw) };
  if (spotify.isSpotifyUrl(raw)) return { type: 'collection', collection: await spotify.resolve(raw) };

  if (soundcloud.isSoundCloudUrl(raw)) {
    try { return { type: 'collection', collection: await soundcloud.resolve(raw) }; }
    catch { return { type: 'direct', url: soundcloud.parseUrl(raw) }; }
  }

  const direct = normalizeDirectUrl(raw);
  if (direct) return { type: 'direct', url: direct };
  return null;
}

/** Turn a merged search row into a track-like object. */
function resultToTrack(result) {
  return makeTrack({
    title: result.name,
    artists: [clean(result.subtitle).split('·')[0].trim() || result.subtitle],
    durationMs: result.durationMs,
    cover: result.cover,
    source: result.source,
    url: result.url,
  });
}

/** A picked search row → direct upload, collection, or a plain track. */
async function resolveSearchItem(item) {
  if (!item) return null;
  if (item.source === 'youtube' && item.url) {
    return { type: 'direct', url: item.url, track: resultToTrack(item) };
  }
  if (item.url) {
    try { return await resolveUrl(item.url); }
    catch { return { type: 'track', track: resultToTrack(item) }; }
  }
  return { type: 'track', track: resultToTrack(item) };
}

/** Parallel multi-catalog search, deduped and ordered by relevance. */
async function searchAll(query, { limit = 8 } = {}) {
  const q = clean(query);
  if (!q) return [];
  const jobs = [
    () => deezer.search(q, { limit }),
    () => itunes.search(q, { limit }),
    () => soundcloud.search(q, { limit }),
    async () => {
      const rows = await youtubeSearch.searchYouTube(q, { limit });
      return (rows || []).map((row) => makeResult({
        source: 'youtube', kind: 'track', name: row.title, subtitle: row.author,
        cover: row.thumbnail, url: row.url, durationMs: (Number(row.duration) || 0) * 1000,
      }));
    },
  ];
  const settled = await Promise.allSettled(jobs.map((job) => http.withTimeout(
    Promise.resolve().then(job), C.SEARCH_TIMEOUT_MS, [],
  )));
  const merged = [];
  const seen = new Set();
  for (const entry of settled) {
    const rows = entry.status === 'fulfilled' && Array.isArray(entry.value) ? entry.value : [];
    for (const row of rows) {
      if (!row?.url) continue;
      const key = dedupeKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  return merged.sort((a, b) => relevance(b, q) - relevance(a, q)).slice(0, Math.max(limit, 5) * 2);
}

const trackQuery = (track) => [
  (track.artists || []).filter(Boolean).join(', '),
  clean(track.title),
].filter(Boolean).join(' - ').trim();

/** Normalize both yt-search and yt-dlp rows to {url,title,duration}. */
const uploadOf = (row) => ({
  url: clean(row?.url || (row?.id ? `https://www.youtube.com/watch?v=${row.id}` : '')),
  title: clean(row?.title || row?.name),
  duration: Number(row?.duration ?? (Number(row?.durationMs || 0) / 1000)) || 0,
});

/**
 * Prefer the upload whose duration is closest to the catalog duration (±20s).
 * That rejects live versions and hour-long mixes; without a match the top hit
 * still wins. Music-video mode favours official uploads on equal footing.
 */
function pickBest(rows, durationMs = 0, { video = false, exclude = [] } = {}) {
  const candidates = (rows || []).map(uploadOf)
    .filter((row) => row.url && !exclude.includes(row.url));
  if (!candidates.length) return null;
  const target = (Number(durationMs) || 0) / 1000;
  let best = null;
  let bestScore = -Infinity;
  candidates.forEach((row, index) => {
    let score = -index * 0.01;
    if (target > 0 && row.duration > 0) {
      const drift = Math.abs(row.duration - target);
      if (drift <= C.MAX_DURATION_DRIFT) score += 200 - drift * 2;
    }
    if (row.duration > C.MAX_UPLOAD_SECONDS) score -= 5000;
    if (/(?:\b1\s?hour\b|full album|continuous mix|lofi mix)/i.test(row.title)) score -= 50;
    if (video && /\bofficial\b|music video|\bofficial video\b/i.test(row.title)) score += 5;
    if (video && /\baudio only\b|lyrics?\b/i.test(row.title)) score -= 3;
    if (score > bestScore) { bestScore = score; best = row; }
  });
  return best;
}

/** Find a public upload for a normalized track. Returns {url,title,duration}. */
async function findUpload(track, { video = false, exclude = [] } = {}) {
  const query = trackQuery(track);
  if (!query) return null;
  const limit = C.YTSEARCH_COUNT;

  try {
    const rows = await youtubeSearch.searchYouTube(query, { limit });
    const hit = pickBest(rows, track.durationMs, { video, exclude });
    if (hit) return hit;
  } catch { /* fall through to yt-dlp */ }

  for (const prefix of ['ytsearch', 'scsearch']) {
    try {
      const rows = await YT.searchVideos(query, { limit, timeout: 60000, prefix });
      const hit = pickBest(rows, track.durationMs, { video, exclude });
      if (hit) return hit;
    } catch { /* try the next search backend */ }
  }
  return null;
}

module.exports = {
  C, http, model, deezer, itunes, spotify, soundcloud, youtubeMusic, lyrics,
  isMusicLink, normalizeDirectUrl, resolveUrl, resolveSearchItem, searchAll,
  resultToTrack, trackQuery, pickBest, findUpload,
  getLyrics: lyrics.getLyrics, fetchCover: lyrics.fetchCover,
};
