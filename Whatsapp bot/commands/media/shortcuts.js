/**
 * ZaFar Bot — site shortcuts: .tiktok / .x / .pinterest / .instagram / .fb
 *
 * Thin wrappers around the shared pipeline (`utils/mediaPipeline.js`), which
 * streams every file directly to disk instead of buffering in RAM and cleans
 * up temp files immediately after sending:
 *
 *   .tiktok <link> [quality]      .tt
 *   .x <link> [quality]           .twitter .xtwitter
 *   .pinterest <link>             .pin     (sends the image when it is an image)
 *   .instagram <link>             .ig .insta .igdl .reels
 *   .fb <link> [quality]          .fbdl .facebookdl .facebook
 */

const config = require('../../config');
const YT = require('../../utils/youtubedl');
const { downloadAndSend, parseOptions } = require('../../utils/mediaPipeline');

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

const makeCommand = ({ name, aliases, description, usage, domains, hostLabel, label, defaultKind = 'video' }) => ({
  name,
  aliases,
  category: 'media',
  description,
  usage,

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
    const P = config.prefix || '.';

    const { kind, height, rest } = parseOptions(args, { kind: defaultKind });
    const url = YT.extractUrl(rest.join(' ').trim()) || YT.extractUrl(quotedTextOf(msg));

    if (!url) {
      return say(`Usage: ${P}${usage.replace(/^\./, '')}`);
    }

    // This is diagnostic only: shortcuts have historically accepted other
    // links too. Inspect the host rather than substrings in paths or queries.
    let host = '';
    try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* pipeline reports invalid URLs */ }
    const known = domains.some((d) => {
      const domain = d.toLowerCase();
      return domain.endsWith('.')
        ? host.startsWith(domain) || host.includes(`.${domain}`)
        : host === domain || host.endsWith(`.${domain}`);
    });
    const imageUrl = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url);
    const lane = kind === 'audio' || kind === 'image' || imageUrl ? 'light' : 'heavy';

    return downloadAndSend(sock, msg, extra, {
      url,
      kind,
      height,
      lane,
      attempts: [{ engine: `${label} chain`, code: known ? 'OK' : 'HOST_MISMATCH' }],
    });
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
    name: 'x',
    aliases: ['twitter', 'xtwitter'],
    label: 'x',
    description: 'Download a video from X / Twitter',
    usage: '.x <tweet link>',
    domains: ['twitter.com', 'x.com', 't.co', 'nitter.'],
    hostLabel: 'X/Twitter',
  }),
  makeCommand({
    name: 'pinterest',
    aliases: ['pin'],
    label: 'pinterest',
    description: 'Download a Pinterest pin (image or video)',
    usage: '.pinterest <Pinterest link>',
    domains: ['pinterest.', 'pin.it'],
    hostLabel: 'Pinterest',
  }),
  makeCommand({
    name: 'instagram',
    aliases: ['ig', 'insta', 'igdl', 'reels'],
    label: 'instagram',
    description: 'Download Instagram reels, videos, or photos',
    usage: '.instagram <Instagram link>',
    domains: ['instagram.com', 'instagr.am', 'ddinstagram.com'],
    hostLabel: 'Instagram',
  }),
  makeCommand({
    name: 'fb',
    aliases: ['fbdl', 'facebookdl', 'facebook'],
    label: 'facebook',
    description: 'Download a Facebook video or reel',
    usage: '.fb <Facebook video link>',
    domains: ['facebook.com', 'fb.watch', 'fb.com', 'm.facebook.com'],
    hostLabel: 'Facebook',
  }),
  ...[
    { name: 'bilibili', aliases: ['bili'], hostLabel: 'Bilibili', domains: ['bilibili.com', 'bilibili.tv', 'bili.tv', 'b23.tv'] },
    { name: 'vimeo', aliases: [], hostLabel: 'Vimeo', domains: ['vimeo.com'] },
    { name: 'dailymotion', aliases: ['daily'], hostLabel: 'Dailymotion', domains: ['dailymotion.com', 'dai.ly'] },
    { name: 'reddit', aliases: [], hostLabel: 'Reddit', domains: ['reddit.com', 'redd.it'] },
    { name: 'twitch', aliases: [], hostLabel: 'Twitch', domains: ['twitch.tv'] },
    { name: 'rumble', aliases: [], hostLabel: 'Rumble', domains: ['rumble.com'] },
    { name: 'odysee', aliases: [], hostLabel: 'Odysee', domains: ['odysee.com', 'lbry.tv'] },
    { name: 'weibo', aliases: [], hostLabel: 'Weibo', domains: ['weibo.com', 'weibo.cn'] },
    { name: 'douyin', aliases: [], hostLabel: 'Douyin', domains: ['douyin.com', 'iesdouyin.com'] },
    { name: 'acfun', aliases: [], hostLabel: 'AcFun', domains: ['acfun.cn'] },
    { name: 'youku', aliases: [], hostLabel: 'Youku', domains: ['youku.com'] },
    { name: 'vk', aliases: [], hostLabel: 'VK', domains: ['vk.com', 'vkvideo.ru'] },
    { name: 'xiaohongshu', aliases: ['xhs'], hostLabel: 'Xiaohongshu', domains: ['xiaohongshu.com', 'xhslink.com'] },
    { name: 'niconico', aliases: ['nico'], hostLabel: 'Niconico', domains: ['nicovideo.jp', 'nico.ms'] },
  ].map((site) => makeCommand({
    ...site,
    label: site.name,
    description: `Download a ${site.hostLabel} post or video via yt-dlp`,
    usage: `.${site.name} <${site.hostLabel} link>`,
  })),
];
