'use strict';

/**
 * commands/movie/query.js — parse "Title 2010" and pick the best search hit.
 *
 * Pure functions; this is the part check.js can test without a network.
 */

/**
 * @returns {{title:string, year:number|null}}
 */
function parseQuery(input) {
  const text = String(input || '').trim().replace(/\s+/g, ' ');
  if (!text) return { title: '', year: null };

  // A trailing 4-digit year in a plausible range is a year, not part of the title.
  const match = /^(.*?)[\s(]+(19\d{2}|20\d{2})\)?$/.exec(text);
  if (match && match[1].trim()) {
    return { title: match[1].trim(), year: Number(match[2]) };
  }
  return { title: text, year: null };
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
