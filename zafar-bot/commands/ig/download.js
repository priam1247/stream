'use strict';

/**
 * commands/ig/download.js — stream one media item to this job's temp folder.
 *
 * Own copy for .ig (rule 2). Refuses anything over maxSizeMB before and during
 * the download, so an oversized reel never fills the disk.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fail(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

/**
 * @returns {Promise<{file:string, bytes:number}>}
 */
async function download(url, { tmp, index, ext, maxSizeMB, log }) {
  fs.mkdirSync(tmp, { recursive: true });
  const file = path.join(tmp, `ig-${index}.${ext}`);

  let response;
  try {
    response = await axios.get(url, {
      responseType: 'stream',
      timeout: Number(process.env.XJX_MEDIA_TIMEOUT_MS || 60000),
      maxRedirects: 3,
      headers: { 'User-Agent': UA },
    });
  } catch (err) {
    const status = err.response?.status;
    log?.error(`media download failed: ${status ? 'HTTP ' + status : err.message}`);
    throw fail('DOWNLOAD_HTTP', `media download failed: ${status ? 'HTTP ' + status : err.message}`, err);
  }

  const advertised = Number(response.headers['content-length'] || 0);
  if (advertised && advertised > maxSizeMB * 1024 * 1024) {
    throw fail('TOO_BIG', `this item is ${(advertised / 1048576).toFixed(1)} MB; the limit is ${maxSizeMB} MB`);
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
        reject(fail('TOO_BIG', `this item exceeded ${maxSizeMB} MB while downloading`));
      }
    });
    response.data.on('error', (err) => { if (!done) { done = true; reject(fail('DOWNLOAD_HTTP', `media download failed: ${err.message}`, err)); } });
    out.on('error', (err) => { if (!done) { done = true; reject(fail('DOWNLOAD_HTTP', `could not write the media: ${err.message}`, err)); } });
    out.on('finish', () => { if (!done) { done = true; resolve(total); } });
    response.data.pipe(out);
  });

  if (!bytes) throw fail('DOWNLOAD_HTTP', 'the media download produced an empty file');
  return { file, bytes };
}

module.exports = { download };
