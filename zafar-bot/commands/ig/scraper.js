'use strict';

/**
 * commands/ig/scraper.js — the ONE Instagram resolver for .ig.
 *
 * ruhend-scraper's instagram downloader, exactly what the old
 * utils/socialMedia.js used for Instagram. No yt-dlp, no cobalt, no second
 * scraper. If ruhend breaks, .ig is broken and says so.
 *
 * Errors: PROVIDER_FAILED (with the cause), NO_MEDIA (empty result).
 */

const { kindOf } = require('./urls');

const MAX_ITEMS = 10;

function fail(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}

async function resolve(inputUrl, { log, maxItems = MAX_ITEMS } = {}) {
  let scraper;
  try {
    scraper = require('ruhend-scraper');
  } catch (err) {
    log?.error(`ruhend-scraper is not installed: ${err.message}`);
    throw fail('PROVIDER_FAILED', 'the Instagram resolver is not installed', err);
  }

  const fn = scraper?.instagram || scraper?.igdl || scraper?.ig;
  if (typeof fn !== 'function') {
    log?.error('ruhend-scraper exposes no instagram() function; the package changed');
    throw fail('PROVIDER_FAILED', 'the Instagram resolver has no usable function', new Error('instagram() missing'));
  }

  let payload;
  try {
    payload = await fn(inputUrl);
  } catch (err) {
    log?.error(`ruhend instagram threw: ${err.message}`);
    throw fail('PROVIDER_FAILED', `the Instagram resolver failed: ${err.message}`, err);
  }

  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.result) ? payload.result
      : Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.medias) ? payload.medias
          : [];

  const seen = new Set();
  const items = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const url = safeUrl(row.url || row.downloadUrl || row.download_url || row.videoUrl || row.imageUrl || row.link);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const kind = kindOf(row, url, inputUrl);
    const mimeType = String(row.mimetype || row.mimeType || row.mime_type || '').slice(0, 100);
    const ext = kind === 'video' ? 'mp4' : 'jpg';
    items.push({
      url,
      kind,
      mimeType,
      ext,
      caption: String(row.caption || row.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300),
    });
    if (items.length >= maxItems) break;
  }

  if (!items.length) {
    log?.error(`ruhend returned no media: ${JSON.stringify(payload).slice(0, 200)}`);
    throw fail('NO_MEDIA', 'the Instagram resolver returned no media');
  }

  return items;
}

module.exports = { resolve, MAX_ITEMS };
