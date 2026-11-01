'use strict';

// Search only the requested provider. Native public search is preferred where
// we can obtain individual video links; the remaining providers use public web
// indexes. Neither the web-index requests nor the native HTTP requests carry
// the bot's cookies or authorization headers.
const axios = require('axios');

const MAX_QUERY = 200;
const MAX_BODY = 1024 * 1024;
const HTTP_TIMEOUT = 10000;
const SEARCH_TIMEOUT = 30000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Domains are used for the search query; URL acceptance below is narrower and
// also checks the video/post path. An index's site: operator is not a boundary.
const PROVIDERS = Object.freeze({
  reddit: { label: 'Reddit', domains: ['reddit.com'] },
});

const onHost = (host, names) => names.includes(host);

/** Only accept known provider hosts and individual yt-dlp-style video paths. */
function normalizeSiteUrl(site, input) {
  if (!PROVIDERS[site] || typeof input !== 'string' || !input || input.length > 4096) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  url.protocol = 'https:';
  url.hash = '';
  const host = url.hostname.toLowerCase();
  const p = url.pathname;
  let valid = false;
  if (site === 'reddit') {
    valid = onHost(host, ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'm.reddit.com'])
      && /^\/(?:r\/[^/]+\/|user\/[^/]+\/)?comments\/[a-z0-9]+(?:\/[^/]*)?\/?$/i.test(p);
  }
  return valid ? url.toString() : null;
}

function dom(html) {
  // Parse markup without executing scripts or fetching resources. Cheerio is
  // already used by yt-search and supports the bot's declared Node versions.
  return require('cheerio').load(html);
}

function cleanText(value, max = 120) {
  const text = String(value ?? '').slice(0, 2000);
  // Search metadata can contain highlighted HTML. Parsing never executes it.
  const plain = text.includes('<') || text.includes('&') ? dom(`<body>${text}</body>`)('body').text() : text;
  return plain.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeRows(site, rows, limit) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const url = normalizeSiteUrl(site, row?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: cleanText(row.title) || 'Untitled video',
      author: cleanText(row.author, 70),
      duration: Number.isFinite(Number(row.duration)) && Number(row.duration) > 0 ? Math.floor(Number(row.duration)) : 0,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function safeResponse(res) {
  if (!res || res.status !== 200 || typeof res.data !== 'string' || Buffer.byteLength(res.data) > MAX_BODY) {
    throw new Error('Search service unavailable');
  }
  return res.data;
}

function remaining(budget, ceiling = SEARCH_TIMEOUT) {
  if (!budget) return ceiling;
  const ms = budget.deadline - Date.now();
  if (budget.signal.aborted || ms <= 0) throw new Error('Search deadline reached');
  return Math.max(1, Math.min(ceiling, ms));
}

function requestOptions(timeout = HTTP_TIMEOUT, budget) {
  return {
    timeout: remaining(budget, timeout),
    signal: budget?.signal,
    maxContentLength: MAX_BODY,
    maxBodyLength: MAX_BODY,
    maxRedirects: 0, // do not forward a query to a redirect chosen by a third party
    responseType: 'text',
    transformResponse: [(body) => body],
    // Do not inherit account credentials if another module changes Axios defaults.
    auth: null,
    headers: {
      'User-Agent': UA, 'Accept': 'application/json, text/html, application/xml;q=0.9, */*;q=0.5',
      Authorization: undefined, Cookie: undefined,
    },
    validateStatus: (status) => status === 200,
  };
}

async function getText(url, params, headers = {}, timeout = HTTP_TIMEOUT, budget) {
  const opts = requestOptions(timeout, budget);
  opts.params = params;
  Object.assign(opts.headers, headers);
  return safeResponse(await axios.get(url, opts));
}

async function postJson(url, body, budget) {
  const opts = requestOptions(HTTP_TIMEOUT, budget);
  opts.headers['Content-Type'] = 'application/json';
  return safeResponse(await axios.post(url, body, opts));
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { throw new Error('Search response was not JSON'); }
}

async function searchReddit(query, limit, budget) {
  const body = parseJson(await getText('https://www.reddit.com/search.json', { q: query, type: 'link', sort: 'relevance', limit: Math.min(30, limit * 4), raw_json: 1 }, {}, HTTP_TIMEOUT, budget));
  if (!Array.isArray(body?.data?.children)) throw new Error('Reddit search unavailable');
  return body.data.children.map((item) => item?.data).filter((v) => v && (v.is_video === true || v.media?.reddit_video || v.secure_media?.reddit_video)).map((v) => ({
    url: typeof v.permalink === 'string' && v.permalink.startsWith('/') ? `https://www.reddit.com${v.permalink}` : '',
    title: v.title, author: v.author,
  }));
}

const NATIVE = Object.freeze({ reddit: searchReddit });

function indexQuery(site, query) {
  return `${query} site:${PROVIDERS[site].domains[0]}`;
}

function unwrapDuckLink(href) {
  let url;
  try { url = new URL(href, 'https://html.duckduckgo.com'); } catch { return ''; }
  if (onHost(url.hostname.toLowerCase(), ['duckduckgo.com', 'www.duckduckgo.com', 'html.duckduckgo.com']) && /^\/l\/?$/.test(url.pathname)) {
    // URLSearchParams already percent-decodes once. Never decode it twice.
    return url.searchParams.get('uddg') || '';
  }
  return url.toString();
}

function parseDuck(html) {
  const $ = dom(html);
  const anchors = $('a.result__a').toArray();
  if (!anchors.length && !$('.results, .no-results, #links').length) throw new Error('DuckDuckGo search unavailable');
  return anchors.map((node) => ({ url: unwrapDuckLink($(node).attr('href') || ''), title: $(node).text() }));
}

function parseBrave(html) {
  const $ = dom(html);
  let anchors = $('.snippet a.result-header, a.result-header, [data-testid="result-header"]').toArray();
  // Brave's markup changes; fall back to links inside the results container.
  // The caller still validates every destination as the requested site's video.
  if (!anchors.length) anchors = $('#results a[href], #web-results a[href]').toArray();
  if (!anchors.length && !$('#results, #web-results, .no-results').length) throw new Error('Brave search unavailable');
  return anchors.map((node) => {
    const a = $(node);
    return { url: a.attr('href') || '', title: a.find('.snippet-title').text() || a.attr('title') || a.text() };
  });
}

async function searchDuck(site, query, budget) {
  return parseDuck(await getText('https://html.duckduckgo.com/html/', { q: indexQuery(site, query) }, {}, HTTP_TIMEOUT, budget));
}
async function searchBrave(site, query, budget) {
  return parseBrave(await getText('https://search.brave.com/search', { q: indexQuery(site, query), source: 'web' }, {}, HTTP_TIMEOUT, budget));
}

// Firecrawl's public keyless search is explicitly offered for programmatic use
// but is subject to per-IP request/credit caps. Request links only, not scraping.
async function searchFirecrawl(site, query, limit, budget) {
  const body = parseJson(await postJson('https://api.firecrawl.dev/v2/search', {
    query, includeDomains: PROVIDERS[site].domains,
    limit: Math.min(20, limit * 3), sources: ['web'], timeout: remaining(budget, 9000),
  }, budget));
  if (body?.success !== true || !Array.isArray(body?.data?.web)) throw new Error('Firecrawl search unavailable');
  return body.data.web.map((item) => ({ url: item.url, title: item.title }));
}

/**
 * Returns { results, status, source }. Search results are discovery hints, not
 * a promise that a video is public, playable, non-DRM, or an exact match.
 */
async function searchProvider(site, query, { limit = 5, timeoutMs = SEARCH_TIMEOUT } = {}) {
  if (!PROVIDERS[site]) throw new TypeError('Unknown provider');
  const q = String(query || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || q.length > MAX_QUERY) return { results: [], status: 'invalid', source: '' };
  const n = Math.max(1, Math.min(10, Math.floor(Number(limit) || 5)));
  const timeout = Math.max(1, Math.min(SEARCH_TIMEOUT, Math.floor(Number(timeoutMs) || SEARCH_TIMEOUT)));
  const controller = new AbortController();
  const budget = { signal: controller.signal, deadline: Date.now() + timeout };
  const timer = setTimeout(() => controller.abort(), timeout);
  let completed = false;
  const attempt = async (source, run) => {
    try {
      remaining(budget);
      const rows = normalizeRows(site, await run(), n);
      remaining(budget);
      completed = true;
      return rows.length ? { results: rows, status: 'ok', source } : null;
    } catch { return null; }
  };
  try {
    if (NATIVE[site]) {
      const native = await attempt('provider', () => NATIVE[site](q, n, budget));
      if (native) return native;
    }

    const index = await attempt('duckduckgo', () => searchDuck(site, q, budget))
      || await attempt('brave', () => searchBrave(site, q, budget))
      || await attempt('firecrawl', () => searchFirecrawl(site, q, n, budget));
    const timedOut = budget.signal.aborted || Date.now() >= budget.deadline;
    return index || { results: [], status: completed && !timedOut ? 'empty' : 'unavailable', source: '' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  PROVIDERS, MAX_QUERY, searchProvider,
  // Export pure helpers so the offline suite can exercise malformed responses
  // and the host/path boundary independently of third-party availability.
  normalizeSiteUrl, normalizeRows, cleanText, indexQuery, parseDuck, parseBrave,
};
