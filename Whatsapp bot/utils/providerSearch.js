'use strict';

// Search only the requested provider. Native public search is preferred where
// we can obtain individual video links; the remaining providers use public web
// indexes. Neither the web-index requests nor the native HTTP requests carry
// the bot's cookies or authorization headers.
const axios = require('axios');
const crypto = require('crypto');

const MAX_QUERY = 200;
const MAX_BODY = 1024 * 1024;
const HTTP_TIMEOUT = 10000;
const SEARCH_TIMEOUT = 30000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Domains are used for the search query; URL acceptance below is narrower and
// also checks the video/post path. An index's site: operator is not a boundary.
const PROVIDERS = Object.freeze({
  bilibili: { label: 'Bilibili', domains: ['bilibili.com', 'bilibili.tv'] },
  vimeo: { label: 'Vimeo', domains: ['vimeo.com'] },
  dailymotion: { label: 'Dailymotion', domains: ['dailymotion.com'], indexSites: ['dailymotion.com/video'] },
  reddit: { label: 'Reddit', domains: ['reddit.com'] },
  twitch: { label: 'Twitch', domains: ['twitch.tv'] },
  rumble: { label: 'Rumble', domains: ['rumble.com'], indexSites: ['rumble.com/v'] },
  odysee: { label: 'Odysee', domains: ['odysee.com'] },
  weibo: { label: 'Weibo', domains: ['weibo.com', 'weibo.cn'] },
  douyin: { label: 'Douyin', domains: ['douyin.com'], indexSites: ['douyin.com/video'] },
  acfun: { label: 'AcFun', domains: ['acfun.cn'] },
  youku: { label: 'Youku', domains: ['youku.com'], indexSites: ['v.youku.com/v_show'] },
  vk: { label: 'VK', domains: ['vk.com', 'vkvideo.ru'] },
  xiaohongshu: { label: 'Xiaohongshu', domains: ['xiaohongshu.com'], indexSites: ['xiaohongshu.com/explore'] },
  niconico: { label: 'Niconico', domains: ['nicovideo.jp'], indexSites: ['nicovideo.jp/watch'] },
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
  switch (site) {
    case 'bilibili':
      valid = onHost(host, ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'])
        ? /^\/(?:video\/[ab]v[\w]+|bangumi\/play\/ep\d+)\/?$/i.test(p)
        : onHost(host, ['bilibili.tv', 'www.bilibili.tv']) && /^\/(?:[\w-]+\/)?video\/\d+\/?$/i.test(p);
      break;
    case 'vimeo':
      valid = onHost(host, ['vimeo.com', 'www.vimeo.com'])
        ? /^\/(?:\d+(?:\/[\da-z]+)?|channels\/[^/]+\/\d+|groups\/[^/]+\/videos\/\d+)\/?$/i.test(p)
        : host === 'player.vimeo.com' && /^\/video\/\d+\/?$/i.test(p);
      break;
    case 'dailymotion':
      valid = onHost(host, ['dailymotion.com', 'www.dailymotion.com', 'm.dailymotion.com']) && /^\/video\/[a-z0-9]+\/?$/i.test(p);
      break;
    case 'reddit':
      valid = onHost(host, ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'm.reddit.com'])
        && /^\/(?:r\/[^/]+\/|user\/[^/]+\/)?comments\/[a-z0-9]+(?:\/[^/]*)?\/?$/i.test(p);
      break;
    case 'twitch':
      valid = onHost(host, ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'])
        ? /^\/(?:videos\/\d+|[^/]+\/clip\/[\w-]+)\/?$/i.test(p)
        : host === 'clips.twitch.tv' && /^\/[\w-]+\/?$/.test(p);
      break;
    case 'rumble':
      valid = onHost(host, ['rumble.com', 'www.rumble.com']) && /^\/v(?!ideos)[\w.-]+\/?$/i.test(p);
      break;
    case 'odysee':
      valid = onHost(host, ['odysee.com', 'www.odysee.com', 'lbry.tv', 'www.lbry.tv'])
        && (/^\/@[^/]+\/[^/$]+\/?$/.test(p) || /^\/[^/@$]+:[\da-f]{1,40}\/?$/i.test(p));
      break;
    case 'weibo':
      valid = onHost(host, ['weibo.com', 'www.weibo.com'])
        ? /^\/(?:\d+\/[a-z0-9]+|tv\/show\/\d+:(?:\d{16,}|[\da-f]{32}))\/?$/i.test(p)
        : host === 'm.weibo.cn' && /^\/(?:status|detail)\/[a-z0-9]+\/?$/i.test(p);
      break;
    case 'douyin':
      valid = onHost(host, ['douyin.com', 'www.douyin.com'])
        ? /^\/video\/\d+\/?$/i.test(p)
        : onHost(host, ['iesdouyin.com', 'www.iesdouyin.com']) && /^\/share\/video\/\d+\/?$/i.test(p);
      break;
    case 'acfun':
      valid = onHost(host, ['acfun.cn', 'www.acfun.cn']) && /^\/(?:v\/ac[\d_]+|bangumi\/aa[\d_]+)\/?$/i.test(p);
      break;
    case 'youku':
      valid = onHost(host, ['v.youku.com', 'play.youku.com', 'player.youku.com'])
        && /^\/(?:v_show\/id_|player\.php\/sid\/)[a-z0-9]+=*(?:\.html|\/v\.swf)?\/?$/i.test(p);
      break;
    case 'vk': {
      valid = onHost(host, ['vk.com', 'www.vk.com', 'm.vk.com', 'new.vk.com', 'vkvideo.ru', 'www.vkvideo.ru', 'm.vkvideo.ru'])
        && /^\/(?:video|clip)-?\d+_\d+\/?$/i.test(p);
      break;
    }
    case 'xiaohongshu':
      valid = host === 'www.xiaohongshu.com' && /^\/(?:explore|discovery\/item)\/[\da-f]+\/?$/i.test(p);
      break;
    case 'niconico':
      valid = onHost(host, ['nicovideo.jp', 'www.nicovideo.jp', 'sp.nicovideo.jp', 'embed.nicovideo.jp'])
        && /^\/(?:watch|shorts)\/(?:[a-z]{2})?\d+\/?$/i.test(p);
      break;
    default: break;
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
      episode: Number.isInteger(Number(row.episode)) && Number(row.episode) > 0 ? Number(row.episode) : 0,
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

async function searchBilibili(query, _limit, budget) {
  const endpoint = 'https://api.bilibili.com/x/web-interface/search/type';
  const params = { keyword: query, search_type: 'video', page: 1, highlight: 0 };
  const referer = 'https://search.bilibili.com/';
  const request = async (cookie) => {
    const body = parseJson(await getText(endpoint, params, { Referer: referer, Cookie: cookie }, HTTP_TIMEOUT, budget));
    if (Number(body?.code) === -412) throw Object.assign(new Error('Bilibili access check'), { code: 'BILI_412' });
    if (Number(body?.code) !== 0 || !Array.isArray(body?.data?.result)) throw new Error('Bilibili search unavailable');
    return body.data.result;
  };
  let videos;
  try {
    // Anonymous per-request identifier, not the owner's stored cookies.
    videos = await request(`buvid3=${crypto.randomUUID()}infoc`);
  } catch (err) {
    if (err?.code !== 'BILI_412' && err?.response?.status !== 412) throw err;
    // If the public API asks for its own anonymous session, request one from
    // Bilibili. Never reuse account cookies or send these values off-domain.
    const session = parseJson(await getText('https://api.bilibili.com/x/frontend/finger/spi', {}, { Referer: referer }, HTTP_TIMEOUT, budget));
    const b3 = session?.data?.b_3;
    const b4 = session?.data?.b_4;
    if (Number(session?.code) !== 0 || ![b3, b4].every((v) => typeof v === 'string' && /^[a-z0-9_+\/=.-]{8,220}$/i.test(v))) {
      throw new Error('Bilibili anonymous session unavailable');
    }
    videos = await request(`buvid3=${b3}; buvid4=${b4}`);
  }
  return videos.map((video) => ({
    url: video.arcurl || (video.bvid ? `https://www.bilibili.com/video/${video.bvid}` : ''),
    title: video.title, author: video.author,
  }));
}

function requestedEpisode(query) {
  const match = /\bs\d{1,2}\s*e(\d{1,3})\b/i.exec(query);
  return match ? { number: Number(match[1]), base: query.replace(match[0], ' ').replace(/\s+/g, ' ').trim() } : null;
}

function episodeNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const text = String(value).normalize('NFKC').trim();
  const match = /^(\d{1,4})$/.exec(text)
    || /第\s*(\d{1,4})\s*(?:集|话|話|期|回)/.exec(text)
    || /\b(?:episode|ep\.?)\s*(\d{1,4})\b/i.exec(text);
  const number = match ? Number(match[1]) : 0;
  return number > 0 ? number : 0;
}

function parseYouku(body) {
  if (body?.message !== 'success' || (!Array.isArray(body.originNodes) && !Array.isArray(body.pageComponentList))) {
    throw new Error('Youku search unavailable');
  }
  const rows = [];
  let visited = 0;
  function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > 16 || ++visited > 12000) return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    if (value.isYouku === 0 || value.hasYouku === 0) return;
    const id = typeof value.videoId === 'string' ? value.videoId : '';
    if (/^[a-z0-9]+=*$/i.test(id)) {
      rows.push({
        url: `https://v.youku.com/v_show/id_${id}.html`,
        title: value.title || value.displayName || value.tempTitle || value.titleDTO?.displayName,
        episode: episodeNumber(value.orderId) || episodeNumber(value.showVideoStage) || episodeNumber(value.displayName),
      });
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit([body.originNodes, body.pageComponentList], 0);
  return rows;
}

const rankEpisode = (rows, number) => number
  ? rows.sort((a, b) => Number(Number(b.episode) === number) - Number(Number(a.episode) === number))
  : rows;

async function searchYouku(query, _limit, budget) {
  const request = async (term) => parseYouku(parseJson(await getText('https://search.youku.com/api/search', {
    keyword: term, pg: 1, pz: 5,
  }, { Referer: 'https://search.youku.com/' }, HTTP_TIMEOUT, budget)));
  const episode = requestedEpisode(query);
  let rows = await request(query);
  // Some searches index a series name, not "S01E01". Still show actual episode
  // titles and prioritize only a returned matching episode; never invent one.
  if (!rows.length && episode?.base) rows = await request(episode.base);
  return rankEpisode(rows, episode?.number);
}

const titleKey = (title) => String(title || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// For an English episodic Youku query, an exact TVMaze show match can supply an
// original Chinese title. It is only a search term: selected results still have
// to be real, independently validated Youku video URLs.
async function youkuOriginalTitle(episode, budget) {
  if (!episode?.base || !/[a-z]/i.test(episode.base) || /[\u3400-\u9fff]/.test(episode.base)) return '';
  const matches = parseJson(await getText('https://api.tvmaze.com/search/shows', { q: episode.base }, {}, 6000, budget));
  if (!Array.isArray(matches)) throw new Error('Title lookup unavailable');
  const candidates = matches.map((entry) => entry?.show).filter((show) => {
    if (titleKey(show?.name) !== titleKey(episode.base)) return false;
    const channel = String(show?.webChannel?.name || '').toLowerCase();
    const official = normalizeSiteUrl('youku', show?.officialSite);
    return (channel === 'youku' || Boolean(official)) && Number.isSafeInteger(show?.id) && show.id > 0 && show.id < 1000000000;
  });
  if (candidates.length !== 1) return '';
  const aliases = parseJson(await getText(`https://api.tvmaze.com/shows/${candidates[0].id}/akas`, {}, {}, 6000, budget));
  if (!Array.isArray(aliases)) throw new Error('Title lookup unavailable');
  const alias = aliases.find((item) => (!item?.country || item.country.code === 'CN')
    && typeof item.name === 'string' && item.name.length <= 100 && /[\u3400-\u9fff]/.test(item.name));
  return alias ? alias.name.trim() : '';
}

async function searchAcfun(query, _limit, budget) {
  const body = parseJson(await getText('https://api-new.app.acfun.cn/rest/app/search/video', { keyword: query, sortType: 5 }, {}, HTTP_TIMEOUT, budget));
  if (Number(body?.result) !== 0 || !Array.isArray(body?.videoList)) throw new Error('AcFun search unavailable');
  return body.videoList.filter((v) => /^\d+$/.test(String(v.contentId || ''))).map((v) => ({
    url: `https://www.acfun.cn/v/ac${v.contentId}`, title: v.title, author: v.userName,
  }));
}

async function searchDailymotion(query, limit, budget) {
  const body = parseJson(await getText('https://api.dailymotion.com/videos', {
    search: query, fields: 'id,title,url,duration,owner.screenname', limit: Math.min(30, limit * 3), page: 1,
  }, {}, HTTP_TIMEOUT, budget));
  if (!Array.isArray(body?.list)) throw new Error('Dailymotion search unavailable');
  return body.list.map((item) => ({
    url: item.url || (/^[a-z0-9]+$/i.test(String(item.id || '')) ? `https://www.dailymotion.com/video/${item.id}` : ''),
    title: item.title, duration: item.duration, author: item['owner.screenname'],
  }));
}

async function searchNiconicoSnapshot(query, limit, budget) {
  const body = parseJson(await getText('https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search', {
    q: query, targets: 'title,description,tags', fields: 'contentId,title,lengthSeconds',
    _sort: '-viewCounter', _limit: Math.min(30, limit * 3), _context: 'zafar-video-search',
  }, { 'User-Agent': 'zafar-video-search/2.2' }, HTTP_TIMEOUT, budget));
  if (Number(body?.meta?.status) !== 200 || !Array.isArray(body?.data)) throw new Error('Niconico snapshot search unavailable');
  return body.data.filter((item) => /^(?:[a-z]{2})?\d+$/i.test(String(item.contentId || ''))).map((item) => ({
    url: `https://www.nicovideo.jp/watch/${item.contentId}`, title: item.title, duration: item.lengthSeconds,
  }));
}

async function searchReddit(query, limit, budget) {
  const body = parseJson(await getText('https://www.reddit.com/search.json', { q: query, type: 'link', sort: 'relevance', limit: Math.min(30, limit * 4), raw_json: 1 }, {}, HTTP_TIMEOUT, budget));
  if (!Array.isArray(body?.data?.children)) throw new Error('Reddit search unavailable');
  return body.data.children.map((item) => item?.data).filter((v) => v && (v.is_video === true || v.media?.reddit_video || v.secure_media?.reddit_video)).map((v) => ({
    url: typeof v.permalink === 'string' && v.permalink.startsWith('/') ? `https://www.reddit.com${v.permalink}` : '',
    title: v.title, author: v.author,
  }));
}

function lbryUrl(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('lbry://')) return '';
  const path = uri.slice('lbry://'.length).replace(/#/g, ':');
  return `https://odysee.com/${path}`;
}

async function searchOdysee(query, limit, budget) {
  const body = parseJson(await postJson('https://api.na-backend.odysee.com/api/v1/proxy', {
    jsonrpc: '2.0', id: 1, method: 'claim_search', params: {
      text: query, claim_type: ['stream'], stream_types: ['video'], has_source: true,
      fee_amount: '<=0', page: 1, page_size: Math.min(20, limit * 2), no_totals: true,
    },
  }, budget));
  if (body?.error || !Array.isArray(body?.result?.items)) throw new Error('Odysee search unavailable');
  return body.result.items.map((item) => ({
    url: lbryUrl(item.canonical_url || item.permanent_url),
    title: item.value?.title || item.name,
    author: item.signing_channel?.value?.title || item.signing_channel?.name,
    duration: item.value?.video?.duration,
  }));
}

const NATIVE = Object.freeze({
  bilibili: searchBilibili, youku: searchYouku, acfun: searchAcfun,
  reddit: searchReddit, odysee: searchOdysee,
  dailymotion: searchDailymotion, niconico: searchNiconicoSnapshot,
});

function indexQuery(site, query) {
  const domains = PROVIDERS[site].indexSites || PROVIDERS[site].domains;
  return `${query} ${domains.length === 1 ? `site:${domains[0]}` : `(${domains.map((d) => `site:${d}`).join(' OR ')})`}`;
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
  const paths = PROVIDERS[site].indexSites;
  // The API accepts hostnames in includeDomains, but a provider's search or
  // music pages can drown out videos. For profiles with a known video path,
  // include that path in the site: query instead of a broad hostname filter.
  const scope = paths?.length === 1
    ? { query: indexQuery(site, query) }
    : { query, includeDomains: PROVIDERS[site].domains };
  const body = parseJson(await postJson('https://api.firecrawl.dev/v2/search', {
    ...scope, limit: Math.min(20, limit * 3), sources: ['web'], timeout: remaining(budget, 9000),
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

    // Youku's Chinese catalogue often does not index an English series title at
    // all. Use metadata only after an unsuccessful native episodic search.
    let localized = '';
    const episode = site === 'youku' ? requestedEpisode(q) : null;
    if (episode) {
      try { localized = await youkuOriginalTitle(episode, budget); } catch { /* continue with the original query */ }
      if (localized) {
        const found = await attempt('provider', async () => rankEpisode(await searchYouku(localized, n, budget), episode.number));
        if (found) return found;
        const localizedQuery = `${localized} 第${episode.number}集`;
        const index = await attempt('duckduckgo', () => searchDuck(site, localizedQuery, budget))
          || await attempt('brave', () => searchBrave(site, localizedQuery, budget))
          || await attempt('firecrawl', () => searchFirecrawl(site, localizedQuery, n, budget));
        if (index) return index;
      }
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
  parseYouku, requestedEpisode, lbryUrl,
};
