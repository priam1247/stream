const YT = require('../../utils/youtubedl');
const musicSources = require('../../utils/musicSources/deliver');
const { downloadAndSend, parseOptions } = require('../../utils/mediaPipeline');

module.exports = {
  name: 'dl',
  aliases: ['download', 'save', 'getvid', 'fetch'],
  category: 'media',
  description: 'Download media from a URL',
  usage: '.dl <link> [audio|video|image] [quality]',

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

    const { kind, height, rest } = parseOptions(args);
    const url = YT.extractUrl(rest.join(' ').trim());

    if (!url) {
      return say('Usage: .dl <link> [audio|video] [quality]');
    }

    // Music catalog links are metadata, not playable files. Resolve them to a
    // public upload first instead of handing the service URL to yt-dlp.
    if (kind !== 'image' && musicSources.isMusicInput(url)) {
      return musicSources.deliverMusic(sock, msg, extra, {
        input: url, kind: kind === 'audio' ? 'audio' : 'video', height,
        maxResults: 5,
      });
    }

    const attempts = [];
    const imageUrl = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url);
    const lane = kind === 'audio' || kind === 'image' || imageUrl ? 'light' : 'heavy';
    return downloadAndSend(sock, msg, extra, { url, kind, height, attempts, lane });
  },
};
