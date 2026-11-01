/** Deliver a verified public audio/video file without generic source fallbacks. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const queue = require('./jobQueue');
const disk = require('./diskSpace');
const telemetry = require('./telemetry');
const ffmpeg = require('./ffmpeg');
const { getTempDir, deleteTempFile, holdTemp } = require('./tempManager');
const { sniffFile, probeMedia, audioToMp3, tagMp3, ensureWhatsAppMp4, safeName, fmtMB } = require('./mediaTransfer');

const fail = (code, message) => Object.assign(new Error(message), { code });
const MAX_AUDIO_MB = Math.max(1, Number(config.song?.maxMB) || 120);
const MAX_VIDEO_MB = Math.max(1, Number(config.video?.maxMB) || 2000);
const AUDIO_SECONDS = (Number(config.song?.maxMinutes) || 180) * 60;
const VIDEO_SECONDS = Math.max(0, Number(config.video?.maxMinutes) || 0) * 60;
const DOWNLOAD_TIMEOUT = Math.max(60000, Math.min(30 * 60 * 1000, Number(config.ytdlp?.deadlineMs) || 10 * 60 * 1000));
const AS_DOCUMENT_ABOVE = 50 * 1024 * 1024;
const KNOWN = new Set(['MEDIA_NETWORK', 'MEDIA_RATE_LIMIT', 'MEDIA_UNAVAILABLE', 'UNSAFE_SOURCE', 'BAD_SOURCE', 'MEDIA_VERIFY', 'MEDIA_CREDIT', 'MEDIA_SEND',
  'TOO_BIG', 'TOO_LONG', 'NOT_ENOUGH_DISK', 'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EEXIST']);

function errorMessage(code, label, owner) {
  switch (code) {
    case 'MEDIA_UNAVAILABLE': return `${label} download is no longer available or permitted.`;
    case 'MEDIA_RATE_LIMIT': return `${label} is rate-limiting downloads. Please try again later.`;
    case 'TOO_BIG': return 'That file exceeds the download size limit.';
    case 'TOO_LONG': return 'That file exceeds the duration limit.';
    case 'NOT_ENOUGH_DISK': case 'ENOSPC': case 'EDQUOT': return 'Server storage is temporarily full.';
    case 'EACCES': case 'EPERM': case 'EROFS': case 'EEXIST': return 'Server storage is temporarily unavailable.';
    case 'MEDIA_VERIFY': case 'BAD_SOURCE': return owner
      ? 'Could not verify playable media. Check FFmpeg and the source file.' : 'Could not verify a playable file from this source.';
    case 'MEDIA_CREDIT': return 'The required source credits are too long to include with this file.';
    case 'MEDIA_SEND': return 'Could not send the file. Please try again.';
    default: return `${label} is temporarily unavailable. Please try again later.`;
  }
}

function verified(info, metadata, kind, maxSeconds) {
  const expected = Number(metadata?.duration);
  const actual = Number(info?.duration);
  if (!info?.probed || !info.hasAudio || (kind === 'video' && !info.hasVideo) ||
      !Number.isFinite(expected) || expected <= 0 || !Number.isFinite(actual) || actual <= 0) return false;
  if (actual < expected - Math.max(3, expected * 0.05)) return false;
  return !maxSeconds || actual <= maxSeconds + 3;
}

async function sendPublicMedia(sock, msg, extra, {
  kind = 'audio', label = 'Source', download, attribution, sendAs = 'document',
} = {}) {
  if (!['audio', 'video'].includes(kind) || typeof download !== 'function') throw new TypeError('Invalid public media delivery');
  const chat = extra?.from || msg.key.remoteJid;
  const reply = (text) => sock.sendMessage(chat, { text }, { quoted: msg });
  const react = (emoji) => sock.sendMessage(chat, { react: { text: emoji, key: msg.key } }).catch(() => {});
  const maxMB = kind === 'audio' ? MAX_AUDIO_MB : MAX_VIDEO_MB;
  const maxSeconds = kind === 'audio' ? AUDIO_SECONDS : VIDEO_SECONDS;
  let delivered = false;
  let stage = 'queue';

  try {
    await queue.runInLane(kind === 'audio' ? 'light' : 'heavy', async () => {
      const stamp = `public_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      const base = path.join(getTempDir(), stamp);
      const raw = `${base}.bin`;
      const mp3 = `${base}_audio.mp3`;
      const tagged = `${base}_tagged.mp3`;
      const video = `${base}_video.mp4`;
      const release = holdTemp(stamp);
      let reservation;
      try {
        stage = 'ffmpeg';
        if (!ffmpeg.works()) throw fail('MEDIA_VERIFY', 'FFmpeg unavailable');
        stage = 'storage';
        reservation = disk.reserveMediaSpace(getTempDir(), config.media || {}, {
          label: `public:${kind}`, tagDir: getTempDir(), tagPrefix: stamp,
        });
        await react('📥');
        stage = 'download';
        const item = await download(raw, { maxBytes: Math.floor(maxMB * 1024 * 1024), maxSeconds, timeoutMs: DOWNLOAD_TIMEOUT });
        stage = 'storage';
        if (!fs.existsSync(raw) || fs.statSync(raw).size < 10240) throw fail('BAD_SOURCE', 'Missing media');
        disk.requireMediaCopySpace(getTempDir(), fs.statSync(raw).size / 1048576, config.media || {});
        stage = 'verify';
        const info = await probeMedia(raw);
        if (!verified(info, item, kind, maxSeconds)) throw fail('MEDIA_VERIFY', 'Incomplete media');
        const credit = typeof attribution === 'function' ? String(attribution(item) || '') : '';
        const title = safeName(item.title, kind);
        const artist = safeName(item.artist, '');
        let file, mime, caption;

        stage = 'convert';
        if (kind === 'audio') {
          const sniffed = sniffFile(raw);
          if (sniffed.ext === 'mp3' && info.audioCodec === 'mp3') file = raw;
          else {
            file = await audioToMp3(raw, mp3);
            if (!file) throw fail('MEDIA_VERIFY', 'Audio conversion failed');
          }
          file = await tagMp3(file, tagged, { title: item.title, artist: item.artist }) || file;
          if (fs.statSync(file).size > maxMB * 1024 * 1024) throw fail('TOO_BIG', 'Audio exceeds limit');
          mime = 'audio/mpeg';
          const name = `${artist ? `${artist} - ` : ''}${title}.mp3`;
          caption = `🎵 *${title}*${item.artist ? `\n👤 ${item.artist}` : ''}\n📦 ${fmtMB(fs.statSync(file).size)} • via ${label}${credit ? `\n\n${credit}` : ''}`;
          if (credit && ((sendAs === 'audio' && credit.length > 4000) || (sendAs !== 'audio' && caption.length > 1024))) {
            throw fail('MEDIA_CREDIT', 'Required credit is too long to include');
          }
          stage = 'delivery';
          try {
            if (sendAs === 'audio') {
              if (credit) await reply(credit);
              await sock.sendMessage(chat, { audio: { url: file }, mimetype: mime, ptt: false, fileName: name }, { quoted: msg });
            } else {
              await sock.sendMessage(chat, { document: { url: file }, mimetype: mime, fileName: name, caption }, { quoted: msg });
            }
            delivered = true;
          } catch { throw fail('MEDIA_SEND', 'Media delivery failed'); }
        } else {
          file = await ensureWhatsAppMp4(raw, video);
          const converted = await probeMedia(file);
          if (!verified(converted, item, kind, maxSeconds) || !/mp4|mov/.test(converted.container) ||
              converted.videoCodec !== 'h264' || !['aac', 'mp3'].includes(converted.audioCodec)) {
            throw fail('MEDIA_VERIFY', 'Video conversion failed');
          }
          const size = fs.statSync(file).size;
          if (size > maxMB * 1024 * 1024) throw fail('TOO_BIG', 'Video exceeds limit');
          caption = `🎬 *${item.title}*${item.artist ? `\n👤 ${item.artist}` : ''}\n📦 ${fmtMB(size)} • via ${label}${credit ? `\n\n${credit}` : ''}`;
          if (credit && caption.length > 1024) throw fail('MEDIA_CREDIT', 'Required credit is too long to include');
          stage = 'delivery';
          try {
            const body = size > AS_DOCUMENT_ABOVE
              ? { document: { url: file }, mimetype: 'video/mp4', fileName: `${title}.mp4`, caption }
              : { video: { url: file }, mimetype: 'video/mp4', caption };
            await sock.sendMessage(chat, body, { quoted: msg });
            delivered = true;
          } catch { throw fail('MEDIA_SEND', 'Media delivery failed'); }
        }
        telemetry.recordDownloadSuccess(kind);
        await react('✅');
      } finally {
        for (const file of [raw, mp3, tagged, video]) deleteTempFile(file);
        reservation?.release?.();
        release();
      }
    }, () => react('⏳'));
    return { sent: true, kind };
  } catch (err) {
    if (delivered) return { sent: true, kind };
    const code = KNOWN.has(err?.code) ? err.code : 'MEDIA_NETWORK';
    // Never log raw provider errors or signed URLs.
    const status = Number.isInteger(err?.status) && err.status >= 100 && err.status <= 599 ? `, HTTP ${err.status}` : '';
    console.warn(`[public-media] ${code} (${stage}${status})`);
    telemetry.recordFailure('public-media');
    await reply(errorMessage(code, label, Boolean(extra?.isOwner)));
    await react('❌');
    return { sent: false, kind, code };
  }
}

module.exports = { sendPublicMedia, verified, errorMessage };
