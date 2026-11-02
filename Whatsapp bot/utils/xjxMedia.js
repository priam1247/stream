'use strict';

/**
 * XJX-style YouTube media delivery.
 *
 * The resolver order intentionally mirrors XJX's working .song/.video flow:
 *
 *   audio: KnightBot -> ApisSupreme -> Apix -> Hector Worker (URL) ->
 *          Hector Worker (search text)
 *   video: KnightBot -> Keithsite
 *
 * Resolvers return remote URLs and Baileys sends those URLs directly. This
 * keeps .song/.video independent of the bot host's yt-dlp, ffmpeg, and YouTube
 * download access. Third-party credentials are read only from environment
 * configuration; no credentials from XJX's source are copied here.
 */

const axios = require('axios');
const ytSearch = require('yt-search');
const config = require('../config');
const log = require('./logger')('xjx-media');
const { safeUrl } = require('./publicMediaDownload');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 60000;
const XJX_RETRY_DELAY_MS = 1000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KNIGHTBOT_API = 'https://knightbotapi.stream/api/download';
const APISSUPREME_AUDIO_API = 'https://apissupreme.vercel.app/media/ytmp3';
const APIX_AUDIO_API = 'https://apix.wolvarex.com/api/music/ytmp3-download';
const HECTOR_WORKER_API = 'https://yt-dl.officialhectormanuel.workers.dev/';
const KEITHSITE_VIDEO_API = 'https://apis.keithsite.lol/download/video';
const AUDIO_LIMIT_MINUTES = Number(config.song?.maxMinutes) || 180;
const VIDEO_LIMIT_MINUTES = Number(config.video?.maxMinutes) || 0;
const VIDEO_QUALITIES = [144, 240, 360, 480, 720, 1080];
const http = axios.create({
  timeout: DEFAULT_TIMEOUT_MS,
  maxRedirects: 3,
  maxContentLength: 1024 * 1024,
  headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
});

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

function extractYouTubeId(input) {
  const text = String(input || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;

  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') return /^[\w-]{11}$/.test(parts[0] || '') ? parts[0] : null;
  if (host !== 'youtube.com' && !host.endsWith('.youtube.com') &&
      host !== 'youtube-nocookie.com' && !host.endsWith('.youtube-nocookie.com')) return null;

  const id = url.searchParams.get('v') ||
    (['shorts', 'embed', 'live', 'v'].includes(parts[0]) ? parts[1] : null);
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}

function canonicalYouTubeUrl(input) {
  const id = extractYouTubeId(input);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

function safeMediaUrl(value) {
  try { return safeUrl(value).href; } catch { return null; }
}

function safeCode(error) {
  const status = Number(error?.response?.status || error?.status);
  if (status === 401 || status === 403) return 'AUTH_REQUIRED';
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP_${status}`;
  const code = String(error?.code || '');
  if (/^(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNABORTED|ECONNRESET|ECONNREFUSED|NO_MEDIA|BAD_MEDIA_URL|SEARCH_FAILED|NOT_FOUND|NOT_YOUTUBE|TOO_LONG|SEND_FAILED)$/.test(code)) return code;
  return 'FAILED';
}

function safeTitle(value, fallback = 'media') {
  const text = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return text || fallback;
}

function formatDurationSeconds(value) {
  const n = Number(value) || 0;
  if (Number.isFinite(n) && n > 0) return n;
  return 0;
}

function createXjxMedia({
  http: httpClient = http,
  search: searchClient = ytSearch,
  settings = config.xjxMedia || {},
  logger = log,
  wait = pause,
} = {}) {
  const timeoutMs = Math.max(1000, Math.min(120000, Number(settings.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const keys = {
    knightbotApiKey: String(settings.knightbotApiKey || '').trim(),
    apissupremeApiKey: String(settings.apissupremeApiKey || '').trim(),
    apixKey: String(settings.apixKey || '').trim(),
  };

  // XJX's tryRequest helper retries each network request three times, with a
  // one-second step; its KnightBot audio/video helpers use two retries.
  async function getJson(url, params = {}, retries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await httpClient.get(url, {
          timeout: timeoutMs,
          maxRedirects: 3,
          maxContentLength: 1024 * 1024,
          headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
          params,
        });
        const status = Number(response?.status || 200);
        if (status < 200 || status >= 300) throw fail(`HTTP_${status}`, 'provider request failed', { status });
        return response?.data;
      } catch (error) {
        lastError = error;
        if (attempt >= retries) break;
        await wait(XJX_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    throw lastError || fail('NO_MEDIA', 'provider request failed');
  }

  function hitFrom(value, provider, fields = {}) {
    const download = safeMediaUrl(value);
    if (!download) throw fail('BAD_MEDIA_URL', 'provider returned an unsafe media URL');
    const fallbackValue = fields.fallback && fields.fallback !== value ? fields.fallback : '';
    const fallback = safeMediaUrl(fallbackValue);
    return {
      provider,
      download,
      fallback: fallback && fallback !== download ? fallback : '',
      title: typeof fields.title === 'string' ? fields.title.slice(0, 250) : '',
      thumbnail: typeof fields.thumbnail === 'string' ? fields.thumbnail.slice(0, 2048) : '',
      duration: formatDurationSeconds(fields.duration),
      quality: fields.quality || '',
    };
  }

  async function tryProviders(providers, kind) {
    const attempts = [];
    for (const provider of providers) {
      try {
        const hit = await provider.run();
        if (!hit?.download) throw fail('NO_MEDIA', 'provider returned no media URL');
        return { ...hit, attempts };
      } catch (error) {
        const code = safeCode(error);
        attempts.push({ provider: provider.name, code });
        // Never include request URLs or error messages; they may contain API keys.
        logger.warn?.(`${kind} provider ${provider.name} failed (${code})`);
      }
    }
    throw fail('NO_MEDIA', `all ${kind} providers failed`, { attempts });
  }

  async function resolveAudio(youtubeUrl, options = {}) {
    const url = canonicalYouTubeUrl(youtubeUrl);
    if (!url) throw fail('NOT_YOUTUBE', 'A YouTube link is required for audio resolution');
    return resolveAudioInput(url, options);
  }

  // This is the exact XJX .song resolver sequence: KnightBot → ApisSupreme
  // → Apix, then Hector's URL resolver, then Hector's search resolver.
  async function resolveAudioInput(inputUrl, { query = '' } = {}) {
    const url = String(inputUrl || '').trim();
    if (!isHttpUrl(url)) throw fail('NOT_YOUTUBE', 'An HTTP URL is required for audio resolution');
    const providers = [
      {
        name: 'KnightBot',
        run: async () => {
          const params = { format: '128kbps', url };
          if (keys.knightbotApiKey) params.apikey = keys.knightbotApiKey;
          const data = await getJson(`${KNIGHTBOT_API}/ytaudio`, params, 2);
          const result = data?.result || {};
          const direct = result.download || result.dl_url || result.dl;
          if (!data?.success || !direct) throw fail('NO_MEDIA', 'KnightBot returned no audio URL');
          return hitFrom(direct, 'KnightBot', result);
        },
      },
      {
        name: 'ApisSupreme',
        run: async () => {
          const params = { url };
          if (keys.apissupremeApiKey) params.apikey = keys.apissupremeApiKey;
          const data = await getJson(APISSUPREME_AUDIO_API, params);
          if (!data?.status || !data?.downloadUrl) throw fail('NO_MEDIA', 'ApisSupreme returned no audio URL');
          return hitFrom(data.downloadUrl, 'ApisSupreme', data);
        },
      },
      {
        name: 'Apix',
        run: async () => {
          const id = extractYouTubeId(url);
          const params = { id, provider: 'ytmp3' };
          if (keys.apixKey) params.key = keys.apixKey;
          const data = await getJson(APIX_AUDIO_API, params);
          const direct = data?.proxyURL || data?.directURL || data?.downloadURL;
          if (!data?.success || !direct) throw fail('NO_MEDIA', 'Apix returned no audio URL');
          return hitFrom(direct, 'Apix', {
            ...data,
            fallback: data?.directURL || data?.downloadURL,
          });
        },
      },
      {
        name: 'Hector URL',
        run: async () => {
          const data = await getJson(HECTOR_WORKER_API, { url });
          if (!data?.audio) throw fail('NO_MEDIA', 'Hector returned no audio URL');
          return hitFrom(data.audio, 'Hector', data);
        },
      },
      {
        name: 'Hector search',
        run: async () => {
          const searchText = String(query || url).trim();
          const data = await getJson(HECTOR_WORKER_API, { url: searchText });
          if (!data?.audio) throw fail('NO_MEDIA', 'Hector returned no audio URL');
          return hitFrom(data.audio, 'Hector', data);
        },
      },
    ];
    return tryProviders(providers, 'audio');
  }

  async function resolveVideo(youtubeUrl, options = {}) {
    const url = canonicalYouTubeUrl(youtubeUrl);
    if (!url) throw fail('NOT_YOUTUBE', 'A YouTube link is required for video resolution');
    return resolveVideoInput(url, options);
  }

  // XJX's .video helper requests 480p from KnightBot, then falls through to
  // Keithsite. The .video command always passes this same 480p default.
  async function resolveVideoInput(inputUrl, { quality = 480 } = {}) {
    const url = String(inputUrl || '').trim();
    if (!isHttpUrl(url)) throw fail('NOT_YOUTUBE', 'An HTTP URL is required for video resolution');
    const requested = VIDEO_QUALITIES.includes(Number(quality)) ? Number(quality) : 480;
    const providers = [
      {
        name: 'KnightBot',
        run: async () => {
          const params = { format: `${requested}p`, url };
          if (keys.knightbotApiKey) params.apikey = keys.knightbotApiKey;
          const data = await getJson(`${KNIGHTBOT_API}/ytmp4`, params, 2);
          const result = data?.result || {};
          const direct = result.download || result.dl_url || result.dl;
          if (!data?.success || !direct) throw fail('NO_MEDIA', 'KnightBot returned no video URL');
          return hitFrom(direct, 'KnightBot', { ...result, quality: result.format || `${requested}p` });
        },
      },
      {
        name: 'Keithsite',
        run: async () => {
          const data = await getJson(KEITHSITE_VIDEO_API, { url, format: 'mp4' });
          if (!data?.status || !data?.result) throw fail('NO_MEDIA', 'Keithsite returned no video URL');
          return hitFrom(data.result, 'Keithsite', data);
        },
      },
    ];
    return tryProviders(providers, 'video');
  }

  async function resolveYouTubeInput(input) {
    const text = String(input || '').trim();
    if (!text) throw fail('NOT_FOUND', 'a song name or YouTube link is required');
    const id = extractYouTubeId(text);
    if (id) {
      let details = {};
      try {
        const found = await searchClient({ videoId: id });
        details = found?.title ? found : {};
      } catch { /* a title lookup is optional for direct links */ }
      return {
        url: `https://www.youtube.com/watch?v=${id}`,
        id,
        title: String(details.title || '').slice(0, 250),
        author: String(details.author?.name || details.author || '').slice(0, 160),
        duration: formatDurationSeconds(details.duration?.seconds || details.seconds),
        thumbnail: String(details.thumbnail || '').slice(0, 2048),
      };
    }
    if (isHttpUrl(text)) throw fail('NOT_YOUTUBE', 'Only YouTube links or search terms are supported');

    let results;
    try { results = await searchClient(text); }
    catch { throw fail('SEARCH_FAILED', 'YouTube search failed'); }
    const first = results?.videos?.[0];
    const firstId = extractYouTubeId(first?.url || first?.videoId || first?.video_id || '');
    if (!first || !firstId) throw fail('NOT_FOUND', 'No YouTube results were found');
    return {
      url: `https://www.youtube.com/watch?v=${firstId}`,
      id: firstId,
      title: String(first.title || '').slice(0, 250),
      author: String(first.author?.name || first.author || first.uploader || '').slice(0, 160),
      duration: formatDurationSeconds(first.duration?.seconds || first.seconds),
      thumbnail: String(first.thumbnail || '').slice(0, 2048),
    };
  }

  async function resolveCommandInput(input) {
    const text = String(input || '').trim();
    if (!text) throw fail('NOT_FOUND', 'a song or video name or URL is required');

    // Match XJX: URLs go straight to its resolver; plain phrases use the first
    // yt-search hit. A title lookup for a YouTube URL is only cosmetic.
    if (isHttpUrl(text)) {
      let details = {};
      try {
        const id = extractYouTubeId(text);
        if (id) {
          const found = await searchClient({ videoId: id });
          details = found?.title ? found : {};
        }
      } catch { /* title lookup is optional */ }
      return { url: text, title: String(details.title || '').slice(0, 250) };
    }

    let results;
    try { results = await searchClient(text); }
    catch { throw fail('SEARCH_FAILED', 'YouTube search failed'); }
    const first = results?.videos?.[0];
    if (!first?.url || !isHttpUrl(first.url)) throw fail('NOT_FOUND', 'No YouTube results were found');
    return { url: first.url, title: String(first.title || '').slice(0, 250) };
  }

  function commandFileTitle(title, fallback) {
    return String(title || 'Unknown Title').replace(/[^\w\s\-()]/g, '').trim() || fallback;
  }

  async function downloadSongCommand(sock, msg, extra, input) {
    const chatId = extra?.from || msg?.key?.remoteJid;
    await sock.sendMessage(chatId, { react: { text: '🎼', key: msg.key } }).catch(() => {});
    const source = await resolveCommandInput(input);
    const hit = await resolveAudioInput(source.url, { query: input });
    const title = source.title || hit.title || 'Unknown Title';
    const fileName = `${commandFileTitle(title, 'audio')}.mp3`;
    const urls = [...new Set([hit.download, hit.fallback].filter(Boolean))];

    // XJX sends the title, then the same resolved URL as audio and a document.
    await sock.sendMessage(chatId, { text: `_${title}_` });
    let selectedUrl = '';
    let lastError = null;
    for (const mediaUrl of urls) {
      try {
        await sock.sendMessage(chatId, {
          audio: { url: mediaUrl }, mimetype: 'audio/mpeg', fileName, ptt: false,
        }, { quoted: msg });
        selectedUrl = mediaUrl;
        break;
      } catch (error) { lastError = error; }
    }
    if (!selectedUrl) throw lastError || fail('SEND_FAILED', 'audio send failed');
    await sock.sendMessage(chatId, {
      document: { url: selectedUrl }, mimetype: 'audio/mpeg', fileName,
    }, { quoted: msg });
    try { require('./telemetry').recordDownloadSuccess('audio'); } catch { /* optional telemetry */ }
    return { sent: true, kind: 'audio', via: hit.provider, title };
  }

  async function downloadVideoCommand(sock, msg, extra, input) {
    const chatId = extra?.from || msg?.key?.remoteJid;
    await sock.sendMessage(chatId, { react: { text: '🎬', key: msg.key } }).catch(() => {});
    const source = await resolveCommandInput(input);
    const hit = await resolveVideoInput(source.url, { quality: 480 });
    const title = source.title || hit.title || 'Unknown Title';
    const fileName = `${commandFileTitle(title, 'video')}.mp4`;
    const urls = [...new Set([hit.download, hit.fallback].filter(Boolean))];
    let sent = false;
    let lastError = null;

    for (const mediaUrl of urls) {
      try {
        await sock.sendMessage(chatId, {
          video: { url: mediaUrl }, mimetype: 'video/mp4', fileName, caption: `_${title}_`,
        }, { quoted: msg });
        sent = true;
        break;
      } catch (error) { lastError = error; }
    }
    if (!sent) {
      for (const mediaUrl of urls) {
        try {
          await sock.sendMessage(chatId, {
            document: { url: mediaUrl }, mimetype: 'video/mp4', fileName, caption: `_${title}_`,
          }, { quoted: msg });
          sent = true;
          break;
        } catch (error) { lastError = error; }
      }
    }
    if (!sent) throw lastError || fail('SEND_FAILED', 'video send failed');
    try { require('./telemetry').recordDownloadSuccess('video'); } catch { /* optional telemetry */ }
    return { sent: true, kind: 'video', via: hit.provider, title };
  }

  async function sendWithFallback(sock, chatId, msg, urls, buildMessage) {
    let lastError = null;
    for (const url of [...new Set(urls.filter(Boolean))]) {
      try {
        await sock.sendMessage(chatId, buildMessage(url), { quoted: msg });
        return true;
      } catch (error) { lastError = error; }
    }
    return lastError || false;
  }

  async function downloadAndSend(sock, msg, extra, {
    url = '', query = '', kind = 'audio', height = 480, title = '', author = '', sendAs = '',
    maxMinutes = undefined, track = null,
  } = {}) {
    const mediaKind = kind === 'video' ? 'video' : 'audio';
    const chatId = extra?.from || msg?.key?.remoteJid;
    const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});
    const trackTitle = String(title || track?.title || '').trim();
    const trackAuthor = String(author || track?.artists?.join?.(', ') || track?.author || '').trim();
    const input = String(url || query || [trackAuthor, trackTitle].filter(Boolean).join(' ') || '').trim();
    const durationLimit = Number(maxMinutes ?? (mediaKind === 'audio' ? AUDIO_LIMIT_MINUTES : VIDEO_LIMIT_MINUTES)) || 0;

    await react('⏳');
    try {
      const source = await resolveYouTubeInput(input);
      if (durationLimit && source.duration && source.duration > durationLimit * 60) {
        throw fail('TOO_LONG', `Media exceeds the ${durationLimit} minute limit`);
      }

      const hit = mediaKind === 'audio'
        ? await resolveAudio(source.url, { query: query || input })
        : await resolveVideo(source.url, { quality: height });
      const titleForFile = safeTitle(trackTitle || source.title || hit.title || '', mediaKind === 'audio' ? 'song' : 'video');
      const authorForFile = safeTitle(trackAuthor || source.author || '', '');
      const fileBase = safeTitle(authorForFile ? `${authorForFile} - ${titleForFile}` : titleForFile, mediaKind);
      const urls = [hit.download, hit.fallback].filter(Boolean);
      const caption = mediaKind === 'audio'
        ? `🎵 *${titleForFile}*${authorForFile ? `\n👤 ${authorForFile}` : ''}`
        : `_${titleForFile}_${`\n📺 ${hit.quality || `${height}p`}`}`;
      let sent = false;
      const sendErrors = [];

      if (mediaKind === 'audio') {
        const preferred = String(sendAs || config.song?.sendAs || 'document').toLowerCase() === 'audio' ? 'audio' : 'document';
        const types = preferred === 'audio' ? ['audio', 'document'] : ['document', 'audio'];
        for (const type of types) {
          const result = await sendWithFallback(sock, chatId, msg, urls, (mediaUrl) => type === 'audio'
            ? { audio: { url: mediaUrl }, mimetype: 'audio/mpeg', fileName: `${fileBase}.mp3`, ptt: false }
            : { document: { url: mediaUrl }, mimetype: 'audio/mpeg', fileName: `${fileBase}.mp3`, caption });
          if (result === true) { sent = true; break; }
          if (result) sendErrors.push(type);
        }
      } else {
        const videoResult = await sendWithFallback(sock, chatId, msg, urls, (mediaUrl) => ({
          video: { url: mediaUrl }, mimetype: 'video/mp4', fileName: `${fileBase}.mp4`, caption,
        }));
        if (videoResult === true) sent = true;
        else {
          sendErrors.push('video');
          const documentResult = await sendWithFallback(sock, chatId, msg, urls, (mediaUrl) => ({
            document: { url: mediaUrl }, mimetype: 'video/mp4', fileName: `${fileBase}.mp4`, caption,
          }));
          if (documentResult === true) sent = true;
          else sendErrors.push('document');
        }
      }

      if (!sent) throw fail('SEND_FAILED', 'WhatsApp could not send the resolved media URL', {
        attempts: [...(hit.attempts || []), ...sendErrors.map((type) => ({ provider: `WhatsApp ${type}`, code: 'SEND_FAILED' }))],
      });
      await react('✅');
      try { require('./telemetry').recordDownloadSuccess(mediaKind); } catch { /* optional telemetry */ }
      return { sent: true, kind: mediaKind, via: hit.provider, title: titleForFile };
    } catch (error) {
      await react('❌');
      try { require('./telemetry').recordFailure(mediaKind === 'audio' ? 'song' : 'video'); } catch { /* optional telemetry */ }
      const code = safeCode(error);
      logger.warn?.(`${mediaKind} delivery failed (${code})`);
      if (!error.code) error.code = code;
      throw error;
    }
  }

  return {
    resolveAudio,
    resolveAudioInput,
    resolveVideo,
    resolveVideoInput,
    resolveYouTubeInput,
    resolveCommandInput,
    downloadSongCommand,
    downloadVideoCommand,
    downloadAndSend,
    extractYouTubeId,
    canonicalYouTubeUrl,
    isYouTubeUrl: (input) => Boolean(extractYouTubeId(input)),
    safeMediaUrl,
  };
}

const defaultClient = createXjxMedia();

function friendlyError(error, { isOwner = false } = {}) {
  const code = safeCode(error);
  if (code === 'NOT_FOUND') return '❌ No YouTube results found.';
  if (code === 'NOT_YOUTUBE') return '❌ Use a YouTube URL or a song/video search phrase.';
  if (code === 'SEARCH_FAILED') return '❌ YouTube search is temporarily unavailable.';
  if (code === 'TOO_LONG') return `❌ ${error?.message || 'That media is too long.'}`;
  if (code === 'SEND_FAILED') return '❌ The media provider returned a link, but WhatsApp could not send it.';

  const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
  if (isOwner && attempts.length) {
    const summary = attempts.map((attempt) => `${attempt.provider}: ${attempt.code}`).join(' · ');
    return `❌ XJX-compatible media providers failed.\n${summary}`;
  }
  if (code === 'NO_MEDIA') return '❌ The media providers could not prepare that file. Try again in a little while.';
  return '❌ Could not send that media. Check the YouTube link or try a shorter/other result.';
}

module.exports = {
  ...defaultClient,
  createXjxMedia,
  friendlyError,
  safeTitle,
  constants: {
    DEFAULT_TIMEOUT_MS,
    KNIGHTBOT_API,
    APISSUPREME_AUDIO_API,
    APIX_AUDIO_API,
    HECTOR_WORKER_API,
    KEITHSITE_VIDEO_API,
    VIDEO_QUALITIES,
  },
};
