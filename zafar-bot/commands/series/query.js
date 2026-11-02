'use strict';

/**
 * commands/series/query.js — parse "Title s01e01" and pick the best search hit.
 *
 * Own copy for .series (rule 2). Pure functions, so check.js can test them with
 * no network.
 */

const EPISODE_RE = /\bs(\d{1,2})\s*e(\d{1,3})\b/i;
const SEASON_ONLY_RE = /\bs(\d{1,2})\b/i;

/**
 * @returns {{title:string, season:number|null, episode:number|null, year:number|null}}
 */
function parseQuery(input) {
  const text = String(input || '').trim().replace(/\s+/g, ' ');
  if (!text) return { title: '', season: null, episode: null, year: null };

  let season = null;
  let episode = null;
  let title = text;

  const ep = EPISODE_RE.exec(text);
  if (ep) {
    season = Number(ep[1]);
    episode = Number(ep[2]);
    title = (text.slice(0, ep.index) + ' ' + text.slice(ep.index + ep[0].length)).trim();
  } else {
    const sea = SEASON_ONLY_RE.exec(text);
    if (sea) {
      season = Number(sea[1]);
      title = (text.slice(0, sea.index) + ' ' + text.slice(sea.index + sea[0].length)).trim();
    }
  }

  let year = null;
  const y = /^(.*?)[\s(]+(19\d{2}|20\d{2})\)?$/.exec(title);
  if (y && y[1].trim()) {
    title = y[1].trim();
    year = Number(y[2]);
  }

  return { title: title.replace(/\s+/g, ' ').trim(), season, episode, year };
}

/**
 * Choose one hit. Exact year wins, then the closest year, then the first result.
 * This is a tie-break, not a fallback source: the same provider list is used.
 */
function pickBest(hits, { title = '', year = null } = {}) {
  const list = Array.isArray(hits) ? hits.filter(Boolean) : [];
  if (!list.length) return null;

  const target = String(title).toLowerCase().trim();
  const scored = list.map((hit, index) => {
    const hitTitle = String(hit.title || '').toLowerCase().trim();
    let score = 0;
    if (hitTitle === target) score += 100;
    else if (hitTitle.includes(target) || target.includes(hitTitle)) score += 30;
    if (year && Number(hit.year) === Number(year)) score += 50;
    else if (year && hit.year) score -= Math.min(20, Math.abs(Number(hit.year) - Number(year)));
    score -= index; // earlier results win ties
    return { hit, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].hit;
}

module.exports = { parseQuery, pickBest };
