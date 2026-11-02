'use strict';

/**
 * XJX-style public social-media resolvers for .fb and .instagram.
 *
 * Facebook uses ApisSupreme's media/facebook endpoint; Instagram uses the same
 * ruhend-scraper igdl helper as XJX. These commands do not fall back to yt-dlp,
 * yt1d, Cobalt, or a local download pipeline. Provider credentials are read
 * only from the bot's private environment configuration.
 */

const axios = require('axios');
const config = require('../config');
const { safeUrl } = require('./publicMediaDownload');
const log = require('./logger')('social-media');

const FACEBOOK_API = 'https://apissupreme.vercel.app/media/facebook';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_INSTAGRAM_ITEMS = 10;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const http = axios.create({
  timeout: DEFAULT_TIMEOUT_MS,
  maxRedirects: 3,
  maxContentLength: 1024 * 1024,
  headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
});

const fail = (code, message) => Object.assign(new Error(message), { code });

function safeMediaUrl(value) {
  try { return safeUrl(value).href; } catch { return null; }
}

function normalizeInputUrl(value, platform) {
  const text = String(value || '').trim();
  if (!text || text.length > 4096) throw fail('BAD_LINK', 'unsupported link');
  let url;
  try { url = new URL(text); } catch { throw fail('BAD_LINK', 'unsupported link'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw fail('BAD_LINK', 'unsupported link');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const matches = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (platform === 'facebook') {
    if (!['facebook.com', 'fb.watch', 'fb.com'].some(matches)) throw fail('BAD_LINK', 'unsupported Facebook link');
    return url.href;
  }
  if (!['instagram.com', 'instagr.am', 'ddinstagram.com'].some(matches)) {
    throw fail('BAD_LINK', 'unsupported Instagram link');
  }
  if (matches('ddinstagram.com')) url.hostname = 'www.instagram.com';
  return url.href;
}

function mediaKind(item, url, sourceUrl) {
  const type = String(item?.type || item?.mimeType || item?.mime_type || '').toLowerCase();
  if (/video|mp4|reel/.test(type)) return 'video';
  if (/image|photo|jpeg|png/.test(type)) return 'image';
  return /\.(?:mp4|mov|avi|mkv|webm)(?:[?#]|$)/i.test(url) || /\/(?:reel|tv)\//i.test(sourceUrl)
    ? 'video' : 'image';
}

function extractInstagramItems(payload, sourceUrl) {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.result) ? payload.result
      : Array.isArray(payload?.data?.result) ? payload.data.result : [];
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const url = safeMediaUrl(row.url || row.downloadUrl || row.download_url || row.videoUrl || row.imageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      url,
      kind: mediaKind(row, url, sourceUrl),
      caption: String(row.caption || row.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500),
      mimeType: String(row.mimetype || row.mimeType || row.mime_type || '').slice(0, 100),
    });
    if (items.length >= MAX_INSTAGRAM_ITEMS) break;
  }
  return items;
}

function loadInstagramDownloader() {
  try {
    const scraper = require('ruhend-scraper');
    if (typeof scraper?.igdl === 'function') return scraper.igdl;
  } catch (error) {
    throw fail('PROVIDER_MISSING', 'Instagram resolver is not installed');
  }
  throw fail('PROVIDER_MISSING', 'Instagram resolver is not installed');
}

function createSocialMedia({
  http: httpClient = http,
  instagramDownload = null,
  settings = config.xjxMedia || {},
  logger = log,
} = {}) {
  const timeoutMs = Math.max(1000, Math.min(120000, Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const apissupremeApiKey = String(settings.apissupremeApiKey || '').trim();

  async function resolveFacebook(input, { quality = 1080 } = {}) {
    const url = normalizeInputUrl(input, 'facebook');
    const params = { url };
    if (apissupremeApiKey) params.apikey = apissupremeApiKey;
    let response;
    try {
      response = await httpClient.get(FACEBOOK_API, {
        params,
        timeout: timeoutMs,
        maxRedirects: 3,
        maxContentLength: 1024 * 1024,
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      });
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      throw fail(status === 401 || status === 403 ? 'AUTH_REQUIRED' : 'PROVIDER_FAILED', 'Facebook resolver failed');
    }
    const data = response?.data;
    if (!data?.success) throw fail('NO_MEDIA', 'Facebook resolver returned no media');
    const videos = data?.data?.videos || {};
    const candidates = Number(quality) < 720 ? [videos.sd, videos.hd] : [videos.hd, videos.sd];
    const resolved = candidates.map(safeMediaUrl).find(Boolean);
    if (!resolved) throw fail('NO_MEDIA', 'Facebook resolver returned no safe video URL');
    return { url: resolved, kind: 'video', title: String(data?.data?.title || '').slice(0, 250) };
  }

  async function resolveInstagram(input) {
    const url = normalizeInputUrl(input, 'instagram');
    const downloader = instagramDownload || loadInstagramDownloader();
    let payload;
    try { payload = await downloader(url); }
    catch { throw fail('PROVIDER_FAILED', 'Instagram resolver failed'); }
    const items = extractInstagramItems(payload, url);
    if (!items.length) throw fail('NO_MEDIA', 'Instagram returned no public media');
    return items;
  }

  async function downloadAndSend(sock, msg, extra, { platform, url, quality = 1080 } = {}) {
    const chatId = extra?.from || msg?.key?.remoteJid;
    const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});
    const sendItems = async (items) => {
      let sent = 0;
      let lastError = null;
      for (const item of items) {
        const caption = item.caption || '';
        const body = item.kind === 'video'
          ? { video: { url: item.url }, mimetype: 'video/mp4', ...(caption ? { caption } : {}) }
          : { image: { url: item.url }, mimetype: item.mimeType || 'image/jpeg', ...(caption ? { caption } : {}) };
        try {
          await sock.sendMessage(chatId, body, { quoted: msg });
          sent++;
        } catch (error) {
          lastError = error;
          logger.warn?.(`${item.kind} upload failed (SEND_FAILED)`);
        }
      }
      if (!sent) throw fail('SEND_FAILED', 'WhatsApp could not send the resolved media');
      if (lastError) logger.warn?.('some Instagram carousel media could not be sent (SEND_FAILED)');
      return sent;
    };

    await react(platform === 'facebook' ? '↘️' : '📥');
    try {
      const items = platform === 'facebook'
        ? [await resolveFacebook(url, { quality })]
        : await resolveInstagram(url);
      const sent = await sendItems(items);
      await react('✅');
      for (const item of items) {
        try { require('./telemetry').recordDownloadSuccess(item.kind); } catch { /* optional telemetry */ }
      }
      return { sent: true, count: sent, platform };
    } catch (error) {
      await react('❌');
      const code = String(error?.code || 'PROVIDER_FAILED');
      logger.warn?.(`${platform || 'social'} resolver failed (${code})`);
      if (!error.code) error.code = code;
      throw error;
    }
  }

  return { resolveFacebook, resolveInstagram, downloadAndSend };
}

function friendlyError(error, platform) {
  const code = String(error?.code || '');
  if (code === 'BAD_LINK') {
    return platform === 'facebook'
      ? '❌ Please provide a public Facebook video or reel link.'
      : '❌ Please provide a public Instagram post, reel, or video link.';
  }
  if (code === 'AUTH_REQUIRED') return '❌ Facebook download needs a valid ApisSupreme key. Set XJX_APISSUPREME_API_KEY privately.';
  if (platform === 'instagram') return '❌ Could not fetch public Instagram media. Private posts and restricted links are not supported; try again later.';
  if (code === 'NO_MEDIA') return '❌ Facebook did not return a downloadable public video for that link.';
  return '❌ Facebook download is temporarily unavailable. Check the ApisSupreme key and try again later.';
}

module.exports = {
  ...createSocialMedia(),
  createSocialMedia,
  friendlyError,
  normalizeInputUrl,
  extractInstagramItems,
  constants: { FACEBOOK_API, DEFAULT_TIMEOUT_MS, MAX_INSTAGRAM_ITEMS },
};
