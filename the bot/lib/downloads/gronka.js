'use strict';

/**
 * Gronka API client — https://api.gronka.dev (POST /v1/download).
 *
 * When GRONKA_API_KEY is set, .song, .video, .fb and .instagram use this as
 * their ONE source. There is no second provider behind it: if Gronka fails the
 * command reports the reason and stops, so a broken source is visible and gets
 * fixed instead of being hidden by a backup.
 *
 * API behaviour handled here (see the OpenAPI spec):
 *  - Authorization: Bearer <key>; the key is never logged or put in an error.
 *  - split:false always, so the answer is ONE finished file, never separate
 *    video and audio parts that would need merging.
 *  - A download that runs past ~80 s sends leading spaces before the JSON, and
 *    its error (if any) arrives in the body with HTTP 200, so the body is
 *    trimmed and parsed first and `error` is checked before the status.
 *  - Result lanes: direct (source link), worker (dl.gronka.dev, 1 hour),
 *    r2 (cdn.gronka.dev, deleted after 1 hour).
 *  - 429 RATE_LIMITED carries retryAfter seconds (50 downloads / 10 min / key).
 */

const axios = require('axios');
const config = require('../../config');
const log = require('../logger')('gronka');

const DEFAULT_BASE_URL = 'https://api.gronka.dev';
const DEFAULT_TIMEOUT_MS = 180000;
const MODES = new Set(['auto', 'audio', 'mute']);

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

// Messages shown to the person who sent the command. Gronka's own message is
// used for errors about the link; key and quota problems get a fixed wording.
const FIXED_MESSAGES = {
  UNAUTHORIZED: 'The download service rejected the bot’s key. The owner needs to check GRONKA_API_KEY.',
  VERIFICATION_FAILED: 'The download service rejected the bot’s key. The owner needs to check GRONKA_API_KEY.',
  NETWORK_ERROR: 'Could not reach the download service. Try again later.',
  TIMEOUT: 'The download service took too long. Try again later.',
  NEEDS_MERGE: 'The download service returned separate video and audio parts, which this bot cannot merge.',
  NO_MEDIA: 'The download service returned no file for that link.',
  BAD_RESPONSE: 'The download service sent an unreadable answer. Try again later.',
};

function cleanMessage(value, fallback) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
  return text || fallback;
}

function parseBody(data) {
  if (data && typeof data === 'object') return data;
  const text = String(data ?? '').trim(); // long downloads start with spaces
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function errorFrom(body, status, retryAfterHeader) {
  const code = String(body?.error?.code || `HTTP_${status || 0}`).slice(0, 40);
  const retryAfter = Number(body?.error?.retryAfter || retryAfterHeader) || 0;
  let userMessage = FIXED_MESSAGES[code];
  if (!userMessage && code === 'RATE_LIMITED') {
    userMessage = retryAfter ? `Too many downloads right now. Try again in ${retryAfter}s.` : 'Too many downloads right now. Try again in a few minutes.';
  }
  if (!userMessage) userMessage = cleanMessage(body?.error?.message, 'The download service could not fetch that link.');
  return fail(code, `gronka ${code}`, { status, retryAfter, userMessage });
}

function createGronka({ http = axios, settings = config.gronka || {}, logger = log } = {}) {
  const apiKey = String(settings.apiKey || '').trim();
  const baseUrl = String(settings.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Math.max(5000, Math.min(600000, Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const enabled = Boolean(apiKey);

  /**
   * Ask Gronka for one finished file.
   * @returns {Promise<{lane:string, filename:string, note:string, files:Array<{url:string,filename:string,type:string,kind:string,size:number|null}>}>}
   */
  async function download(input, { mode = 'auto', start, end } = {}) {
    if (!enabled) throw fail('NOT_CONFIGURED', 'GRONKA_API_KEY is not set', { userMessage: 'The download service is not set up.' });
    const url = String(input || '').trim();
    if (!isHttpUrl(url) || url.length > 2048) throw fail('BAD_URL', 'a link is required', { userMessage: 'Please send a valid link.' });
    const body = { url, mode: MODES.has(mode) ? mode : 'auto', split: false };
    if (start) body.start = String(start);
    if (end) body.end = String(end);

    let response;
    try {
      response = await http.post(`${baseUrl}/v1/download`, body, {
        timeout: timeoutMs,
        maxContentLength: 1024 * 1024,
        responseType: 'text',
        transformResponse: [(data) => data],
        validateStatus: () => true,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      });
    } catch (error) {
      const timedOut = error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''));
      const code = timedOut ? 'TIMEOUT' : 'NETWORK_ERROR';
      logger.warn?.(`request failed (${code})`);
      throw fail(code, `gronka ${code}`, { userMessage: FIXED_MESSAGES[code] });
    }

    const status = Number(response?.status || 0);
    const data = parseBody(response?.data);
    if (data?.error) {
      const err = errorFrom(data, status, response?.headers?.['retry-after']);
      logger.warn?.(`download failed (${err.code}, HTTP ${status})`);
      throw err;
    }
    if (status < 200 || status >= 300) {
      const err = errorFrom(null, status, response?.headers?.['retry-after']);
      logger.warn?.(`download failed (${err.code})`);
      throw err;
    }
    if (!data) throw fail('BAD_RESPONSE', 'gronka sent an unreadable answer', { userMessage: FIXED_MESSAGES.BAD_RESPONSE });
    if (data.merge === true) throw fail('NEEDS_MERGE', 'gronka asked for a merge despite split:false', { userMessage: FIXED_MESSAGES.NEEDS_MERGE });

    const files = (Array.isArray(data.files) ? data.files : [])
      .filter((file) => isHttpUrl(file?.url))
      .map((file) => ({
        url: String(file.url),
        filename: typeof file.filename === 'string' ? file.filename.slice(0, 200) : '',
        type: String(file.type || '').toLowerCase(),
        kind: String(file.kind || '').toLowerCase(),
        size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
      }));
    if (!files.length) throw fail('NO_MEDIA', 'gronka returned no files', { userMessage: FIXED_MESSAGES.NO_MEDIA });
    return {
      lane: String(data.lane || ''),
      filename: typeof data.filename === 'string' ? data.filename.slice(0, 200) : '',
      note: typeof data.note === 'string' ? data.note.slice(0, 300) : '',
      files,
    };
  }

  /**
   * Is the service reachable and answering? Used by `.status` and check-live.
   * @returns {Promise<{state:'ok'|'down'|'not-set', ms:number, reason:string}>}
   */
  async function health() {
    if (!enabled) return { state: 'not-set', ms: 0, reason: 'GRONKA_API_KEY is not set' };
    const startedAt = Date.now();
    try {
      const response = await http.get(`${baseUrl}/v1/health`, {
        timeout: 8000, responseType: 'text', transformResponse: [(data) => data], validateStatus: () => true,
      });
      const body = parseBody(response?.data);
      const ms = Date.now() - startedAt;
      if (Number(response?.status) === 200 && body?.ok === true) return { state: 'ok', ms, reason: '' };
      return { state: 'down', ms, reason: `HTTP ${Number(response?.status) || 0}` };
    } catch (error) {
      return { state: 'down', ms: Date.now() - startedAt, reason: error?.code === 'ECONNABORTED' ? 'timeout' : String(error?.code || 'network error').slice(0, 40) };
    }
  }

  return { enabled, download, health };
}

/** Title guess from a file name such as "My clip.audio.m4a". */
const titleFromFilename = (name) => String(name || '').replace(/\.(?:video|audio)(?=\.[^.]+$)/i, '').replace(/\.[^.]+$/, '').slice(0, 250);

module.exports = { ...createGronka(), createGronka, titleFromFilename, constants: { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } };
