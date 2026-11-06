'use strict';

/**
 * XJX's .dramabox resolver: GET /dramabox/stream?bookId=…&episode=… from the
 * same Keith API used by its movie commands. It returns a link; this command
 * does not download or unlock episodes locally.
 */
const axios = require('axios');
const { safeUrl } = require('../../lib/publicMediaDownload');

const API_BASE = 'https://apiskeith2-production-ec66.up.railway.app';
const API_PATH = '/dramabox/stream';
const DEFAULT_TIMEOUT_MS = 30000; // matches XJX keithApi's 0x7530 ms timeout
const MAX_RESPONSE_BYTES = 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const http = axios.create({
  timeout: DEFAULT_TIMEOUT_MS,
  maxRedirects: 0,
  maxContentLength: MAX_RESPONSE_BYTES,
  headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
});

const fail = (code, message) => Object.assign(new Error(message), { code });

function cleanText(value, maxLength = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function publicHttpsUrl(value) {
  try { return safeUrl(value).href; } catch { return null; }
}

function validateRequest(bookId, episode = 1) {
  const id = String(bookId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    throw fail('BAD_INPUT', 'invalid DramaBox book ID');
  }
  const episodeText = String(episode).trim();
  if (!/^\d{1,4}$/.test(episodeText)) {
    throw fail('BAD_INPUT', 'invalid DramaBox episode');
  }
  const ep = Number(episodeText);
  if (!Number.isSafeInteger(ep) || ep < 1 || ep > 9999) {
    throw fail('BAD_INPUT', 'invalid DramaBox episode');
  }
  return { bookId: id, episode: ep };
}

function normalizeResponse(payload) {
  if (payload == null || payload === '') throw fail('NO_DATA', 'DramaBox API returned no data');
  if (typeof payload === 'object' && payload.success === false) {
    throw fail('PROVIDER_FAILED', 'DramaBox API reported a failure');
  }

  const data = typeof payload === 'object' && Object.hasOwn(payload, 'data')
    ? payload.data
    : payload;
  if (data == null || data === '') throw fail('NO_DATA', 'DramaBox API returned no data');

  const title = typeof data === 'object' ? cleanText(data.title, 180) : '';
  const quality = typeof data === 'object' ? cleanText(data.quality, 32) : '';
  const values = typeof data === 'string'
    ? [data]
    : [data.url, data.streamUrl, data.link].filter((value) => typeof value === 'string' && value.trim());
  const hasCandidate = values.length > 0;
  const url = values.map(publicHttpsUrl).find(Boolean) || '';

  if (url) return { url, title, quality, responseText: '' };
  if (hasCandidate) throw fail('UNSAFE_URL', 'DramaBox API returned an unsafe stream URL');

  const responseText = cleanText(
    typeof data === 'string' ? data : JSON.stringify(data),
    1200,
  );
  if (!responseText) throw fail('NO_STREAM', 'DramaBox API returned no stream link');
  return { url: '', title, quality, responseText };
}

function createXjxDramaBox({
  http: httpClient = http,
  apiBase = API_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const base = String(apiBase || API_BASE).replace(/\/+$/, '');
  const timeout = Math.max(1000, Math.min(120000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

  async function getDramaBoxStream(bookId, episode = 1) {
    const params = validateRequest(bookId, episode);
    let response;
    try {
      response = await httpClient.get(`${base}${API_PATH}`, {
        params,
        timeout,
        maxRedirects: 0,
        maxContentLength: MAX_RESPONSE_BYTES,
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      });
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      throw fail(status ? `HTTP_${status}` : 'PROVIDER_FAILED', 'DramaBox resolver request failed');
    }
    return normalizeResponse(response?.data);
  }

  return { getDramaBoxStream };
}

module.exports = {
  ...createXjxDramaBox(),
  createXjxDramaBox,
  normalizeResponse,
  validateRequest,
  constants: { API_BASE, API_PATH, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES },
};
