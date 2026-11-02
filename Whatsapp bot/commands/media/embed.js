'use strict';

/**
 * .embed — inspect a public embed/player link, or deliver its audio/video.
 *
 *   .embed <link>                 report provider, canonical link, embed URL
 *   .embed <link> --audio         deliver the MP3 straight away
 *   .embed <link> --video 720     deliver the music video straight away
 *   .embed --list                 list the recognised providers
 *
 * The URL shapes come from spences10/sveltekit-embed (MIT), a Svelte 5
 * collection of iframe embed components. WhatsApp cannot render an iframe, so
 * this command reports the two URL forms and forwards the canonical link to
 * the keyless music sources / yt-dlp pipeline when a download is requested.
 */

const config = require('../../config');
const YT = require('../../utils/youtubedl');
const musicSources = require('../../utils/musicSources/deliver');
const { QUALITIES } = require('../../utils/mediaPipeline');

module.exports = {
  name: 'embed',
  aliases: ['linkinfo', 'unembed'],
  category: 'media',
  description: 'Resolve an embed/player link to its canonical URL (or deliver its audio/video)',
  usage: '.embed <link> [--audio|--video] [720] [--first] | .embed --list',

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

    const rest = [];
    let kind = null;
    let firstHit = false;
    let height = Number(config.video?.defaultQuality) || 720;
    let list = false;
    let invalidQuality = false;

    for (let i = 0; i < args.length; i++) {
      const token = String(args[i] || '');
      if (/^--?list$/i.test(token)) { list = true; continue; }
      if (/^--?first$/i.test(token)) { firstHit = true; continue; }
      const kindFlag = /^--(audio|video)$/i.exec(token);
      if (kindFlag) { kind = kindFlag[1].toLowerCase(); continue; }
      const qualityFlag = /^--quality(?:=(.*))?$/i.exec(token);
      if (qualityFlag) {
        const value = qualityFlag[1] === undefined ? String(args[++i] || '') : qualityFlag[1];
        const parsed = Number(String(value).toLowerCase().replace(/p$/, ''));
        if (QUALITIES.includes(parsed)) height = parsed;
        else invalidQuality = true;
        continue;
      }
      rest.push(token);
    }
    if (invalidQuality) return say('Quality must be 144, 240, 360, 480, 720 or 1080.');

    if (list) {
      const providers = musicSources.supportedProviders();
      const byCategory = new Map();
      for (const p of providers) {
        if (!byCategory.has(p.category)) byCategory.set(p.category, []);
        byCategory.get(p.category).push(p.label);
      }
      const lines = ['🔗 *Recognised embed providers*', ''];
      for (const [category, labels] of byCategory) lines.push(`*${category}*: ${labels.join(', ')}`);
      lines.push('', 'Any other https link is treated as a generic embed.');
      lines.push('Usage: .embed <link> [--audio|--video] [720] [--first]');
      return say(lines.join('\n'));
    }

    let input = rest.join(' ').trim();
    if (input.startsWith('!')) { firstHit = true; input = input.slice(1).trim(); }
    // A trailing bare quality number is an option, not part of the link.
    if (rest.length > 1) {
      const last = String(rest.at(-1) || '').toLowerCase().replace(/p$/, '');
      if (QUALITIES.includes(Number(last))) {
        height = Number(last);
        input = rest.slice(0, -1).join(' ').trim();
      }
    }
    const url = YT.extractUrl(input);
    if (!url) return say(`Usage: ${module.exports.usage}`);

    const info = musicSources.parseEmbed(url);
    const canonical = info?.canonical || url;

    if (kind) {
      return musicSources.deliverMusic(sock, msg, extra, {
        input: canonical, kind, height, firstHit,
        maxResults: Number(config.search?.maxResults) || 5,
      });
    }

    const text = musicSources.describe(url);
    if (!text) return say('❌ That does not look like a link.');
    return say(text);
  },
};
