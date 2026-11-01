/** Deezer music, using the owner's privately configured ARL. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const deezer = require('../../utils/deezer');
const settings = require('../../utils/mediaSettings');
const selections = require('../../utils/selections');
const youtubeSearch = require('../../utils/youtubeSearch');
const jobQueue = require('../../utils/jobQueue');
const diskSpace = require('../../utils/diskSpace');
const { getTempDir, deleteTempFile, holdTemp } = require('../../utils/tempManager');
const { sniffFile, tagMp3, safeName, fmtMB, probeMedia } = require('../../utils/mediaTransfer');
const getFfmpeg = require('../../utils/ffmpeg');
const telemetry = require('../../utils/telemetry');
const { redactArg, redactSecrets, safeText } = require('../../utils/safeLog');
const log = require('../../utils/logger')('deezer');

const MAX_MB = Number(config.song?.maxMB) || 120;
const MAX_SECONDS = Number(config.song?.maxMinutes ? config.song.maxMinutes * 60 : 3 * 60 * 60);
const RECOVERABLE = new Set(['DEEZER_CONFIG', 'DEEZER_AUTH', 'DEEZER_NETWORK', 'DEEZER_TRACK', 'DEEZER_UNAVAILABLE', 'DEEZER_VERIFY', 'BAD_SOURCE', 'DEEZER_ERROR']);
const ERROR_CODES = new Set([...RECOVERABLE, 'DEEZER_SEND', 'TOO_BIG', 'TOO_LONG', 'NOT_ENOUGH_DISK']);

function messageFor(err, isOwner) {
  switch (err?.code) {
    case 'DEEZER_CONFIG': return isOwner ? 'Deezer is not configured. Set DEEZER_ARL privately in the bot environment.' : 'Deezer is not configured yet.';
    case 'DEEZER_AUTH': return isOwner ? 'Deezer rejected the account. Check DEEZER_ARL privately in the bot environment.' : 'Deezer is temporarily unavailable.';
    case 'DEEZER_TRACK': return 'No Deezer track found. Try a title or a full Deezer track link.';
    case 'DEEZER_UNAVAILABLE': return 'This track is not available from Deezer for the configured account.';
    case 'DEEZER_VERIFY': return isOwner ? 'Could not verify the full Deezer track. Check that ffmpeg is installed and working.' : 'Could not verify the full Deezer track.';
    case 'TOO_BIG': return 'That track is larger than the maximum send size.';
    case 'TOO_LONG': return 'That track exceeds the audio duration limit.';
    case 'NOT_ENOUGH_DISK': return 'Server storage is temporarily full. Please try again shortly.';
    case 'DEEZER_SEND': return 'Could not send the audio. Please try again.';
    default: return 'Deezer is temporarily unavailable. Please try again shortly.';
  }
}

// Preserve useful diagnostics without ever rendering an HTTP request object.
function logUnexpected(err) {
  const safe = err instanceof Error ? redactArg(err) : new Error('Non-error rejection');
  const clean = (value) => {
    let text = redactSecrets(value);
    const arl = String(config.deezer?.arl || '').trim();
    if (arl.length >= 10) text = text.split(arl).join('[REDACTED]');
    // Gateway/license tokens can also appear as unlabeled opaque values in a
    // third-party error. Preserve the surrounding message and stack frames.
    return text.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[REDACTED]');
  };
  log.error('Unexpected Deezer failure:', clean(safeText(safe)));
  if (safe instanceof Error && safe.stack) log.error('Stack:', clean(safe.stack));
}

/**
 * Try Deezer for a title or full track URL. Returns false only when the caller
 * can safely use another source. User-supplied Deezer links stay terminal;
 * selectedFromSearch distinguishes an internally selected search result.
 */
async function attempt(sock, msg, extra, {
  input, sendAs = 'document', firstHit = false, fallback = false, expected = null,
  onSelectionFallback = null, selectedFromSearch = false,
} = {}) {
  const text = String(input || '').trim();
  const explicit = Boolean(deezer.deezerUrl(text));
  const chat = extra?.from || msg.key.remoteJid;
  const reply = (value) => sock.sendMessage(chat, { text: value }, { quoted: msg });
  const react = (emoji) => sock.sendMessage(chat, { react: { text: emoji, key: msg.key } }).catch(() => {});
  if (!explicit && /^https?:\/\//i.test(text)) return false;
  let deliveryStarted = false;
  let deliverySucceeded = false;

  try {
    if (!deezer.configured()) throw Object.assign(new Error('Deezer is not configured'), { code: 'DEEZER_CONFIG' });
    if (!getFfmpeg.works()) throw Object.assign(new Error('Cannot verify audio without ffmpeg'), { code: 'DEEZER_VERIFY' });
    let id = deezer.trackId(text);
    const client = deezer.createClient();
    if (explicit && !id) id = await client.resolveTrackId(text);
    if (!id) {
      const limit = Number(config.search?.maxResults) || 5;
      const found = (await client.search(text, { limit })).filter((track) => deezer.sameRecording(track, expected));
      if (!found.length) throw Object.assign(new Error('No track found'), { code: 'DEEZER_TRACK' });
      const pickerOn = settings.get('searchPicker', config.search?.picker === true) !== false;
      if (found.length > 1 && pickerOn && !firstHit) {
        const rows = found.map((item) => ({ ...item, author: item.artist }));
        const list = youtubeSearch.formatResults(rows, {
          header: `🔎 *${text}*`,
          note: `Reply *${config.prefix}1*–*${config.prefix}${rows.length}* or *${config.prefix}cancel*.`,
        });
        try {
          await selections.sendTextPrompt(sock, msg, extra, {
            text: list, image: null, items: rows, label: 'deezer',
            ttlMs: Math.max(1, Number(config.search?.ttlMinutes) || 5) * 60_000,
            run: async (s, m, e, item) => {
              const canFallback = fallback && typeof onSelectionFallback === 'function';
              const handled = await attempt(s, m, e, {
                input: item.url, sendAs, firstHit: true, fallback: canFallback,
                selectedFromSearch: true, expected,
              });
              if (!handled && canFallback) await onSelectionFallback(s, m, e, item);
            },
          });
        } catch { throw Object.assign(new Error('Selection prompt failed'), { code: 'DEEZER_SEND' }); }
        await react('❓');
        return true;
      }
      id = found[0].id;
    }

    await jobQueue.runInLane('light', async () => {
      const stamp = `deezer_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      const base = path.join(getTempDir(), stamp);
      const raw = `${base}.mp3`;
      const tagged = `${base}_tagged.mp3`;
      const release = holdTemp(stamp);
      let reservation;
      try {
        reservation = diskSpace.reserveSpace(getTempDir(), MAX_MB * 2, { label: 'deezer', tagDir: getTempDir(), tagPrefix: stamp });
        await react('📥');
        const track = await client.download(id, raw, { maxBytes: MAX_MB * 1024 * 1024, maxSeconds: MAX_SECONDS, expected });
        if (!deezer.sameRecording(track, expected, { requireIsrc: true })) throw Object.assign(new Error('Track metadata changed'), { code: 'BAD_SOURCE' });
        const kind = sniffFile(raw);
        if (kind.kind !== 'audio' || kind.ext !== 'mp3') throw Object.assign(new Error('Invalid audio'), { code: 'BAD_SOURCE' });
        const info = await probeMedia(raw);
        const duration = Number(track.duration);
        const minimumDuration = duration - Math.max(3, duration * 0.05);
        if (!info.probed || !info.hasAudio || !Number.isFinite(duration) || duration <= 0 ||
            !Number.isFinite(info.duration) || info.duration <= 0 || info.duration < minimumDuration) {
          throw Object.assign(new Error('Could not verify the complete audio'), { code: 'DEEZER_VERIFY' });
        }
        const title = safeName(track.title, 'song');
        const artist = safeName(track.artist, '');
        const final = await tagMp3(raw, tagged, { title: track.title, artist: track.artist, album: track.album }) || raw;
        const bytes = fs.statSync(final).size;
        if (bytes > MAX_MB * 1024 * 1024) throw Object.assign(new Error('Audio exceeds size limit'), { code: 'TOO_BIG' });
        const fileName = `${artist ? `${artist} - ` : ''}${title}.mp3`;
        const caption = `${artist ? `🎵 *${title}*\n👤 ${artist}` : `🎵 *${title}*`}\n📦 ${fmtMB(bytes)} • via Deezer`;
        try {
          deliveryStarted = true;
          if (sendAs === 'audio') await sock.sendMessage(chat, { audio: { url: final }, mimetype: 'audio/mpeg', ptt: false, fileName }, { quoted: msg });
          else await sock.sendMessage(chat, { document: { url: final }, mimetype: 'audio/mpeg', fileName, caption }, { quoted: msg });
          deliverySucceeded = true;
        } catch { throw Object.assign(new Error('Delivery failed'), { code: 'DEEZER_SEND' }); }
        telemetry.recordDownloadSuccess('audio');
        await react('✅');
      } finally {
        for (const file of [raw, tagged]) deleteTempFile(file);
        reservation?.release();
        release();
      }
    }, () => react('⏳'));
    return true;
  } catch (err) {
    const rawCode = String(err?.code || '');
    const code = rawCode === 'ENOSPC' || rawCode === 'EDQUOT' ? 'NOT_ENOUGH_DISK' : (ERROR_CODES.has(rawCode) ? rawCode : 'DEEZER_ERROR');
    // Expected errors contain no useful request diagnostics. Unexpected errors
    // retain a redacted message and stack, never Axios config/headers/response.
    if (code === 'DEEZER_ERROR') logUnexpected(err);
    else log.warn(code);
    if (deliverySucceeded) return true;
    if (fallback && (!explicit || selectedFromSearch) && !deliveryStarted && RECOVERABLE.has(code)) return false;
    telemetry.recordFailure('deezer');
    await reply(messageFor({ code }, Boolean(extra?.isOwner)));
    await react('❌');
    return true;
  }
}

module.exports = {
  name: 'deezer', aliases: ['dz'], category: 'media',
  description: 'Download a Deezer track as MP3',
  usage: '.deezer <title or track link> [audio|doc]',
  async execute(sock, msg, args, extra) {
    const rest = [...args];
    let sendAs = String(settings.get('songSendAs', config.song?.sendAs || 'document')).toLowerCase();
    const last = String(rest.at(-1) || '').toLowerCase();
    if (['audio', 'mp3'].includes(last)) { sendAs = 'audio'; rest.pop(); }
    else if (['doc', 'document', 'file'].includes(last)) { sendAs = 'document'; rest.pop(); }
    const flag = rest.findIndex((s) => /^--?first$/i.test(s));
    let firstHit = flag !== -1;
    if (flag !== -1) rest.splice(flag, 1);
    let input = rest.join(' ').trim();
    if (input.startsWith('!')) { firstHit = true; input = input.slice(1).trim(); }
    if (!input) return sock.sendMessage(extra?.from || msg.key.remoteJid, { text: `Usage: ${config.prefix}deezer <title or track link> [audio|doc]` }, { quoted: msg });
    // Other URLs are not interpreted as search terms or passed to another host.
    if (/^https?:\/\//i.test(input) && !deezer.deezerUrl(input)) return sock.sendMessage(extra?.from || msg.key.remoteJid, { text: 'Use a Deezer track link or search by title.' }, { quoted: msg });
    return attempt(sock, msg, extra, { input, sendAs, firstHit });
  },
  attempt,
  messageFor,
};
