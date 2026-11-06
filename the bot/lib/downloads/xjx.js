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

const ytSearch = require('yt-search');
const config = require('../../config');
const log = require('../logger')('xjx-media');
const { safeUrl } = require('../publicMediaDownload');
const defaultGronka = require('./gronka');

const AUDIO_LIMIT_MINUTES = Number(config.song?.maxMinutes) || 180;
const VIDEO_LIMIT_MINUTES = Number(config.video?.maxMinutes) || 0;
const VIDEO_QUALITIES = [144, 240, 360, 480, 720, 1080];

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

function cleanSongText(value) {
  return String(value || '')
    .replace(/\s*[[(]\s*(?:official|lyrics?|lyric\s+video|music\s+video|audio|visuali[sz]er|hd|4k)\b[^)\]]*[)\]]\s*/ig, ' ')
    .replace(/\s+(?:\||[-–—])\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|visuali[sz]er)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseSongArtist(value) {
  return cleanSongText(value)
    .replace(/\s*(?:[-–—]\s*)?(?:topic|vevo|official channel)$/i, '')
    .trim();
}

function songMetadata(source = {}, input = '') {
  const sourceTitle = cleanSongText(source.title || '');
  const searchInput = cleanSongText(input);
  const author = normaliseSongArtist(source.author || '');
  const candidate = sourceTitle || searchInput || 'Unknown Song';
  const parts = candidate.split(/\s+(?:-|–|—|:)\s+/).map((part) => part.trim()).filter(Boolean);
  let title = candidate;
  let artist = author;

  if (parts.length >= 2) {
    const first = normaliseSongArtist(parts[0]);
    const rest = cleanSongText(parts.slice(1).join(' - '));
    const firstMatchesAuthor = author && first.toLowerCase() === author.toLowerCase();
    const lastMatchesAuthor = author && normaliseSongArtist(parts.at(-1)).toLowerCase() === author.toLowerCase();
    if (lastMatchesAuthor && !firstMatchesAuthor) {
      artist = author;
      title = cleanSongText(parts.slice(0, -1).join(' - '));
    } else {
      artist = first || author;
      title = rest;
    }
  } else if (artist && candidate.toLowerCase().startsWith(`${artist.toLowerCase()} `)) {
    title = candidate.slice(artist.length).trim();
  }

  title = cleanSongText(title) || sourceTitle || searchInput || 'Unknown Song';
  artist = normaliseSongArtist(artist);
  if (artist && title.toLowerCase().startsWith(`${artist.toLowerCase()} - `)) {
    title = title.slice(artist.length + 3).trim();
  }
  return { artist, title, display: artist ? `${artist} - ${title}` : title };
}

function formatDurationSeconds(value) {
  const n = Number(value) || 0;
  if (Number.isFinite(n) && n > 0) return n;
  return 0;
}

function createXjxMedia({
  search: searchClient = ytSearch,
  settings = config.xjxMedia || {},
  logger = log,
  gronka = defaultGronka,
} = {}) {
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

  // Gronka is the ONLY media source for .song and .video: one request, and any
  // failure is reported as is. Nothing else is tried behind it, so a broken
  // source is visible instead of being hidden by a backup.
  async function resolveViaGronka(kind, url) {
    if (!gronka.enabled) {
      throw fail('NOT_CONFIGURED', 'GRONKA_API_KEY is not set', { userMessage: 'Downloads are not set up yet. The owner needs to set GRONKA_API_KEY.' });
    }
    const result = await gronka.download(url, { mode: kind === 'audio' ? 'audio' : 'auto' });
    const file = result.files.find((item) => item.kind === kind || item.type === kind) || result.files[0];
    const hit = hitFrom(file.url, 'Gronka', { title: defaultGronka.titleFromFilename(file.filename || result.filename) });
    return { ...hit, attempts: [] };
  }

  async function resolveAudio(youtubeUrl, options = {}) {
    const url = canonicalYouTubeUrl(youtubeUrl);
    if (!url) throw fail('NOT_YOUTUBE', 'A YouTube link is required for audio resolution');
    return resolveAudioInput(url, options);
  }

  async function resolveAudioInput(inputUrl) {
    const url = String(inputUrl || '').trim();
    if (!isHttpUrl(url)) throw fail('NOT_YOUTUBE', 'An HTTP URL is required for audio resolution');
    return resolveViaGronka('audio', url);
  }

  async function resolveVideo(youtubeUrl, options = {}) {
    const url = canonicalYouTubeUrl(youtubeUrl);
    if (!url) throw fail('NOT_YOUTUBE', 'A YouTube link is required for video resolution');
    return resolveVideoInput(url, options);
  }

  async function resolveVideoInput(inputUrl) {
    const url = String(inputUrl || '').trim();
    if (!isHttpUrl(url)) throw fail('NOT_YOUTUBE', 'An HTTP URL is required for video resolution');
    return resolveViaGronka('video', url);
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
      return {
        url: text,
        title: String(details.title || '').slice(0, 250),
        author: String(details.author?.name || details.author || details.uploader || '').slice(0, 160),
      };
    }

    let results;
    try { results = await searchClient(text); }
    catch { throw fail('SEARCH_FAILED', 'YouTube search failed'); }
    const first = results?.videos?.[0];
    if (!first?.url || !isHttpUrl(first.url)) throw fail('NOT_FOUND', 'No YouTube results were found');
    return {
      url: first.url,
      title: String(first.title || '').slice(0, 250),
      author: String(first.author?.name || first.author || first.uploader || '').slice(0, 160),
    };
  }

  function commandFileTitle(title, fallback) {
    return String(title || 'Unknown Title').replace(/[^\w\s\-()]/g, '').trim() || fallback;
  }

  async function downloadSongCommand(sock, msg, extra, input) {
    const chatId = extra?.from || msg?.key?.remoteJid;
    await sock.sendMessage(chatId, { react: { text: '🎼', key: msg.key } }).catch(() => {});
    const source = await resolveCommandInput(input);
    const hit = await resolveAudioInput(source.url, { query: input });
    const fallbackInput = isHttpUrl(input) ? '' : input;
    const metadata = songMetadata({
      title: source.title || hit.title,
      author: source.author,
    }, fallbackInput);
    const fileName = `${safeTitle(metadata.display, 'song')}.mp3`;
    const caption = `🎵 *${metadata.display}*`;
    const urls = [...new Set([hit.download, hit.fallback].filter(Boolean))];

    // Keep .song to one WhatsApp media message: a tagged-by-name MP3 document.
    let selectedUrl = '';
    let lastError = null;
    for (const mediaUrl of urls) {
      try {
        await sock.sendMessage(chatId, {
          document: { url: mediaUrl }, mimetype: 'audio/mpeg', fileName, caption,
        }, { quoted: msg });
        selectedUrl = mediaUrl;
        break;
      } catch (error) { lastError = error; }
    }
    if (!selectedUrl) throw lastError || fail('SEND_FAILED', 'audio document send failed');
    try { require('../telemetry').recordDownloadSuccess('audio'); } catch { /* optional telemetry */ }
    return {
      sent: true, kind: 'audio', via: hit.provider,
      title: metadata.title, artist: metadata.artist, fileName,
    };
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
    try { require('../telemetry').recordDownloadSuccess('video'); } catch { /* optional telemetry */ }
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
      try { require('../telemetry').recordDownloadSuccess(mediaKind); } catch { /* optional telemetry */ }
      return { sent: true, kind: mediaKind, via: hit.provider, title: titleForFile };
    } catch (error) {
      await react('❌');
      try { require('../telemetry').recordFailure(mediaKind === 'audio' ? 'song' : 'video'); } catch { /* optional telemetry */ }
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
  if (error?.userMessage) return `❌ ${error.userMessage}`;
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
    VIDEO_QUALITIES,
  },
};
