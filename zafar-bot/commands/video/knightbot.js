'use strict';

/**
 * commands/video/knightbot.js — the ONE video resolver for .video.
 *
 * The old chain was KnightBot → Keithsite. Keithsite is deleted.
 *
 * Errors are specific: KNIGHTBOT_HTTP (with the status), KNIGHTBOT_EMPTY,
 * DOWNLOAD_HTTP, TOO_BIG.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ENDPOINT = 'https://knightbotapi.stream/api/download';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = Number(process.env.XJX_MEDIA_TIMEOUT_MS || 60_000);

function fail(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function safeName(title, quality) {
  const base = String(title || 'video')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 70);
  return `${base || 'video'}-${quality}p.mp4`;
}

async function fetchVideo(youtubeUrl, { tmp, log, quality = 480, maxSizeMB = 2000 }) {
  const apiKey = process.env.XJX_KNIGHTBOT_API_KEY || '';
  const params = { format: `${quality}p`, url: youtubeUrl };
  if (apiKey) params.apikey = apiKey;

  let data;
  try {
    const response = await axios.get(`${ENDPOINT}/ytvideo`, {
      params, timeout: TIMEOUT_MS, maxRedirects: 3,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    data = response.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = status ? `HTTP ${status}` : err.code || err.message;
    log?.error(`KnightBot request failed: ${detail}`);
    throw fail('KNIGHTBOT_HTTP', `KnightBot returned ${detail}`, err);
  }

  const result = data?.result || {};
  const mediaUrl = result.download || result.dl_url || result.dl;
  if (!data?.success || !mediaUrl) {
    log?.error(`KnightBot answered without a video URL: ${JSON.stringify(data).slice(0, 200)}`);
    throw fail('KNIGHTBOT_EMPTY', 'KnightBot returned no video URL');
  }

  const title = result.title || 'video';
  const file = path.join(tmp, safeName(title, quality));
  fs.mkdirSync(tmp, { recursive: true });

  try {
    const response = await axios.get(mediaUrl, {
      responseType: 'stream', timeout: TIMEOUT_MS, maxRedirects: 3,
      headers: { 'User-Agent': UA },
    });

    const advertised = Number(response.headers['content-length'] || 0);
    if (advertised && advertised > maxSizeMB * 1024 * 1024) {
      throw fail('TOO_BIG', `the video is ${(advertised / 1024 / 1024).toFixed(1)} MB; the limit is ${maxSizeMB} MB`);
    }

    const bytes = await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      let total = 0;
      let done = false;
      response.data.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxSizeMB * 1024 * 1024 && !done) {
          done = true;
          response.data.destroy();
          out.destroy();
          reject(fail('TOO_BIG', `the video exceeded ${maxSizeMB} MB while downloading`));
        }
      });
      response.data.on('error', (err) => { if (!done) { done = true; reject(fail('DOWNLOAD_HTTP', `video download failed: ${err.message}`, err)); } });
      out.on('error', (err) => { if (!done) { done = true; reject(fail('DOWNLOAD_HTTP', `could not write the video: ${err.message}`, err)); } });
      out.on('finish', () => { if (!done) { done = true; resolve(total); } });
      response.data.pipe(out);
    });

    if (!bytes) throw fail('DOWNLOAD_HTTP', 'the video download produced an empty file');
    log?.info(`video saved: ${bytes} bytes`);
    return { file, title, bytes };
  } catch (err) {
    if (err.code) throw err;
    const status = err.response?.status;
    throw fail('DOWNLOAD_HTTP', `video download failed: ${status ? `HTTP ${status}` : err.code || err.message}`, err);
  }
}

module.exports = { fetchVideo, ENDPOINT, safeName };
