'use strict';

/**
 * Brick 2 — YouTube's public player/search endpoint.
 *
 * No youtubei.js, no OAuth, no yt-dlp. We speak the same JSON protocol the
 * YouTube web player speaks, rotating through public client identities until
 * one returns playable streaming data. Every failure is recorded with its
 * client id and playability status so `.mdiag` can show exactly what broke.
 */

const C = require('./constants');
const http = require('./http');
const { EngineError } = http;

const clean = (value) => String(value ?? '').trim();
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function bodyFor(client, extra = {}) {
  const contextClient = {
    clientName: client.clientName,
    clientVersion: client.clientVersion,
    hl: 'en',
    gl: 'US',
    userAgent: client.userAgent,
    ...(client.androidSdkVersion ? { androidSdkVersion: client.androidSdkVersion } : {}),
    ...(client.deviceMake ? { deviceMake: client.deviceMake } : {}),
    ...(client.deviceModel ? { deviceModel: client.deviceModel } : {}),
    ...(client.osName ? { osName: client.osName } : {}),
    ...(client.osVersion ? { osVersion: client.osVersion } : {}),
    ...(client.clientScreen ? { clientScreen: client.clientScreen } : {}),
    ...(C.VISITOR_DATA ? { visitorData: C.VISITOR_DATA } : {}),
  };
  const context = { client: contextClient };
  if (client.embedded) context.thirdParty = { embedUrl: 'https://www.youtube.com/' };

  return {
    context,
    ...extra,
    contentCheckOk: true,
    racyCheckOk: true,
    ...(C.PO_TOKEN ? { serviceIntegrityDimensions: { poToken: C.PO_TOKEN } } : {}),
    ...(client.embedded
      ? { playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } } }
      : {}),
  };
}

function headersFor(client) {
  return {
    'Content-Type': 'application/json',
    Origin: C.YT_ORIGIN,
    Referer: `${C.YT_ORIGIN}/`,
    'User-Agent': client.userAgent || C.UA_DESKTOP,
    'X-YouTube-Client-Name': String(client.nameId),
    'X-YouTube-Client-Version': client.clientVersion,
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

const urlFor = (endpoint) => `${endpoint}?key=${encodeURIComponent(C.YT_API_KEY)}&prettyPrint=false`;

/** Turn a raw streamingData format into a predictable shape. */
function normalizeFormat(format) {
  const mime = clean(format?.mimeType);
  const hasVideo = /^video\//.test(mime);
  const hasAudio = /^audio\//.test(mime) || Boolean(format?.audioQuality) || C.PROGRESSIVE_ITAGS.includes(Number(format?.itag));
  let url = clean(format?.url);
  let ciphered = false;
  if (!url && format?.signatureCipher) {
    // We do not ship a JS decipherer; keep the shape so diagnostics can say
    // "ciphered" instead of silently pretending the format is unusable.
    try { url = clean(new URLSearchParams(String(format.signatureCipher)).get('url')); }
    catch { url = ''; }
    ciphered = true;
  }
  return {
    itag: Number(format?.itag) || 0,
    mime,
    bitrate: num(format?.bitrate),
    width: num(format?.width),
    height: num(format?.height),
    fps: num(format?.fps),
    contentLength: num(format?.contentLength),
    qualityLabel: clean(format?.qualityLabel),
    audioQuality: clean(format?.audioQuality),
    hasVideo,
    hasAudio,
    url,
    ciphered,
    downloadable: Boolean(url) && !ciphered,
  };
}

/** Try one client against /player and report why it did or did not work. */
async function playerWithClient(videoId, client, { timeout = C.REQUEST_TIMEOUT_MS } = {}) {
  const attempt = { client: client.id, ok: false, status: '', reason: '', formats: 0, downloadable: 0 };
  try {
    const data = await http.postJson(
      urlFor(C.YT_PLAYER),
      bodyFor(client, { videoId }),
      { headers: headersFor(client), timeout },
    );
    const play = data?.playabilityStatus || {};
    attempt.status = clean(play.status || 'UNKNOWN');
    attempt.reason = clean(play.reason || data?.error?.message || '');
    if (attempt.status !== 'OK') return attempt;

    const streaming = data?.streamingData || {};
    const formats = [...(streaming.formats || []), ...(streaming.adaptiveFormats || [])]
      .map(normalizeFormat)
      .slice(0, C.MAX_DIRECT_FORMATS);
    attempt.formats = formats.length;
    attempt.downloadable = formats.filter((f) => f.downloadable).length;
    attempt.hlsManifestUrl = clean(streaming.hlsManifestUrl);
    attempt.dashManifestUrl = clean(streaming.dashManifestUrl);
    attempt.ok = Boolean(formats.length || attempt.hlsManifestUrl || attempt.dashManifestUrl);
    if (attempt.ok) {
      attempt.result = {
        client: client.id,
        title: clean(data?.videoDetails?.title),
        author: clean(data?.videoDetails?.author),
        duration: num(data?.videoDetails?.lengthSeconds),
        thumbnail: data?.videoDetails?.thumbnail?.thumbnails?.at(-1)?.url || '',
        formats,
        hlsManifestUrl: attempt.hlsManifestUrl,
        dashManifestUrl: attempt.dashManifestUrl,
      };
    }
    return attempt;
  } catch (err) {
    attempt.status = err.code || 'REQUEST_FAILED';
    attempt.reason = err.message;
    return attempt;
  }
}

/**
 * Rotate through the client matrix until one gives playable data.
 * @returns {Promise<{result:object, attempts:Array}>}
 */
async function player(videoId, { clients = C.CLIENTS, timeout = C.REQUEST_TIMEOUT_MS,
  deadlineMs = C.CLIENT_TOTAL_TIMEOUT_MS } = {}) {
  if (!/^[-_0-9A-Za-z]{11}$/.test(String(videoId || ''))) {
    throw new EngineError('BAD_VIDEO_ID', 'Not a YouTube video id');
  }
  const attempts = [];
  const deadline = Date.now() + deadlineMs;
  for (const client of clients.slice(0, C.MAX_CLIENTS_PER_REQUEST)) {
    const remaining = Math.max(3000, Math.min(timeout, deadline - Date.now()));
    const attempt = await playerWithClient(videoId, client, { timeout: remaining });
    attempts.push(attempt);
    if (attempt.ok && attempt.result) return { result: attempt.result, attempts };
    if (Date.now() >= deadline) break;
  }
  const summary = attempts.map((a) => `${a.client}: ${a.status}${a.reason ? ` (${a.reason})` : ''}`).join('; ');
  throw Object.assign(
    new EngineError('NO_FORMATS', `No YouTube client returned playable streams — ${summary}`),
    { attempts },
  );
}

/** Public search endpoint, used only when yt-search is unavailable. */
async function search(query, { limit = 5, timeout = C.REQUEST_TIMEOUT_MS } = {}) {
  const q = clean(query);
  if (!q) return [];
  const client = C.CLIENTS.find((c) => c.id === 'ANDROID') || C.CLIENTS[0];
  const data = await http.postJson(
    urlFor(C.YT_SEARCH),
    bodyFor(client, { query: q, params: 'EgIQAQ%3D%3D' }),
    { headers: headersFor(client), timeout },
  );

  const rows = [];
  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
    ?.sectionListRenderer?.contents || [];
  for (const section of sections) {
    const items = section?.itemSectionRenderer?.contents || [];
    for (const item of items) {
      const vr = item?.videoRenderer;
      if (vr?.videoId) {
        const title = clean(vr.title?.runs?.map((r) => r.text).join(''))
          || clean(vr.title?.simpleText);
        rows.push({
          id: clean(vr.videoId),
          url: `${C.YT_WATCH}${clean(vr.videoId)}`,
          title: title || 'Unknown title',
          author: clean(vr.ownerText?.runs?.map((r) => r.text).join('')) || '',
          duration: parseLength(clean(vr.lengthText?.simpleText)),
          thumbnail: vr.thumbnail?.thumbnails?.at(-1)?.url || '',
        });
        continue;
      }
      // Newer search responses use lockupViewModel instead of videoRenderer.
      const lockup = item?.lockupViewModel;
      const id = clean(lockup?.contentId);
      if (id && /^[-_0-9A-Za-z]{11}$/.test(id)) {
        rows.push({
          id,
          url: `${C.YT_WATCH}${id}`,
          title: clean(lockup?.metadata?.lockupMetadataViewModel?.title?.content) || 'Unknown title',
          author: '',
          duration: 0,
          thumbnail: '',
        });
      }
    }
  }
  return rows.slice(0, limit);
}

function parseLength(text) {
  const parts = String(text || '').split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/** Extract an 11-char video id from any public YouTube URL shape. */
function videoIdOf(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); }
  catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!/(^|\.)youtube\.com$/.test(host) && host !== 'youtu.be'
    && !/(^|\.)youtube-nocookie\.com$/.test(host)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const candidate = host === 'youtu.be' ? parts[0]
    : parsed.searchParams.get('v')
      || (['embed', 'shorts', 'live', 'v'].includes(parts[0]) ? parts[1] : null);
  return /^[-_0-9A-Za-z]{11}$/.test(candidate || '') ? candidate : null;
}

module.exports = {
  bodyFor, headersFor, normalizeFormat, playerWithClient, player, search, urlFor, videoIdOf,
};
