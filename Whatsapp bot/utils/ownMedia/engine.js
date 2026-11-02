'use strict';

/**
 * Brick 6 — the engine itself.
 *
 *   resolve (YouTube player / SoundCloud API)
 *     → choose a stream (formats)
 *     → download (plain HTTPS, streamed to disk)
 *     → convert (ffmpeg from the locked @ffmpeg-installer package)
 *     → tag / remux
 *     → send (Baileys)
 *
 * No yt-dlp binary, no youtubei.js, no Hector, no yt1d, no cobalt, no remote
 * resolver services. Every brick records why it failed so the error message
 * (and `.mdiag`) says something useful instead of "could not download".
 */

const fs = require('fs');
const path = require('path');
const C = require('./constants');
const http = require('./http');
const clients = require('./clients');
const formats = require('./formats');
const soundcloud = require('./soundcloud');
const convert = require('./convert');
const mediaTransfer = require('../mediaTransfer');
const { getTempDir, deleteTempFiles } = require('../tempManager');
const config = require('../../config');
const jobQueue = require('../jobQueue');
const { EngineError } = http;

let telemetry = null;
try { telemetry = require('../telemetry'); } catch { /* optional */ }

const MB = 1024 * 1024;
const clean = (value) => String(value ?? '').trim();
const short = (text, n = 70) => {
  const s = clean(text).replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const isYouTubeUrl = (url) => Boolean(clients.videoIdOf(url));
const isSoundCloudUrl = (url) => /^https?:\/\/(?:www\.|m\.|on\.|w\.)?soundcloud\.com\//i.test(String(url || ''));

/**
 * The gate used by utils/mediaPipeline.js. Only media this engine can actually
 * fetch is claimed; TikTok/Instagram/direct-image links keep the legacy path.
 */
const shouldHandle = (url, kind, track = null) => kind !== 'image'
  && (isYouTubeUrl(url) || isSoundCloudUrl(url)
    // No upload URL but we know the track: let the engine search for one.
    || (!clean(url) && Boolean(track?.title)));

/** w.soundcloud.com/player/?url=… carries the real track URL in a parameter. */
function canonicalSoundCloud(url) {
  try {
    const u = new URL(String(url));
    if (/^w\.soundcloud\.com$/i.test(u.hostname)) {
      const target = u.searchParams.get('url');
      return target && /^https?:\/\//i.test(target) ? target : url;
    }
  } catch { /* keep original */ }
  return url;
}

function trackQuery(track) {
  return [
    (track?.artists || []).filter(Boolean).join(', '),
    clean(track?.title),
  ].filter(Boolean).join(' - ').trim();
}

function guessExt(mime) {
  if (/mpeg|mp3/i.test(mime)) return 'mp3';
  if (/mp4|m4a|isom/i.test(mime)) return 'm4a';
  if (/webm|opus/i.test(mime)) return 'webm';
  if (/ogg/i.test(mime)) return 'ogg';
  return 'bin';
}

function record(attempts, brick, err) {
  attempts.push({
    brick,
    code: err?.code || 'FAILED',
    reason: short(err?.message),
  });
}

/**
 * Find a downloadable stream for this media. Tries, in order:
 *   1. the SoundCloud link itself (independent of YouTube),
 *   2. the YouTube link through every public Innertube client,
 *   3. SoundCloud search by title/artist (duration matched),
 *   4. YouTube search through the public endpoint, then its player.
 */
async function buildPlan({ url = '', track = {}, kind = 'audio', height = 720, attempts = [] }) {
  const meta = track || {};
  const q = trackQuery(meta) || clean(meta.title);

  // 1 ── SoundCloud link ────────────────────────────────────────────────────
  if (isSoundCloudUrl(url)) {
    try {
      const resolved = await soundcloud.resolve(canonicalSoundCloud(url));
      const stream = await soundcloud.streamUrl(resolved);
      return {
        source: 'soundcloud',
        mode: stream.protocol === 'hls' ? 'manifest' : 'direct',
        url: stream.url,
        mime: stream.mime,
        needsAudioExtract: false,
        label: `SoundCloud ${stream.protocol}`,
        title: clean(resolved.title) || clean(meta.title),
        author: clean(resolved.user?.username) || clean((meta.artists || []).join(', ')),
        durationMs: Number(resolved.duration) || meta.durationMs || 0,
        cover: clean(resolved.artwork_url || resolved.user?.avatar_url).replace(/-large\./, '-t500x500.'),
      };
    } catch (err) { record(attempts, 'SoundCloud link', err); }
  }

  // 2 ── YouTube link ───────────────────────────────────────────────────────
  const videoId = isYouTubeUrl(url) ? clients.videoIdOf(url) : null;
  if (videoId) {
    try {
      const { result, attempts: clientAttempts } = await clients.player(videoId);
      for (const a of clientAttempts) {
        if (!a.ok) attempts.push({ brick: `YouTube ${a.client}`, code: a.status, reason: short(a.reason) });
      }
      const choice = formats.choose(result, kind, height);
      if (!choice) throw new EngineError('NO_FORMATS', 'Player returned no directly downloadable format');
      return {
        source: 'youtube',
        mode: /^ffmpeg-(hls|dash)$/.test(choice.mode) ? 'manifest' : choice.mode,
        url: choice.url,
        audioUrl: choice.audioUrl || '',
        mime: choice.mime,
        needsAudioExtract: Boolean(choice.needsAudioExtract),
        needsMux: Boolean(choice.needsMux),
        label: `${result.client}: ${choice.label}`,
        title: result.title || clean(meta.title),
        author: result.author || clean((meta.artists || []).join(', ')),
        durationMs: result.duration * 1000 || meta.durationMs || 0,
        cover: clean(meta.cover),
      };
    } catch (err) { record(attempts, 'YouTube player', err); }
  }

  // 3 ── SoundCloud search (works even when YouTube is blocked) ─────────────
  if (q) {
    try {
      const rows = await soundcloud.search(q, { limit: 8 });
      const picked = soundcloud.pickByDuration(rows, meta.durationMs || 0, 20);
      if (picked) {
        const stream = await soundcloud.streamUrl(picked.track);
        return {
          source: 'soundcloud-search',
          mode: stream.protocol === 'hls' ? 'manifest' : 'direct',
          url: stream.url,
          mime: stream.mime,
          needsAudioExtract: false,
          label: `SoundCloud search: ${picked.title}`,
          title: picked.title,
          author: picked.author,
          durationMs: picked.durationMs,
          cover: picked.cover,
        };
      }
      attempts.push({ brick: 'SoundCloud search', code: 'NO_MATCH', reason: 'No public track' });
    } catch (err) { record(attempts, 'SoundCloud search', err); }
  }

  // 4 ── YouTube search through the public endpoint ────────────────────────
  if (q) {
    try {
      const rows = await clients.search(q, { limit: 8 });
      const target = (meta.durationMs || 0) / 1000;
      const ranked = [...rows].sort((a, b) => (target
        ? Math.abs((a.duration || 0) - target) - Math.abs((b.duration || 0) - target)
        : 0));
      for (const row of ranked.slice(0, 3)) {
        try {
          const { result } = await clients.player(row.id);
          const choice = formats.choose(result, kind, height);
          if (!choice) continue;
          return {
            source: 'youtube-search',
            mode: /^ffmpeg-(hls|dash)$/.test(choice.mode) ? 'manifest' : choice.mode,
            url: choice.url,
            audioUrl: choice.audioUrl || '',
            mime: choice.mime,
            needsAudioExtract: Boolean(choice.needsAudioExtract),
            needsMux: Boolean(choice.needsMux),
            label: `${result.client}: ${choice.label}`,
            title: row.title || result.title || q,
            author: row.author || result.author || '',
            durationMs: row.duration * 1000 || result.duration * 1000 || 0,
            cover: row.thumbnail || '',
          };
        } catch { /* try the next search hit */ }
      }
      attempts.push({ brick: 'YouTube search', code: 'NO_FORMATS', reason: 'No playable hit' });
    } catch (err) { record(attempts, 'YouTube search', err); }
  }

  const summary = attempts.map((a) => `${a.brick}: ${a.code}`).join('; ');
  throw new EngineError('NO_SOURCE', `No usable media source — ${summary || 'nothing to try'}`, summary);
}

/** Download + convert. Returns {file, ext, mime}. */
async function prepare(plan, { kind, files, base: givenBase = '' }) {
  const base = givenBase || path.join(getTempDir(), `own_${stamp()}`);
  const maxBytes = (kind === 'audio' ? C.MAX_AUDIO_MB : C.MAX_VIDEO_MB) * MB;

  // ffmpeg reads HLS/DASH manifests directly; downloading the playlist text
  // would give us a useless few KB file.
  if (plan.mode === 'manifest') {
    const out = `${base}.${kind === 'audio' ? 'mp3' : 'mp4'}`;
    const file = await convert.fromManifest(plan.url, out, kind);
    files.push(file);
    return { file, ext: path.extname(file).slice(1), mime: kind === 'audio' ? 'audio/mpeg' : 'video/mp4' };
  }

  if (plan.mode === 'ffmpeg-mux') {
    const videoFile = `${base}_v.bin`;
    const audioFile = `${base}_a.bin`;
    await http.streamTo(plan.url, videoFile, { maxBytes }); files.push(videoFile);
    await http.streamTo(plan.audioUrl, audioFile, { maxBytes }); files.push(audioFile);
    const out = `${base}.mp4`;
    const file = await convert.mux(videoFile, audioFile, out);
    files.push(file);
    return { file, ext: 'mp4', mime: 'video/mp4' };
  }

  const rawExt = guessExt(plan.mime);
  const raw = `${base}_raw.${rawExt}`;
  await http.streamTo(plan.url, raw, { maxBytes });
  files.push(raw);

  if (kind === 'audio') {
    if (rawExt !== 'mp3' || plan.needsAudioExtract) {
      try {
        const out = `${base}.mp3`;
        const file = await convert.toMp3(raw, out);
        files.push(file);
        return { file, ext: 'mp3', mime: 'audio/mpeg' };
      } catch (err) {
        if (err.code !== 'FFMPEG_MISSING') throw err;
      }
    }
    const sniffed = mediaTransfer.sniffFile(raw);
    return { file: raw, ext: sniffed.ext || rawExt, mime: sniffed.mime || plan.mime || 'audio/mpeg' };
  }

  const sniffed = mediaTransfer.sniffFile(raw);
  return { file: raw, ext: sniffed.ext === 'mp4' ? 'mp4' : rawExt, mime: sniffed.mime || 'video/mp4' };
}

/** @returns {Promise<{sent:boolean,source:string,via:string}>} */
async function deliverMedia(sock, msg, extra, opts = {}) {
  const {
    url = '', track = {}, kind = 'audio', height = 720,
    title = '', author = '', album = '', lyrics = '', cover = null,
    sendAs = '', lane = '',
  } = opts;
  const chatId = extra?.from || msg.key.remoteJid;
  const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});
  const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg }).catch(() => {});
  const files = [];
  const attempts = [];
  // Song commands often know only "Title - Artist". Give the fallback search
  // bricks something to look for even when no catalog track object exists.
  const resolvedTrack = track?.title ? track : {
    title: clean(title), artists: author ? [clean(author)] : [], durationMs: 0,
  };

  const run = async () => {
    let plan;
    try {
      plan = await buildPlan({ url, track: resolvedTrack, kind, height, attempts });
    } catch (err) {
      const lines = attempts.slice(-6).map((a) => `• ${a.brick}: ${a.code}${a.reason ? ` — ${a.reason}` : ''}`);
      await react('❌');
      await say([
        `❌ Could not download *${clean(title) || clean(resolvedTrack.title) || 'this media'}*.`,
        '',
        lines.length ? `*Sources tried:*\n${lines.join('\n')}` : '*No source responded.*',
        '',
        `Run *${config.prefix || '.'}mdiag* to test each source on this host.`,
      ].join('\n'));
      try { telemetry?.recordFailure?.('media'); } catch { /* ignore */ }
      return { sent: false, code: err.code || 'NO_SOURCE' };
    }

    await react('📥');
    let prepared;
    try {
      prepared = await prepare(plan, { kind, files });
    } catch (err) {
      await react('❌');
      await say(`❌ ${plan.source} gave a stream but it could not be saved: *${err.code}* — ${short(err.message, 110)}`);
      try { telemetry?.recordFailure?.('media'); } catch { /* ignore */ }
      return { sent: false, code: err.code || 'DOWNLOAD_FAILED' };
    }

    const shownTitle = clean(title) || clean(plan.title) || clean(resolvedTrack.title) || 'media';
    const shownAuthor = clean(author) || clean(plan.author) || (resolvedTrack.artists || []).join(', ');
    const base = path.join(getTempDir(), `own_send_${stamp()}`);

    try {
      if (kind === 'audio') {
        let finalFile = prepared.file;
        if (prepared.ext === 'mp3') {
          const tagged = await mediaTransfer.tagMp3(finalFile, `${base}_tagged.mp3`, {
            title: mediaTransfer.safeName(shownTitle, ''),
            artist: shownAuthor,
            album: clean(album),
            lyrics: clean(lyrics),
            cover: Buffer.isBuffer(cover) ? cover : null,
          });
          if (tagged) { files.push(tagged); finalFile = tagged; }
        }
        const size = fs.statSync(finalFile).size;
        if (size > C.MAX_AUDIO_MB * MB) throw new EngineError('TOO_BIG', 'Audio exceeds the size limit');
        const name = mediaTransfer.safeName(shownTitle, 'audio');
        const fileName = `${name}.${prepared.ext}`;
        const caption = `🎵 *${name}*${shownAuthor ? `\n👤 ${shownAuthor}` : ''}\n📦 ${mediaTransfer.fmtMB(size)} • ${plan.source}`;
        if (String(sendAs || config.song?.sendAs || 'document').toLowerCase() === 'audio') {
          await sock.sendMessage(chatId, { audio: { url: finalFile }, mimetype: prepared.mime, ptt: false, fileName }, { quoted: msg });
        } else {
          await sock.sendMessage(chatId, { document: { url: finalFile }, mimetype: prepared.mime, fileName, caption }, { quoted: msg });
        }
      } else {
        const ready = await convert.ensurePlayable(prepared.file, `${base}_wa.mp4`);
        if (ready !== prepared.file) files.push(ready);
        const probe = await mediaTransfer.probeMedia(ready);
        if (probe.probed && !probe.hasAudio) throw new EngineError('NO_AUDIO', 'The video has no audio track');
        const size = fs.statSync(ready).size;
        if (size > C.MAX_VIDEO_MB * MB) throw new EngineError('TOO_BIG', 'Video exceeds the size limit');
        const name = mediaTransfer.safeName(shownTitle, 'video');
        const caption = `🎬 *${shownTitle}*${shownAuthor ? `\n👤 ${shownAuthor}` : ''}\n📦 ${mediaTransfer.fmtMB(size)} • ${height}p • ${plan.source}`;
        if (size > 64 * MB) {
          await sock.sendMessage(chatId, { document: { url: ready }, mimetype: 'video/mp4', fileName: `${name}.mp4`, caption }, { quoted: msg });
        } else {
          await sock.sendMessage(chatId, { video: { url: ready }, mimetype: 'video/mp4', caption }, { quoted: msg });
        }
      }
      await react('✅');
      try { telemetry?.recordDownloadSuccess?.(kind); } catch { /* ignore */ }
      return { sent: true, source: plan.source, via: plan.label, code: 'OK' };
    } catch (err) {
      await react('❌');
      await say(`❌ Could not send the file: *${err.code || 'FAILED'}* — ${short(err.message, 110)}`);
      try { telemetry?.recordFailure?.('media'); } catch { /* ignore */ }
      return { sent: false, code: err.code || 'SEND_FAILED' };
    }
  };

  try {
    return lane
      ? await jobQueue.runInLane(lane, run)
      : await run();
  } finally {
    try { deleteTempFiles(files); } catch { /* ignore */ }
  }
}

module.exports = {
  deliverMedia, buildPlan, prepare, shouldHandle,
  isYouTubeUrl, isSoundCloudUrl, canonicalSoundCloud, trackQuery, guessExt,
};
