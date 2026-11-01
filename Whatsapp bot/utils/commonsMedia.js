/**
 * Wikimedia Commons media search using MediaWiki's public imageinfo API.
 * Metadata is imperfect; the file page is always included for full terms.
 * https://www.mediawiki.org/wiki/API:Imageinfo
 */
const { publicGet, credentialHeaders } = require('./publicHttp');
const cheerio = require('cheerio');
const { downloadPublicFile, safeUrl } = require('./publicMediaDownload');

const API = 'https://commons.wikimedia.org/w/api.php';
const MAX_QUERY = 200;
const fail = (code, message) => Object.assign(new Error(message), { code });
const allowedUpload = new Set(['upload.wikimedia.org']);
const META_FIELDS = 'ObjectName|Artist|Credit|Attribution|AttributionRequired|LicenseShortName|LicenseUrl|Restrictions|License|Copyrighted';

function text(value, max = 400) {
  const raw = String(value || '');
  // Preserve safe attribution links as text; they are never fetched. Invalid
  // links make the record unusable rather than silently dropping a condition.
  const $ = cheerio.load(`<body>${raw}</body>`, null, false);
  $('script, style, noscript').remove();
  let invalidLink = false;
  $('a[href]').each((_i, element) => {
    const href = $(element).attr('href');
    let url;
    try { url = new URL(href, 'https://commons.wikimedia.org/'); } catch { invalidLink = true; return; }
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 300) { invalidLink = true; return; }
    const label = $(element).text().trim();
    $(element).text(label && label !== url.href ? `${label} (${url.href})` : url.href);
  });
  if (invalidLink) return '';
  const clean = $.text()
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : '';
}

function descriptionUrl(value) {
  try {
    const url = safeUrl(value, new Set(['commons.wikimedia.org']));
    return url.pathname.startsWith('/wiki/File:') && url.href.length <= 1500 ? url.href : '';
  } catch { return ''; }
}

function licenseInfo(meta) {
  const short = text(meta?.LicenseShortName?.value, 80);
  const key = text(meta?.License?.value, 80).toLowerCase();
  const attribution = text(meta?.Attribution?.value, 400);
  // Do not silently truncate a custom credit requirement.
  if (meta?.Attribution?.value && !attribution) return null;
  if (String(meta?.Restrictions?.value || '').trim()) return null;
  const cc = /^CC BY(-SA)? (1\.0|2\.0|2\.5|3\.0|4\.0)$/i.exec(short);
  if (cc) {
    const slug = cc[1] ? 'by-sa' : 'by';
    if (key !== `cc-${slug}-${cc[2]}`) return null;
    const expected = `https://creativecommons.org/licenses/${slug}/${cc[2]}/`;
    const supplied = String(meta?.LicenseUrl?.value || '').replace(/\/$/, '');
    if (supplied !== expected.replace(/\/$/, '')) return null;
    return { license: `CC BY${cc[1] ? '-SA' : ''} ${cc[2]}`, licenseUrl: expected, attribution };
  }
  if (/^public domain$/i.test(short) && key === 'pd' &&
      String(meta?.Copyrighted?.value).toLowerCase() === 'false' &&
      String(meta?.AttributionRequired?.value).toLowerCase() === 'false') {
    return { license: 'Public domain', licenseUrl: '', attribution };
  }
  return null;
}

function normalizePage(page, kind) {
  const info = page?.imageinfo?.[0];
  const meta = info?.extmetadata;
  if (!Number.isSafeInteger(page?.pageid) || page.pageid <= 0 || !info ||
      info.mediatype !== (kind === 'video' ? 'VIDEO' : 'AUDIO')) return null;
  const license = licenseInfo(meta);
  const source = descriptionUrl(info.descriptionurl);
  const title = text(meta?.ObjectName?.value || String(page.title || '').replace(/^File:/, ''), 180);
  const artist = text(meta?.Artist?.value, 240);
  const credit = text(meta?.Credit?.value, 400);
  if ((meta?.Credit?.value && !credit) || !license || !source || !title || !artist) return null;
  const duration = Number(info.duration);
  const size = Number(info.size);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(size) || size <= 0) return null;
  let url;
  try { url = safeUrl(info.url, allowedUpload); } catch { return null; }
  if (!url.pathname.startsWith('/wikipedia/commons/')) return null;
  // The imageinfo API adds tracking parameters to original file URLs. They
  // are not needed to fetch the file and can defeat shared CDN caching.
  for (const key of ['utm_source', 'utm_campaign', 'utm_content']) url.searchParams.delete(key);
  return { id: page.pageid, title, artist, duration, size, url: url.href, source, credit, ...license };
}

function createClient({ get = publicGet, download = downloadPublicFile } = {}) {
  async function query(params) {
    try {
      const response = await get(API, {
        params: {
          action: 'query', prop: 'imageinfo', iiprop: 'url|size|mime|mediatype|extmetadata',
          iiextmetadatafilter: META_FIELDS, format: 'json', formatversion: 2, ...params,
        },
        timeout: 20000, maxRedirects: 0, maxContentLength: 4 * 1024 * 1024, proxy: false, auth: null,
        headers: { 'User-Agent': 'ZaFarBot/2.2 (public Wikimedia Commons search)', Accept: 'application/json', ...credentialHeaders },
      });
      if (!response?.data || response.data.error || !response.data.query) throw new Error('Invalid response');
      return response.data.query;
    } catch { throw fail('COMMONS_NETWORK', 'Wikimedia Commons is temporarily unavailable'); }
  }

  async function search(input, { kind = 'audio', limit = 5 } = {}) {
    if (!['audio', 'video'].includes(kind)) throw fail('COMMONS_QUERY', 'Invalid media type');
    const queryText = String(input || '').trim();
    if (!queryText || queryText.length > MAX_QUERY) throw fail('COMMONS_QUERY', 'Invalid search title');
    const count = Math.min(10, Math.max(1, Math.floor(Number(limit) || 5)));
    const data = await query({
      generator: 'search', gsrsearch: `${queryText} filetype:${kind}`, gsrnamespace: 6,
      gsrlimit: Math.min(50, Math.max(20, count * 4)),
    });
    if (data.pages != null && !Array.isArray(data.pages)) throw fail('COMMONS_NETWORK', 'Invalid Commons search results');
    return (data.pages || []).slice().sort((a, b) => (Number(a.index) || 9999) - (Number(b.index) || 9999))
      .map((page) => normalizePage(page, kind)).filter(Boolean).slice(0, count);
  }

  async function downloadItem(id, dest, { kind = 'audio', maxBytes, maxSeconds = 0, timeoutMs } = {}) {
    if (!Number.isSafeInteger(id) || id <= 0 || !['audio', 'video'].includes(kind)) {
      throw fail('MEDIA_UNAVAILABLE', 'Invalid Commons file');
    }
    const data = await query({ pageids: String(id) });
    const page = Array.isArray(data.pages) ? data.pages.find((item) => item.pageid === id) : null;
    const item = normalizePage(page, kind);
    if (!item) throw fail('MEDIA_UNAVAILABLE', 'The Commons file or its license is unavailable');
    if (item.size > maxBytes) throw fail('TOO_BIG', 'Media exceeds the size limit');
    if (maxSeconds > 0 && item.duration > maxSeconds) throw fail('TOO_LONG', 'Media exceeds the duration limit');
    const result = await download(item.url, dest, { maxBytes, timeoutMs, allowedHosts: ['upload.wikimedia.org'] });
    return { ...item, bytes: result.bytes };
  }
  return { search, downloadItem };
}

/** License/source stay with captions; audio-only messages get a separate credit. */
function attributionFor(item) {
  return [
    `${item.title} — ${item.artist}`,
    item.attribution ? `Attribution: ${item.attribution}` : '',
    item.credit && !/^own work$/i.test(item.credit) ? `Credit: ${item.credit}` : '',
    `License: ${item.license}${item.licenseUrl ? ` (${item.licenseUrl})` : ''}`,
    `Source: ${item.source}`,
    'Converted or tagged for WhatsApp; check the source page for full terms.',
  ].filter(Boolean).join('\n');
}

module.exports = { API, MAX_QUERY, text, licenseInfo, normalizePage, attributionFor, createClient };
