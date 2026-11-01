/** Deezer music, using the owner's privately configured ARL. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
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
const { jidVariants } = require('../../utils/jid');
const log = require('../../utils/logger')('deezer');

const MAX_MB = Number(config.song?.maxMB) || 120;
const MAX_SECONDS = Number(config.song?.maxMinutes ? config.song.maxMinutes * 60 : 3 * 60 * 60);
const RECOVERABLE = new Set(['DEEZER_CONFIG', 'DEEZER_AUTH', 'DEEZER_NETWORK', 'DEEZER_TRACK', 'DEEZER_UNAVAILABLE', 'DEEZER_DECODER', 'DEEZER_VERIFY', 'BAD_SOURCE', 'DEEZER_ERROR']);
const ERROR_CODES = new Set([...RECOVERABLE, 'DEEZER_SEND', 'DEEZER_STORAGE', 'TOO_BIG', 'TOO_LONG', 'NOT_ENOUGH_DISK']);

function diagnosticText(value) {
  const { stage, status, reason } = deezer.diagnosticDetails(value);
  return [stage, status ? `HTTP ${status}` : '', reason].filter(Boolean).join(', ');
}

function messageFor(err, isOwner) {
  let message;
  switch (err?.code) {
    case 'DEEZER_CONFIG': message = isOwner ? 'Deezer is not configured. Set DEEZER_ARL privately in the bot environment.' : 'Deezer is not configured yet.'; break;
    case 'DEEZER_AUTH': message = isOwner ? 'Deezer rejected the request. Check the private ARL and host access.' : 'Deezer is temporarily unavailable.'; break;
    case 'DEEZER_NETWORK': message = isOwner ? 'Deezer request failed. Check the hosting connection and access.' : 'Deezer is temporarily unavailable. Please try again shortly.'; break;
    case 'DEEZER_TRACK': message = 'No Deezer track found. Try a title or a full Deezer track link.'; break;
    case 'DEEZER_UNAVAILABLE': message = 'This track is not available from Deezer for the configured account.'; break;
    case 'DEEZER_DECODER': message = isOwner ? 'Deezer audio decoding is unavailable. Install the bot dependencies and restart.' : 'Deezer is temporarily unavailable.'; break;
    case 'DEEZER_STORAGE': message = isOwner ? 'Deezer could not write its audio file. Check host storage and permissions.' : 'Server storage is temporarily unavailable.'; break;
    case 'DEEZER_VERIFY': message = isOwner ? 'Could not verify the full Deezer track. Check that ffmpeg is installed and working.' : 'Could not verify the full Deezer track.'; break;
    case 'TOO_BIG': message = 'That track is larger than the maximum send size.'; break;
    case 'TOO_LONG': message = 'That track exceeds the audio duration limit.'; break;
    case 'NOT_ENOUGH_DISK': message = 'Server storage is temporarily full. Please try again shortly.'; break;
    case 'DEEZER_SEND': message = 'Could not send the audio. Please try again.'; break;
    default: message = 'Deezer is temporarily unavailable. Please try again shortly.';
  }
  const details = isOwner ? diagnosticText(err) : '';
  return details ? `${message}\nStep: ${details}.` : message;
}

// Preserve useful diagnostics without ever rendering an HTTP request object.
function logUnexpected(err) {
  const safe = err instanceof Error ? redactArg(err) : new Error('Non-error rejection');
  const clean = (value) => {
    let text = redactSecrets(value);
    const arl = String(config.deezer?.arl || '').trim();
    if (arl.length >= 10) text = text.split(arl).join('[REDACTED]');
    // Unexpected third-party errors may contain signed media URLs or unlabeled
    // tokens. Keep surrounding messages/stack frames, but never log URLs.
    text = text.replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[URL REDACTED]');
    text = text.replace(/(\b(?:signature|sig|hmac|policy|key-pair-id)\b["']?\s*[:=]\s*)[^\s,;&"'}]+/gi, '$1[REDACTED]');
    return text.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[REDACTED]');
  };
  log.error('Unexpected Deezer failure:', clean(safeText(safe)));
  if (safe instanceof Error && safe.stack) log.error('Stack:', clean(safe.stack));
}

function isPrivateOwnerChat(sock, extra, chat) {
  if (!extra?.isOwner || !/@(s\.whatsapp\.net|c\.us|lid|hosted|hosted\.lid)$/i.test(String(chat))) return false;
  const senderIds = jidVariants(extra?.senderIds || extra?.sender, sock.__sessionDir);
  return [...jidVariants(chat, sock.__sessionDir)].some((id) => senderIds.has(id));
}

function statusLine(result) {
  if (result?.ok === true) return 'ok';
  if (result?.skipped === true) return 'skipped';
  if (result?.ok !== false) return 'not checked';
  const code = deezer.diagnosticCode(result.code);
  const details = diagnosticText(result);
  return `failed (${code}${details ? `, ${details}` : ''})`;
}

async function showStatus(sock, msg, extra, id) {
  const chat = extra?.from || msg.key.remoteJid;
  let ffmpeg = false;
  try { ffmpeg = getFfmpeg.works(); } catch { /* show unavailable */ }
  const decoderCheck = async () => {
    let decoder;
    try {
      decoder = await deezer.stripeDecoder(id, 2048);
      // Exercise a synthetic stripe locally; merely importing the package does
      // not prove the Blowfish constructor/transform works on this host.
      await pipeline(Readable.from([Buffer.alloc(2048)]), decoder,
        new Writable({ write(_chunk, _encoding, done) { done(); } }), { signal: AbortSignal.timeout(5000) });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: 'DEEZER_DECODER', ...deezer.diagnosticDetails({ stage: 'decoder', reason: err?.code }) };
    } finally { decoder?.destroy?.(); }
  };
  let decoder, report;
  try {
    [decoder, report] = await Promise.all([decoderCheck(), deezer.createClient().diagnose(id)]);
  } catch (err) {
    logUnexpected(err);
    return sock.sendMessage(chat, { text: 'Deezer diagnostics could not be completed.' }, { quoted: msg });
  }
  const lines = [
    '*Deezer diagnostics*',
    `FFmpeg: ${ffmpeg ? 'ok' : 'missing'}`,
    `Decoder: ${statusLine(decoder)}`,
    `ARL: ${deezer.configured() ? 'configured' : 'not configured'}`,
    `Search: ${statusLine(report?.search)}`,
    ...(report?.gatewaySearch ? [`Gateway search: ${statusLine(report.gatewaySearch)}`] : []),
    `Track metadata: ${statusLine(report?.metadata)}`,
    ...(report?.gatewayMetadata ? [`Gateway metadata: ${statusLine(report.gatewayMetadata)}`] : []),
    `Account: ${statusLine(report?.account)}`,
    `Track token: ${statusLine(report?.trackToken)}`,
    `Media URL: ${statusLine(report?.media)}`,
    'Audio download and playback not tested.',
  ];
  return sock.sendMessage(chat, { text: lines.join('\n') }, { quoted: msg });
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
    const full = rawCode === 'ENOSPC' || rawCode === 'EDQUOT';
    const localStorage = deezer.isStorageCode(rawCode);
    const code = full ? 'NOT_ENOUGH_DISK' : (localStorage ? 'DEEZER_STORAGE' : (ERROR_CODES.has(rawCode) ? rawCode : 'DEEZER_ERROR'));
    const details = deezer.diagnosticDetails(localStorage ? { stage: 'storage', reason: rawCode } : err);
    // Only fixed step/status/reason labels are logged; never request data.
    // Unexpected errors retain a redacted message and stack instead.
    if (code === 'DEEZER_ERROR') logUnexpected(err);
    else {
      const description = diagnosticText(details);
      log.warn(description ? `${code} (${description})` : code);
    }
    if (deliverySucceeded) return true;
    if (fallback && (!explicit || selectedFromSearch) && !deliveryStarted && RECOVERABLE.has(code)) return false;
    telemetry.recordFailure('deezer');
    await reply(messageFor({ code, ...details }, Boolean(extra?.isOwner)));
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
    if (String(rest[0] || '').toLowerCase() === '--status') {
      const chat = extra?.from || msg.key.remoteJid;
      // fromMe commands can be sent to somebody else's DM as well as to self.
      // Only report account/host state in the owner's own private chat.
      if (!isPrivateOwnerChat(sock, extra, chat)) {
        return sock.sendMessage(chat, { text: 'Run Deezer diagnostics in your private owner chat.' }, { quoted: msg });
      }
      const target = rest.slice(1).join(' ').trim();
      const id = !target ? '3135553' : (/^\d{1,16}$/.test(target) ? target : deezer.trackId(target));
      if (!id) return sock.sendMessage(chat, { text: `Usage: ${config.prefix}deezer --status [track ID or full Deezer track link]` }, { quoted: msg });
      return showStatus(sock, msg, extra, id);
    }
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
