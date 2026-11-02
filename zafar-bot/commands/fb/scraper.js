'use strict';

/**
 * commands/fb/scraper.js — the ONE Facebook resolver for .fb.
 *
 * ApisSupreme's media/facebook endpoint, exactly what the old
 * utils/socialMedia.js used. No yt-dlp, no cobalt, no second scraper.
 *
 * Errors: APISSUPREME_HTTP (with status), APISSUPREME_EMPTY, NO_MEDIA.
 */

const axios = require('axios');

const ENDPOINT = 'https://apissupreme.vercel.app/media/facebook';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = Number(process.env.XJX_MEDIA_TIMEOUT_MS || 60_000);

function fail(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{url:string, kind:'video'|'image', ext:string, caption:string}>}
 */
async function resolve(inputUrl, { log } = {}) {
  const apiKey = String(process.env.XJX_APISSUPREME_API_KEY || '').trim();
  const params = { url: inputUrl };
  if (apiKey) params.apikey = apiKey;

  let data;
  try {
    const response = await axios.get(ENDPOINT, {
      params, timeout: TIMEOUT_MS, maxRedirects: 3,
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    });
    data = response.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = status ? `HTTP ${status}` : err.code || err.message;
    log?.error(`ApisSupreme facebook request failed: ${detail}`);
    throw fail('APISSUPREME_HTTP', `ApisSupreme returned ${detail}`, err);
  }

  // The endpoint has answered with both a bare object and a result array.
  const rows = Array.isArray(data) ? data
    : Array.isArray(data?.result) ? data.result
      : Array.isArray(data?.data) ? data.data
        : data?.result ? [data.result]
          : data ? [data] : [];

  const item = rows
    .map((row) => {
      const url = safeUrl(row?.url || row?.downloadUrl || row?.download_url || row?.hd || row?.sd || row?.videoUrl);
      if (!url) return null;
      const kind = /\.(?:mp4|mov|webm)(?:[?#]|$)/i.test(url) || /video/i.test(String(row?.type || ''))
        ? 'video' : 'image';
      return {
        url,
        kind,
        ext: kind === 'video' ? 'mp4' : 'jpg',
        caption: String(row?.caption || row?.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300),
      };
    })
    .find(Boolean);

  if (!item) {
    log?.error(`ApisSupreme answered without media: ${JSON.stringify(data).slice(0, 200)}`);
    throw fail('APISUPREME_EMPTY', 'ApisSupreme returned no Facebook media URL');
  }
  return item;
}

module.exports = { resolve, ENDPOINT };
