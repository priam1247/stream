/**
 * ZaFar Bot — YouTube search
 *
 * Used by .spotify and local media search flows. The XJX-style .song/.video
 * commands use yt-search's first hit directly, matching their reference.
 *
 * Returns a list for the commands that offer numbered results.
 */

const YT = require('./youtubedl');
const config = require('../config');
const ytInnertube = require('./ytInnertube');

const DEFAULT_LIMIT = 5;
// Cache search metadata briefly, never media files or provider download URLs.
const searchCache = new Map();
const SEARCH_TTL_MS = 60_000;
const SEARCH_CACHE_MAX = 100;

function remember(query, rows) {
  if (!rows.length) return;
  if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(query.toLowerCase(), { at: Date.now(), rows: rows.map((row) => ({ ...row })) });
}

async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } finally { clearTimeout(timer); }
}

const clean = (s) => String(s || '').trim();

/** Normalise both sources into the same shape (yt-dlp says "uploader"). */
const toResult = ({ url, id, title, author, uploader, duration, thumbnail }) => ({
  url: url || (id ? `https://www.youtube.com/watch?v=${id}` : ''),
  id: id || YT.extractVideoId(url || '') || '',
  title: clean(title) || 'Unknown title',
  author: clean(author || uploader),
  duration: Number(duration) || 0,
  thumbnail: clean(thumbnail) || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''),
});

async function viaYtSearch(query, limit) {
  try {
    const yts = require('yt-search'); // lazy: scraping library, only needed here
    const found = await yts(query);
    const videos = (found && found.videos) || [];
    return videos.slice(0, limit).map(v => toResult({
      url: v.url,
      id: v.videoId || YT.extractVideoId(v.url || ''),
      title: v.title,
      author: v.author?.name,
      duration: v.seconds,
      thumbnail: v.thumbnail,
    })).filter(r => r.url);
  } catch (e) {
    console.warn('[search] yt-search failed:', e.message);
    return [];
  }
}

async function viaYtDlp(query, limit) {
  try {
    const rows = await YT.searchVideos(query, { limit, timeout: 60000 });
    return rows.map(toResult).filter(r => r.url);
  } catch (e) {
    console.warn('[search] yt-dlp search failed:', e.message);
    return [];
  }
}

/**
 * @param {string} query
 * @param {{limit?:number}} [opts]
 * @returns {Promise<Array<{url:string,id:string,title:string,author:string,duration:number,thumbnail:string}>>}
 */
async function searchYouTube(query, { limit = DEFAULT_LIMIT } = {}) {
  const q = clean(query);
  if (!q) return [];

  // A link is not a search
  if (YT.isYouTubeUrl(q)) {
    const id = YT.extractVideoId(q);
    const url = YT.normalizeYouTubeUrl(q);
    let meta = {};
    try { meta = await YT.getInfo(url, { timeout: 45000 }); } catch { /* download reports the rest */ }
    return [toResult({ url, id, title: meta.title, author: meta.uploader, duration: meta.duration, thumbnail: meta.thumbnail })];
  }

  const cached = searchCache.get(q.toLowerCase());
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS && cached.rows.length >= limit) {
    return cached.rows.slice(0, limit).map((row) => ({ ...row }));
  }
  if (cached && Date.now() - cached.at >= SEARCH_TTL_MS) searchCache.delete(q.toLowerCase());

  // yt-search is normally fastest. A stalled HTML scrape must not hold up
  // the other engines indefinitely; their real errors still reach the caller.
  const wide = Math.max(limit, 5);
  const first = await withTimeout(viaYtSearch(q, wide), 3500, []);
  if (first.length >= limit) { remember(q, first); return first.slice(0, limit); }

  const merged = [...first];
  const addUnique = (rows) => {
    for (const r of rows) {
      if (!merged.some(x => x.id && r.id && x.id === r.id)) merged.push(r);
    }
  };

  try {
    const itRows = await ytInnertube.searchVideos(q, { limit });
    addUnique(itRows.map(toResult).filter(r => r.url));
  } catch { /* fall through to yt-dlp */ }

  if (merged.length >= limit) { remember(q, merged); return merged.slice(0, limit); }

  const second = await viaYtDlp(q, limit);
  addUnique(second);
  remember(q, merged);
  return merged.slice(0, limit);
}

/** "1. Title — artist (3:32)" list for the picker message. */
function formatResults(results, { header = '🔎 *Results*', note = `Reply with ${config.prefix}1, ${config.prefix}2, or ${config.prefix}cancel.` } = {}) {
  const lines = results.map((r, i) => {
    const time = r.duration
      ? ` (${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')})`
      : '';
    const who = r.author ? ` — ${r.author}` : '';
    return `*${i + 1}.* ${r.title}${time}${who}`;
  });
  return `${header}\n${lines.join('\n')}\n\n${note}`;
}

module.exports = { searchYouTube, formatResults, DEFAULT_LIMIT };
