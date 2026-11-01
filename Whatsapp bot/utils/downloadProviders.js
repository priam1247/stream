/**
 * Remote YouTube/media resolvers. A URL alone is not a successful download:
 * callers can pass `accept` to fetch and validate a candidate and continue to
 * the next provider if the actual file is unavailable or invalid.
 */
const fs = require('fs');
const axios = require('axios');
const APIs = require('./api');
const config = require('../config');
const settings = require('./mediaSettings');
const yt1d = require('./yt1d');
const knight = require('./knightYouTube');
const { downloadPublicFile } = require('./publicMediaDownload');
const { sniffFile, probeMedia } = require('./mediaTransfer');
const ffmpeg = require('./ffmpeg');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT = 45000;
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const fail = (code, message) => Object.assign(new Error(message), { code });

const DEFAULT_COBALT_INSTANCES = [
  'https://cobalt-api.kwiatekmiki.com',
  'https://co.eepy.today',
  'https://api.cobalt.tools',
];

function cobaltInstances() {
  const fromEnv = String(process.env.COBALT_INSTANCES || '').split(',').map(s => s.trim()).filter(Boolean);
  const fromConfig = Array.isArray(config.cobalt?.instances) ? config.cobalt.instances.filter(Boolean) : [];
  const fromSettings = Array.isArray(settings.get('cobaltInstances', [])) ? settings.get('cobaltInstances', []) : [];
  const all = [...fromEnv, ...fromConfig, ...fromSettings];
  if (all.length) return all;
  return config.cobalt?.useDefaultInstances === false ? [] : DEFAULT_COBALT_INSTANCES;
}

function pickCobaltUrl(json) {
  if (!json || typeof json !== 'object' || String(json.status || '').toLowerCase() === 'error') return null;
  if (isHttp(json.url)) return json.url;
  if (Array.isArray(json.picker) && json.picker.length) {
    const video = json.picker.find(p => p && p.type === 'video') || json.picker[0];
    if (video && isHttp(video.url)) return video.url;
  }
  return isHttp(json.audio) ? json.audio : null;
}

async function cobaltResolve(baseUrl, { url, kind, quality, timeoutMs }) {
  const endpoint = String(baseUrl).replace(/\/+$/, '') + '/';
  const res = await axios.post(endpoint, {
    url, downloadMode: kind === 'audio' ? 'audio' : 'auto', videoQuality: String(quality || 720),
    audioFormat: 'mp3', filenameStyle: 'basic',
  }, {
    timeout: Math.min(timeoutMs, 15000), maxRedirects: 3,
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' }, validateStatus: null,
  });
  if (res.status >= 400) throw fail('HTTP_ERROR', `cobalt HTTP ${res.status}`);
  const direct = pickCobaltUrl(res.data);
  if (!direct) throw fail('NO_FORMATS', 'cobalt returned no media');
  const ext = String(res.data.filename || '').match(/\.([a-z0-9]{2,4})(?:\?|$)/i);
  return {
    provider: `cobalt (${new URL(endpoint).host})`, url: direct,
    ext: ext ? ext[1].toLowerCase() : (kind === 'audio' ? 'mp3' : 'mp4'),
    title: typeof res.data.filename === 'string' ? res.data.filename.slice(0, 250) : '', headers: {},
  };
}

function candidates() {
  const list = [
    {
      name: 'hector', kinds: ['audio', 'video'], enabled: knight.enabled,
      resolve: (opts) => knight.createClient().resolve(opts.url, opts),
    },
    {
      name: 'yt1d', kinds: ['audio', 'video'],
      enabled: () => Boolean((!process.env.FAKE_YTDLP || process.env.YT1D_BASE_URL) && process.env.YT1D_DISABLED !== '1'),
      resolve: async ({ url, kind, quality, timeoutMs }) => {
        if (!yt1d.extractVideoId(url)) throw fail('UNSUPPORTED_URL', 'yt1d only supports YouTube');
        const hit = await yt1d.resolveYt1d(url, { kind, quality, timeoutMs });
        if (!hit || !isHttp(hit.url)) throw fail('NO_FORMATS', 'yt1d returned no media');
        return hit;
      },
    },
    {
      name: 'gifted', kinds: ['audio', 'video'], enabled: () => Boolean(String(config.giftedApi?.apiKey || '').trim()),
      resolve: async ({ url, kind, quality, timeoutMs }) => {
        const hit = kind === 'audio'
          ? await APIs.getGiftedAudioByUrl(url, { timeout: Math.min(timeoutMs, 20000) })
          : await APIs.getGiftedVideoByUrl(url, quality, { timeout: Math.min(timeoutMs, 20000) });
        if (!hit || !isHttp(hit.download)) throw fail('NO_FORMATS', 'gifted returned no media');
        return { provider: 'gifted', url: hit.download, ext: kind === 'audio' ? 'mp3' : 'mp4', title: hit.title || '', headers: {} };
      },
    },
  ];
  // Keep instances separate: a resolved but broken file from one must not
  // prevent trying the other instances.
  for (const base of cobaltInstances()) {
    list.push({ name: 'cobalt', kinds: ['audio', 'video'], enabled: () => true, resolve: (opts) => cobaltResolve(base, opts) });
  }
  return list;
}

function listProviders() {
  const list = candidates();
  const names = ['hector', 'yt1d', 'gifted', 'cobalt'];
  return names.map((name) => ({ name, kinds: ['audio', 'video'], enabled: list.some((p) => p.name === name && p.enabled()) }));
}

function safeFailure(err) {
  const status = Number(err?.response?.status || err?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP_${status}`;
  const code = String(err?.code || '');
  return /^(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNABORTED|ECONNRESET|ECONNREFUSED|NETWORK|NO_FORMATS|BAD_SOURCE|TOO_BIG|TOO_LONG|UNSAFE_SOURCE|MEDIA_UNAVAILABLE|MEDIA_NETWORK|MEDIA_RATE_LIMIT|HTTP_ERROR|UNSUPPORTED_URL)$/.test(code) ? code : 'FAILED';
}

/**
 * Resolve candidates concurrently, but consume files in provider order so only
 * one large file is downloaded at a time. An `accept` failure advances to the
 * next provider, rather than treating a signed URL as a successful download.
 */
async function resolveMedia(url, {
  kind = 'audio', quality = 720, timeoutMs = DEFAULT_TIMEOUT, onAttempt, accept, only, exclude = [],
} = {}) {
  if (settings.get('remoteFallback', true) === false) throw fail('FALLBACK_DISABLED', 'remote fallbacks are disabled');
  const usable = candidates().filter(p => p.enabled() && p.kinds.includes(kind) &&
    (!only || only.includes(p.name)) && !exclude.includes(p.name));
  if (!usable.length) throw fail('NO_PROVIDERS', 'no remote provider is configured');

  const errors = [];
  const report = (name, err) => {
    const code = safeFailure(err);
    errors.push(`${name}: ${code}`);
    if (onAttempt) onAttempt(name, err, { code });
  };
  // Turn every promise into a settled value immediately, even while a prior
  // candidate is being downloaded, to avoid unhandled rejection races.
  const tasks = usable.map(async (p) => {
    try {
      const hit = await p.resolve({ url, kind, quality, timeoutMs });
      return { p, hit: { ...hit, provider: hit.provider || p.name } };
    } catch (err) { return { p, err }; }
  });

  if (typeof accept === 'function') {
    let sizeError = null;
    for (const task of tasks) {
      const { p, hit, err } = await task;
      if (err) { report(p.name, err); continue; }
      try {
        const accepted = await accept(hit);
        if (!accepted) throw fail('BAD_SOURCE', 'media file was not accepted');
        if (onAttempt) onAttempt(p.name, null, { code: 'OK' });
        return { ...hit, ...accepted };
      } catch (error) {
        if (['TOO_LONG', 'NOT_ENOUGH_DISK', 'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS'].includes(error?.code)) throw error;
        if (error?.code === 'TOO_BIG') sizeError = error;
        report(p.name, error);
      }
    }
    if (sizeError) throw sizeError;
  } else {
    try {
      return await Promise.any(tasks.map(async (task) => {
        const { p, hit, err } = await task;
        if (err) { report(p.name, err); throw err; }
        if (onAttempt) onAttempt(p.name, null, { code: 'OK' });
        return hit;
      }));
    } catch { /* report a single safe error below */ }
  }
  const err = fail('NO_PROVIDERS', `all remote providers failed — ${errors.join(' | ')}`);
  err.attempts = errors;
  throw err;
}

/** Download one provider's file safely, then verify its actual streams. */
async function fetchCandidate(hit, {
  outBase, kind = 'audio', maxBytes, maxSeconds = 0, expectedSeconds = 0, timeoutMs = 180000,
  transfer = downloadPublicFile, inspect = probeMedia, hasFfmpeg = ffmpeg.works,
} = {}) {
  if (!outBase || !['audio', 'video'].includes(kind) || !knight.usableUrl(hit?.url)) {
    throw fail('BAD_SOURCE', 'Unsafe or IP-bound media URL');
  }
  const dest = `${outBase}_remote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.bin`;
  let downloaded = false;
  try {
    // The transfer owns cleanup until it returns. In particular, never remove
    // an existing file if its exclusive open fails with EEXIST.
    const got = await transfer(hit.url, dest, { maxBytes, timeoutMs, headers: hit.headers || {} });
    downloaded = true;
    const sniff = sniffFile(dest);
    if (sniff.kind === 'unknown' || sniff.kind === 'image') throw fail('BAD_SOURCE', 'Media has an unsupported container');
    const info = await inspect(dest);
    if (info.probed) {
      if (!info.hasAudio || (kind === 'video' && !info.hasVideo)) throw fail('BAD_SOURCE', 'Media is missing a required track');
      const duration = Number(info.duration) || 0;
      if (maxSeconds && !duration) throw fail('BAD_SOURCE', 'Media duration could not be verified');
      if (maxSeconds && duration > maxSeconds) throw fail('TOO_LONG', 'Media exceeds duration limit');
      const expected = Number(expectedSeconds) || 0;
      if (expected > 0 && duration > 0 && duration < expected - Math.max(3, expected * 0.05)) {
        throw fail('BAD_SOURCE', 'Media is shorter than the selected recording');
      }
    } else {
      if (maxSeconds || expectedSeconds || hasFfmpeg() || (kind === 'audio' ? sniff.kind !== 'audio' : sniff.kind !== 'video')) {
        throw fail('BAD_SOURCE', 'Media could not be verified');
      }
    }
    const audioInMp4 = kind === 'audio' && info.probed && info.hasAudio && !info.hasVideo && sniff.ext === 'mp4';
    return { file: dest, bytes: got.bytes, sniff: audioInMp4 ? { kind: 'audio', ext: 'm4a', mime: 'audio/mp4' } : sniff, metadata: info };
  } catch (err) {
    if (downloaded) {
      try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    }
    throw err;
  }
}

function preferredEnabled() {
  return knight.enabled() && settings.get('remoteFallback', true) !== false;
}

module.exports = { resolveMedia, fetchCandidate, preferredEnabled, listProviders, cobaltInstances, DEFAULT_TIMEOUT };
