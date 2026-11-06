/**
 * ZaFar Bot — site shortcuts: .tiktok / .x / .instagram / .fb / .reddit
 *
 * Link shortcuts share the media pipeline; Facebook and Instagram use the
 * dedicated XJX-style social resolvers in `utils/socialMedia.js`:
 *
 *   .tiktok <link> [quality]      .tt
 *   .x <link> [quality]           .twitter .xtwitter
 *   .instagram <link>             .ig .insta .igdl .reels
 *   .fb <link> [quality]          .fbdl .facebookdl .facebook
 *   .reddit <title> [--first]     search Reddit videos
 */

const config = require('../../config');
const YT = require('../../lib/youtube/youtubedl');
const { downloadAndSend, parseOptions } = require('../../lib/downloads/pipeline');
const socialMedia = require('./socialMedia.js');

const QUALITIES = [144, 240, 360, 480, 720, 1080];

// Keep legacy trailing link options, but apply explicit flags wherever they
// appear. A malformed explicit quality must never start a default download.
function linkOptions(args, defaultKind, defaultHeight) {
  const rest = [];
  let explicitKind;
  let explicitHeight;
  let invalidQuality = false;
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] || '');
    if (/^--?first$/i.test(token)) continue;
    if (/^--(?:audio|video|image)$/i.test(token)) { explicitKind = token.slice(2).toLowerCase(); continue; }
    const qualityFlag = /^--quality(?:=(.*))?$/i.exec(token);
    if (qualityFlag) {
      const value = qualityFlag[1] === undefined ? String(args[++i] || '') : qualityFlag[1];
      const quality = Number(value.toLowerCase().replace(/p$/, ''));
      if (QUALITIES.includes(quality)) explicitHeight = quality;
      else invalidQuality = true;
      continue;
    }
    rest.push(token);
  }
  const parsed = parseOptions(rest, { kind: defaultKind, height: defaultHeight });
  return { ...parsed, kind: explicitKind || parsed.kind, height: explicitHeight || parsed.height, invalidQuality };
}

// A URL is not a title. Also catch common scheme-less links with a path.
function quotedTextOf(msg) {
  const ctx = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo;
  const q = ctx?.quotedMessage;
  if (!q) return '';
  return (
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    ''
  );
}

const makeCommand = ({ name, aliases, description, usage, domains, hostLabel, label, defaultKind = 'video', defaultHeight = 0, stripCaption = false, socialPlatform = '' }) => ({
  name,
  aliases,
  category: 'media',
  description,
  usage,

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
    const P = config.prefix || '.';
    const input = Array.isArray(args) ? args : [];
    const link = linkOptions(input, defaultKind, defaultHeight);
    const quotedUrl = YT.extractUrl(quotedTextOf(msg));
    const url = YT.extractUrl(link.rest.join(' ').trim()) || quotedUrl;
    const qualityError = 'Quality must be 144, 240, 360, 480, 720 or 1080.';
    if (link.invalidQuality) return say(qualityError);

    const send = (socket, message, context, selectedUrl, kind, height, known) => {
      const imageUrl = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(selectedUrl);
      const lane = kind === 'audio' || kind === 'image' || imageUrl ? 'light' : 'heavy';
      return downloadAndSend(socket, message, context, {
        url: selectedUrl, kind, height, lane, stripCaption,
        attempts: [{ engine: `${label} chain`, code: known ? 'OK' : 'HOST_MISMATCH' }],
      });
    };

    if (url) {
      // Direct-link shortcuts have historically accepted other sites as well;
      // this host check is diagnostic, not a new restriction on old behavior.
      let host = '';
      try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* pipeline reports invalid URLs */ }
      const known = domains.some((d) => {
        const domain = d.toLowerCase();
        return domain.endsWith('.')
          ? host.startsWith(domain) || host.includes(`.${domain}`)
          : host === domain || host.endsWith(`.${domain}`);
      });
      if (socialPlatform) {
        if (!known) return say(socialMedia.friendlyError({ code: 'BAD_LINK' }, socialPlatform));
        try {
          return await socialMedia.downloadAndSend(sock, msg, extra, {
            platform: socialPlatform, url, quality: link.height,
          });
        } catch (error) {
          return say(socialMedia.friendlyError(error, socialPlatform));
        }
      }
      return send(sock, msg, extra, url, link.kind, link.height, known);
    }

    return say(`Usage: ${P}${usage.replace(/^\./, '')}`);
  },
});

module.exports = [
  makeCommand({
    name: 'tiktok',
    aliases: ['tt'],
    label: 'tiktok',
    description: 'Download a TikTok video (no watermark when the source allows it)',
    usage: '.tiktok <TikTok link>',
    domains: ['tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com'],
    hostLabel: 'TikTok',
  }),
  makeCommand({
    name: 'instagram',
    aliases: ['ig', 'insta', 'igdl', 'reels'],
    label: 'instagram',
    description: 'Download Instagram reels, videos, or photos',
    usage: '.instagram <Instagram link>',
    domains: ['instagram.com', 'instagr.am', 'ddinstagram.com'],
    hostLabel: 'Instagram',
    socialPlatform: 'instagram',
  }),
  makeCommand({
    name: 'fb',
    aliases: ['fbdl', 'facebookdl', 'facebook'],
    label: 'facebook',
    defaultHeight: 1080,
    description: 'Download a Facebook video or reel',
    usage: '.fb <Facebook video link>',
    domains: ['facebook.com', 'fb.watch', 'fb.com', 'm.facebook.com'],
    hostLabel: 'Facebook',
    socialPlatform: 'facebook',
  }),
];
