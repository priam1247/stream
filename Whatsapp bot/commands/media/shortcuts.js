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
const providerSearch = require('../../utils/providerSearch');
const selections = require('../../utils/selections');
const jobQueue = require('../../utils/jobQueue');
const { downloadAndSend, parseOptions } = require('../../utils/mediaPipeline');

const QUALITIES = [144, 240, 360, 480, 720, 1080];

// Search titles are free text: bare words such as "music" and "video" remain
// part of the title. Explicit flags avoid the ambiguity of legacy link options.
function searchOptions(args, defaultKind) {
  const rest = [];
  const defaults = parseOptions([], { kind: defaultKind });
  let { kind, height } = defaults;
  let first = false;
  let invalidQuality = false;
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] || '');
    if (/^--?first$/i.test(token)) { first = true; continue; }
    if (/^--(?:audio|video|image)$/i.test(token)) { kind = token.slice(2).toLowerCase(); continue; }
    const qualityFlag = /^--quality(?:=(.*))?$/i.exec(token);
    if (qualityFlag) {
      const value = qualityFlag[1] === undefined ? String(args[++i] || '') : qualityFlag[1];
      const quality = Number(value.toLowerCase().replace(/p$/, ''));
      if (QUALITIES.includes(quality)) height = quality;
      else invalidQuality = true;
      continue;
    }
    rest.push(token);
  }
  const tail = String(rest[rest.length - 1] || '');
  if (rest.length > 1 && /^\d+p$/i.test(tail) && QUALITIES.includes(Number(tail.slice(0, -1)))) {
    height = Number(tail.slice(0, -1));
    rest.pop();
  }
  return { kind, height, first, invalidQuality, query: rest.join(' ').trim() };
}

// Keep legacy trailing link options, but apply explicit flags wherever they
// appear. A malformed explicit quality must never start a default download.
function linkOptions(args, defaultKind) {
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
  const parsed = parseOptions(rest, { kind: defaultKind });
  return { ...parsed, kind: explicitKind || parsed.kind, height: explicitHeight || parsed.height, invalidQuality };
}

// A URL is not a title. Also catch common scheme-less links with a path.
function containsUrl(text) {
  return Boolean(YT.extractUrl(text) || /(?:^|\s)(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?\/\S*/i.test(text));
}

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

const makeCommand = ({ name, aliases, description, usage, domains, hostLabel, label, searchable = false, defaultKind = 'video' }) => ({
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
    const search = searchable ? searchOptions(input, defaultKind) : null;
    const link = searchable ? null : linkOptions(input, defaultKind);
    const quotedUrl = YT.extractUrl(quotedTextOf(msg));
    const url = searchable ? null : (YT.extractUrl(link.rest.join(' ').trim()) || quotedUrl);
    const qualityError = 'Quality must be 144, 240, 360, 480, 720 or 1080.';
    if (!searchable && link.invalidQuality) return say(qualityError);

    const send = (socket, message, context, selectedUrl, kind, height, known) => {
      const imageUrl = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(selectedUrl);
      const lane = kind === 'audio' || kind === 'image' || imageUrl ? 'light' : 'heavy';
      return downloadAndSend(socket, message, context, {
        url: selectedUrl, kind, height, lane,
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
      return send(sock, msg, extra, url, link.kind, link.height, known);
    }

    if (searchable && containsUrl(input.join(' '))) {
      return say(`This shortcut searches titles only. To download a link, use ${P}dl <link>.`);
    }
    if (searchable && search.invalidQuality) return say(qualityError);
    if (!searchable || !search.query) {
      if (searchable && quotedUrl) return say(`This shortcut searches titles only. To download a link, use ${P}dl <link>.`);
      return say(`Usage: ${P}${usage.replace(/^\./, '')}`);
    }
    if (search.query.length > providerSearch.MAX_QUERY) return say(`Search titles must be ${providerSearch.MAX_QUERY} characters or fewer.`);

    await say(`Searching ${hostLabel}...`);
    let found;
    try {
      // Searches have their own queue and release it before a selected
      // download starts, so a slow index cannot occupy download-lane slots.
      found = await jobQueue.runInLane('search', () => providerSearch.searchProvider(name, search.query, {
        limit: Number(config.search?.maxResults) || 5,
      }));
    } catch {
      found = { results: [], status: 'unavailable' };
    }
    if (!found.results.length) {
      if (found.status === 'unavailable') {
        return say(`${hostLabel} search is unavailable right now. The site or search indexes may be blocked; try again later.`);
      }
      return say(`No ${hostLabel} videos found. Try a shorter or original-language title. Some videos may not be indexed.`);
    }

    if (search.first) return send(sock, msg, extra, found.results[0].url, search.kind, search.height, true);

    const lines = found.results.map((r, i) => {
      const time = r.duration ? ` (${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')})` : '';
      return `*${i + 1}.* ${r.title}${r.episode ? ` · Episode ${r.episode}` : ''}${r.author ? ` — ${r.author}` : ''}${time}`;
    });
    const text = `*${hostLabel} results*\n${lines.join('\n')}\n\nReply ${P}1–${P}${found.results.length} or ${P}cancel.`;
    return selections.sendTextPrompt(sock, msg, extra, {
      text,
      items: found.results,
      label: name,
      ttlMs: Math.max(1, Number(config.search?.ttlMinutes) || 5) * 60 * 1000,
      run: (sock2, msg2, extra2, item) => send(sock2, msg2, extra2, item.url, search.kind, search.height, true),
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
    searchable: true,
    description: `Search ${site.hostLabel} by title and download a result`,
    usage: `.${site.name} <title> [--audio] [480p]`,
  })),
];
