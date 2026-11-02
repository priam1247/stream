'use strict';

/**
 * commands/info/lookup.js — Cinemeta (Stremio) metadata.
 *
 * One source. Cinemeta is keyless and answers for both movies and series.
 * A failure throws with the HTTP status; it is never retried against another
 * provider.
 */

const axios = require('axios');

const BASE = 'https://v3-cinemeta.strem.io';
const TIMEOUT_MS = 15_000;
const TYPE_WORDS = new Set(['movie', 'movies', 'film', 'series', 'tv', 'show', 'anime']);

/** Preserved from the old info.js. */
function parseArgs(args) {
  const list = [...(args || [])];
  let type = 'movie';
  if (list.length && TYPE_WORDS.has(String(list[0]).toLowerCase())) {
    const word = String(list.shift()).toLowerCase();
    type = ['series', 'tv', 'show', 'anime'].includes(word) ? 'series' : 'movie';
  }
  return { title: list.join(' ').trim(), type };
}

/** Preserved from the old info.js. */
function render(item) {
  const lines = [
    `${item.type === 'series' ? '📺' : '🎬'} *${item.title}*${item.year ? ` (${item.year})` : ''}`,
  ];
  if (item.rating) lines.push(`⭐ ${item.rating}`);
  if (item.runtime) lines.push(`⏱ ${item.runtime} min`);
  if (item.seasons) lines.push(`📚 ${item.seasons} season(s)${item.episodes ? ` · ${item.episodes} ep` : ''}`);
  else if (item.episodes) lines.push(`📚 ${item.episodes} ep`);
  if (item.genres?.length) lines.push(`🏷 ${item.genres.slice(0, 4).join(', ')}`);
  if (item.overview) {
    const text = String(item.overview);
    lines.push('', `_${text.slice(0, 240)}${text.length > 240 ? '…' : ''}_`);
  }
  return lines.join('\n');
}

function toItem(meta) {
  if (!meta) return null;
  return {
    type: meta.type === 'series' ? 'series' : 'movie',
    title: meta.name || '',
    year: (meta.releaseInfo || meta.year || '').toString().slice(0, 4).slice(0, 4) || '',
    rating: meta.imdbRating || '',
    runtime: meta.runtime ? String(meta.runtime).replace(/\s*min$/i, '') : '',
    genres: Array.isArray(meta.genres) ? meta.genres : [],
    overview: meta.description || '',
    seasons: Array.isArray(meta.videos) ? new Set(meta.videos.map((v) => v.season)).size : 0,
    episodes: Array.isArray(meta.videos) ? meta.videos.filter((v) => Number(v.season) > 0).length : 0,
    poster: meta.poster || '',
  };
}

/**
 * @returns {Promise<object|null>} null means "no such title", not "service down"
 */
async function lookup(title, type = 'movie') {
  const catalog = type === 'series' ? 'series' : 'movie';
  let data;
  try {
    const response = await axios.get(`${BASE}/catalog/${catalog}/top/search=${encodeURIComponent(title)}.json`, {
      timeout: TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    });
    data = response.data;
  } catch (err) {
    const status = err.response?.status;
    const error = new Error(`Cinemeta returned ${status ? `HTTP ${status}` : err.code || err.message}`);
    error.code = 'METADATA_HTTP';
    throw error;
  }

  const metas = Array.isArray(data?.metas) ? data.metas : [];
  if (!metas.length) return null;

  const wanted = String(title).toLowerCase();
  const best = metas.find((m) => String(m.name || '').toLowerCase() === wanted) || metas[0];

  // The catalog answer is a summary; ask for the detail record so the card has
  // rating, runtime and season counts.
  try {
    const detail = await axios.get(`${BASE}/meta/${catalog}/${encodeURIComponent(best.imdb_id || best.id)}.json`, {
      timeout: TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    });
    return toItem(detail.data?.meta || best);
  } catch (err) {
    const status = err.response?.status;
    const error = new Error(`Cinemeta detail returned ${status ? `HTTP ${status}` : err.code || err.message}`);
    error.code = 'METADATA_HTTP';
    throw error;
  }
}

module.exports = { parseArgs, render, lookup, toItem, BASE };
