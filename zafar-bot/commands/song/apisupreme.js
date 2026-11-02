'use strict';

/**
 * commands/song/apisupreme.js — the ONE audio resolver for .song.
 *
 * The old bot tried KnightBot, then ApisSupreme, then Apix, then two Hector
 * endpoints. Four of those are deleted. This is the surviving path.
 *
 * Failure is loud and specific:
 *   APISSUPREME_HTTP   the endpoint answered a non-2xx status
 *   APISSUPREME_EMPTY  it answered 2xx but had no media URL
 *   DOWNLOAD_HTTP      the media URL itself answered non-2xx
 *   TOO_BIG            the file exceeds limits.maxSizeMB
 *
 * The HTTP status is always in the message, so logs/<name>.log says e.g.
 * "ApisSupreme returned 403" instead of "something failed".
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ENDPOINT = 'https://apissupreme.vercel.app/media/ytmp3';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = Number(process.env.XJX_MEDIA_TIMEOUT_MS || 60_000);
const MAX_SIZE_MB = 120;

function fail(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function safeName(title) {
  const base = String(title || 'audio')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 80);
  return `${base || 'audio'}.mp3`;
}

/**
 * @param {string} youtubeUrl
 * @param {{tmp:string, log:object, maxSizeMB?:number}} opts
 * @returns {Promise<{file:string, title:string, mimeType:string}>}
 */
async function fetchAudio(youtubeUrl, { tmp, log, maxSizeMB = MAX_SIZE_MB }) {
  const apiKey = process.env.XJX_APISSUPREME_API_KEY || '';
  const params = { url: youtubeUrl };
  if (apiKey) params.apikey = apiKey;

  let data;
  try {
    const response = await axios.get(ENDPOINT, {
      params,
      timeout: TIMEOUT_MS,
      maxRedirects: 3,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    data = response.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = status ? `HTTP ${status}` : err.code || err.message;
    log?.error(`ApisSupreme request failed: ${detail}`);
    throw fail('APISSUPREME_HTTP', `ApisSupreme returned ${detail}`, err);
  }

  const mediaUrl = data?.downloadUrl || data?.download || data?.url;
  if (!data?.status || !mediaUrl) {
    log?.error(`ApisSupreme answered without a media URL: ${JSON.stringify(data).slice(0, 200)}`);
    throw fail('APISSUPREME_EMPTY', 'ApisSupreme returned no audio URL');
  }

  const title = data?.title || 'audio';
  const file = path.join(tmp, safeName(title));
  fs.mkdirSync(tmp, { recursive: true });

  let written;
  try {
    const response = await axios.get(mediaUrl, {
      responseType: 'stream',
      timeout: TIMEOUT_MS,
      maxRedirects: 3,
      headers: { 'User-Agent': UA },
    });

    const advertised = Number(response.headers['content-length'] || 0);
    if (advertised && advertised > maxSizeMB * 1024 * 1024) {
      throw fail('TOO_BIG', `the audio file is ${(advertised / 1024 / 1024).toFixed(1)} MB; the limit is ${maxSizeMB} MB`);
    }

    written = await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      let bytes = 0;
      let done = false;
      response.data.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxSizeMB * 1024 * 1024 && !done) {
          done = true;
          response.data.destroy();
          out.destroy();
          reject(fail('TOO_BIG', `the audio file exceeded ${maxSizeMB} MB while downloading`));
        }
      });
      response.data.on('error', (err) => { if (!done) { done = true; reject(fail('DOWNLOAD_HTTP', `audio download failed: ${err.message}`, err)); } });
      out.on('error', (err) => { if (!done) { done = true; reject(fail('DOWNLOAD_HTTP', `could not write the audio file: ${err.message}`, err)); } });
      out.on('finish', () => { if (!done) { done = true; resolve({ file, bytes }); } });
      response.data.pipe(out);
    });
  } catch (err) {
    if (err.code === 'TOO_BIG') throw err;
    if (err.code === 'DOWNLOAD_HTTP') throw err;
    const status = err.response?.status;
    const detail = status ? `HTTP ${status}` : err.code || err.message;
    log?.error(`audio download failed: ${detail}`);
    throw fail('DOWNLOAD_HTTP', `audio download failed: ${detail}`, err);
  }

  if (!written.bytes) {
    throw fail('DOWNLOAD_HTTP', 'the audio download produced an empty file');
  }
  log?.info(`audio saved: ${written.bytes} bytes`);
  return { file: written.file, title, mimeType: 'audio/mpeg' };
}

module.exports = { fetchAudio, ENDPOINT, safeName };
