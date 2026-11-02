'use strict';

/** Shared normalized shapes + the cross-catalog dedupe/relevance helpers. */
const C = require('./constants');

const clean = (value) => String(value ?? '').trim();
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function makeTrack(fields = {}) {
  const artists = Array.isArray(fields.artists)
    ? fields.artists.map(clean).filter(Boolean)
    : (clean(fields.artists) ? [clean(fields.artists)] : []);
  return {
    id: clean(fields.id),
    title: clean(fields.title) || 'Unknown title',
    artists: artists.length ? artists : ['Unknown artist'],
    album: clean(fields.album),
    durationMs: Math.round(num(fields.durationMs)),
    cover: clean(fields.cover),
    trackNumber: Math.round(num(fields.trackNumber)),
    releaseDate: clean(fields.releaseDate).slice(0, 4),
    previewUrl: clean(fields.previewUrl) || null,
    source: clean(fields.source) || 'unknown',
    url: clean(fields.url) || null,
  };
}

function makeResult(fields = {}) {
  return {
    source: clean(fields.source) || 'unknown',
    kind: ['track', 'album', 'playlist', 'artist'].includes(fields.kind) ? fields.kind : 'track',
    name: clean(fields.name) || 'Unknown',
    subtitle: clean(fields.subtitle),
    cover: clean(fields.cover),
    url: clean(fields.url) || null,
    durationMs: Math.round(num(fields.durationMs)),
  };
}

function makeCollection(fields = {}) {
  return {
    source: clean(fields.source) || 'unknown',
    kind: ['track', 'album', 'playlist'].includes(fields.kind) ? fields.kind : 'track',
    name: clean(fields.name) || 'Unknown',
    owner: clean(fields.owner),
    cover: clean(fields.cover),
    url: clean(fields.url) || null,
    tracks: Array.isArray(fields.tracks) ? fields.tracks : [],
  };
}

/** Lowercase, strip decorations and punctuation, collapse whitespace. */
function squash(value) {
  return clean(value)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*[([][^)\]]*(?:feat\.?|ft\.?|official|video|audio|lyric|remaster|explicit|hd|4k)[^)\]]*[)\]]/gi, ' ')
    .replace(/[^a-z0-9\u0600-\u06ff\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const dedupeKey = (result) => {
  const artist = squash(String(result.subtitle || '').split('·')[0]).replace(/\s/g, '');
  return `${result.kind}:${squash(result.name).replace(/\s/g, '')}:${artist}`;
};

/** Cheap Dice coefficient on character bigrams (stand-in for SequenceMatcher). */
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pairs = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      out.set(gram, (out.get(gram) || 0) + 1);
    }
    return out;
  };
  const left = pairs(a), right = pairs(b);
  let hits = 0;
  for (const [gram, count] of left) hits += Math.min(count, right.get(gram) || 0);
  const total = Math.max(1, a.length - 1 + b.length - 1);
  return (2 * hits) / total;
}

/**
 * Every query term must match somewhere in the item. Ported (MIT) from
 * sveltekit-embed's docs search: exact/prefix/includes scores, keyword
 * bonuses, a subsequence fallback that tolerates abbreviations like "ytb"
 * for "youtube".
 */
function isSubsequence(term, text) {
  let index = 0;
  for (const character of text) {
    if (character === term[index]) index++;
    if (index === term.length) return true;
  }
  return false;
}

function scoreTerm(term, item) {
  const S = C.SEARCH_SCORE;
  const title = item.title.toLowerCase();
  if (title === term) return S.exact;
  if (title.startsWith(term)) return S.prefix;
  if (title.includes(term)) return S.includes;
  let best = 0;
  for (const keyword of item.keywords || []) {
    const value = String(keyword).toLowerCase();
    if (value.startsWith(term)) best = Math.max(best, S.keywordPrefix);
    else if (value.includes(term)) best = Math.max(best, S.keywordIncludes);
  }
  if (best) return best;
  if (String(item.detail || '').toLowerCase().includes(term)) return S.detail;
  if (term.length >= C.SEARCH_SUBSEQUENCE_MIN_LENGTH && isSubsequence(term, title)) return S.subsequence;
  return 0;
}

function fuzzyScore(query, item) {
  const terms = squash(query).split(/\s+/).filter(Boolean);
  const ranked = {
    title: squash(item?.title),
    keywords: (item?.keywords || []).map((word) => squash(word)),
    detail: squash(item?.detail),
  };
  let total = 0;
  for (const term of terms) {
    const value = scoreTerm(term, ranked);
    if (!value) return 0; // all terms must match
    total += value;
  }
  return total;
}

function relevance(result, query) {
  const q = squash(query);
  const name = squash(result.name);
  const both = `${name} ${squash(result.subtitle)}`.trim();
  if (!q) return 0;
  let score = Math.max(dice(q, name), dice(q, both));
  if (name === q) score = 1;
  else if (name.startsWith(q)) score = Math.max(score, 0.93);
  else if (name.includes(q)) score = Math.max(score, 0.86);
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length && tokens.every((t) => both.includes(t))) score = Math.max(score, 0.8);
  // A term-by-term match rescues titles where the Dice coefficient is low
  // (abbreviations, extra words, reordered artist names).
  const fuzzy = fuzzyScore(query, { title: result.name, keywords: [result.subtitle], detail: '' });
  if (fuzzy > 0) score = Math.max(score, Math.min(0.9, fuzzy / (C.SEARCH_SCORE.exact * 1.25)));
  return score * (C.SOURCE_WEIGHT[result.source] ?? 0.85);
}

module.exports = {
  clean, num, makeTrack, makeResult, makeCollection,
  squash, dedupeKey, relevance, fuzzyScore, isSubsequence,
};
