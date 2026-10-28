'use strict';
/**
 * Scribd search and link handling (Node side).
 * Returns the exact /find shape the dashboard already understands.
 */

const config = require('./config');

const CHALLENGE_MARKERS = ['captcha', 'challenge', 'are you a robot', 'just a moment'];

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function docIdOf(raw) {
  const value = String(raw || '');
  const match = value.match(/\/document\/(\d+)/) || value.match(/\/embeds\/(\d+)/) || value.match(/^(\d{5,})$/);
  return match ? match[1] : '';
}

function cleanUrl(raw) {
  const value = String(raw || '').trim();
  const ident = docIdOf(value);
  if (ident) return `https://www.scribd.com/document/${ident}`;
  try {
    const parsed = new URL(value);
    if (!/(^|\.)scribd\.com$/i.test(parsed.hostname)) return '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function documentUrl(ident) {
  return config.DOCUMENT_URL.replace('{id}', String(ident));
}

function embedUrl(raw) {
  const ident = docIdOf(raw) || docIdOf(cleanUrl(raw));
  if (!ident) return '';
  return `${config.EMBED_URL.replace('{id}', ident)}?start_page=1&view_mode=scroll`;
}

function titleFromUrl(raw) {
  const value = String(raw || '');
  const match = value.match(/\/document\/\d+\/([^/?#]+)/);
  if (!match) return '';
  try {
    const cleaned = decodeURIComponent(match[1]).replace(/[-_]+/g, ' ').trim();
    return cleaned ? cleaned.replace(/\b\w/g, (c) => c.toUpperCase()) : '';
  } catch {
    return '';
  }
}

function pageCountFromHtml(source) {
  const text = String(source || '');
  for (const pattern of [
    /"page_count"\s*:\s*(\d+)/,
    /"pageCount"\s*:\s*(\d+)/,
    /data-page-count="(\d+)"/,
  ]) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > 0) return Math.min(value, config.MAX_PAGES);
    }
  }
  return 0;
}

function queryWords(query) {
  const words = String(query || '')
    .toLowerCase()
    .split(/[^0-9a-z]+/)
    .filter((word) => word && !config.STOPWORDS.has(word));
  return [...new Set(words)];
}

/** Keep Scribd's order but put exact word matches first. */
function rankHits(hits, query) {
  const words = queryWords(query);
  const phrase = String(query || '').toLowerCase().split(/\s+/).join(' ');
  const marked = hits.map((source, order) => {
    const hit = { ...source };
    const lowerTitle = String(hit.title || '').toLowerCase();
    const titleWords = new Set(lowerTitle.match(/[0-9a-z]+/g) || []);
    let matched = 0;
    let score = 0;
    for (const word of words) {
      if (titleWords.has(word)) {
        matched += 1;
        score += 12;
      } else if ([...titleWords].some((candidate) => candidate.startsWith(word))) {
        matched += 1;
        score += 6;
      }
    }
    if (phrase && lowerTitle.includes(phrase)) score += 100;
    if (words.length && matched === words.length) score += 20;
    if (hit.pages) score += 1;
    hit.score = score;
    hit.match = !words.length || matched === words.length ? 'all' : matched ? 'some' : 'none';
    return { score, order, hit };
  });
  marked.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return marked.map((row) => row.hit);
}

function hitFrom(doc) {
  if (!doc || typeof doc !== 'object') return {};
  const url = cleanUrl(doc.reader_url || doc.url || '');
  const ident = String(doc.id || docIdOf(url) || '').trim();
  if (!/^\d+$/.test(ident)) return {};
  const resolved = url || cleanUrl(documentUrl(ident));
  if (!resolved) return {};
  const pages = Number(doc.pageCount || 0) || 0;
  let author = '';
  if (Array.isArray(doc.authors) && doc.authors.length && typeof doc.authors[0] === 'object') {
    author = String(doc.authors[0].name || '').trim();
  }
  if (!author && doc.author && typeof doc.author === 'object') {
    author = String(doc.author.name || '').trim();
  }
  const title = decodeEntities(String(doc.title || '')).split(/\s+/).filter(Boolean).join(' ');
  return {
    id: ident,
    title: title || titleFromUrl(resolved),
    url: resolved,
    pages: Math.max(0, Math.min(pages, config.MAX_PAGES)),
    views: String(doc.views || '').trim(),
    author,
  };
}

/** Find the result list wherever Scribd nests it in the JSON. */
function documentsIn(payload) {
  const queue = [payload];
  let visited = 0;
  while (queue.length && visited < 20000) {
    const node = queue.shift();
    visited += 1;
    if (Array.isArray(node)) {
      const docs = node.filter(
        (item) =>
          item && typeof item === 'object' &&
          ('reader_url' in item || 'pageCount' in item || 'downloadUrl' in item) &&
          ('id' in item || 'title' in item),
      );
      if (docs.length) return docs;
      queue.push(...node);
    } else if (node && typeof node === 'object') {
      queue.push(...Object.values(node));
    }
  }
  return [];
}

function searchUrl(query, page = 1) {
  const params = new URLSearchParams({
    query: String(query || '').split(/\s+/).filter(Boolean).join(' '),
    verbatim: 'true',
    ct_lang: '0',
  });
  if (page > 1) params.set('page', String(page));
  return `${config.FIND_URL}?${params.toString()}`;
}

function refusalNote(status, body, error) {
  const low = String(body || '').toLowerCase();
  if (CHALLENGE_MARKERS.some((marker) => low.includes(marker))) {
    return 'Scribd returned a browser challenge for this panel address.';
  }
  if ([401, 403, 429, 503].includes(status)) {
    return `Scribd refused the search from this address (HTTP ${status}).`;
  }
  if (!status) return `Scribd search did not answer (${error || 'connection failed'}).`;
  return `Scribd search returned HTTP ${status}.`;
}

function countIn(payload, key) {
  const value = Number(payload && payload[key]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), 10_000_000);
}

/** POST /find body → the dashboard's hit shape. */
async function findPage(query, page = 1) {
  const text = String(query || '').split(/\s+/).filter(Boolean).join(' ');
  let pageNumber = Number(page);
  if (!Number.isFinite(pageNumber)) pageNumber = 1;
  pageNumber = Math.max(1, Math.min(Math.floor(pageNumber), config.FIND_MAX_PAGE));

  const empty = {
    hits: [],
    notes: [],
    summary: '',
    page: pageNumber,
    total: 0,
    documents: 0,
    max_page: 1,
    per_page: config.FIND_PER_PAGE,
  };
  if (!text) {
    empty.notes = ['Type a few words to search Scribd for.'];
    empty.summary = 'No search yet.';
    return empty;
  }

  let status = 0;
  let body = '';
  let error = '';
  try {
    const response = await fetch(searchUrl(text, pageNumber), {
      headers: {
        'User-Agent': config.USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        Referer: config.FIND_REFERER,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(config.SEARCH_TIMEOUT_MS),
    });
    status = response.status;
    body = await response.text();
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }

  if (status !== 200) {
    empty.notes = [refusalNote(status, body, error)];
    empty.summary = empty.notes[0];
    return empty;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    empty.notes = ["Scribd's answer was not search JSON."];
    empty.summary = empty.notes[0];
    return empty;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    empty.notes = ["Scribd's search answer had the wrong shape."];
    empty.summary = empty.notes[0];
    return empty;
  }

  const documents = documentsIn(payload);
  const hits = [];
  const seen = new Set();
  for (const doc of documents) {
    const hit = hitFrom(doc);
    if (hit.id && !seen.has(hit.id)) {
      seen.add(hit.id);
      hits.push(hit);
    }
  }
  const ranked = rankHits(hits, text);

  const total = countIn(payload, 'total_results_count');
  let resultPages = countIn(payload, 'page_count');
  if (!resultPages && total) resultPages = Math.ceil(total / config.FIND_PER_PAGE);
  const maxPage = Math.max(1, Math.min(resultPages || 1, config.FIND_MAX_PAGE));

  const notes = [`Scribd search page ${pageNumber}: ${documents.length} result(s).`];
  if (!ranked.length) notes.push('No usable Scribd document links in that answer.');
  const weak = ranked.filter((hit) => hit.match === 'none').length;
  if (weak) notes.push(`${weak} loosely related result(s) kept at the end.`);

  return {
    hits: ranked,
    notes,
    summary: total
      ? `showing ${ranked.length} of ${total} match(es)`
      : `${ranked.length} match(es) on page ${pageNumber}`,
    page: pageNumber,
    total,
    documents: documents.length,
    max_page: maxPage,
    per_page: config.FIND_PER_PAGE,
  };
}

module.exports = {
  docIdOf, cleanUrl, documentUrl, embedUrl, titleFromUrl, pageCountFromHtml,
  rankHits, hitFrom, documentsIn, searchUrl, findPage, queryWords,
};
