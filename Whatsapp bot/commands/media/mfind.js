'use strict';

/**
 * .mfind — keyless music search and link resolver.
 *
 *   .mfind <song name>                    search every catalog → picker → MP3
 *   .mfind <Deezer/Spotify/Apple/SC link> resolve metadata → MP3
 *   .mfind <name|link> --video [720]     send the music video instead
 *   .mfind <name|link> --first           skip the picker, take the best hit
 *
 * Deezer, iTunes, Spotify's embed page and SoundCloud's public API supply
 * metadata; the audio/video itself comes from a public YouTube or SoundCloud
 * upload through the standalone utils/ownMedia/ engine (direct player API →
 * HTTPS stream → ffmpeg). No yt-dlp binary, no keys, no accounts, no remote
 * resolver services, no protected streams.
 */

const config = require('../../config');
const musicSources = require('../../utils/musicSources/deliver');
const { QUALITIES } = require('../../utils/mediaPipeline');

module.exports = {
  name: 'mfind',
  aliases: ['findmusic', 'msearch'],
  category: 'media',
  description: 'Search Deezer / Apple Music / SoundCloud / YouTube or resolve a music link (MP3 or music video)',
  usage: '.mfind <name|link> [--audio|--video] [720] [--first]',

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

    const rest = [];
    let first = false;
    let explicitKind = null;
    let explicitHeight = 0;
    let invalidQuality = false;

    for (let i = 0; i < args.length; i++) {
      const token = String(args[i] || '');
      if (/^--?first$/i.test(token)) { first = true; continue; }
      const kindFlag = /^--(audio|video)$/i.exec(token);
      if (kindFlag) { explicitKind = kindFlag[1].toLowerCase(); continue; }
      const qualityFlag = /^--quality(?:=(.*))?$/i.exec(token);
      if (qualityFlag) {
        const value = qualityFlag[1] === undefined ? String(args[++i] || '') : qualityFlag[1];
        const height = Number(String(value).toLowerCase().replace(/p$/, ''));
        if (QUALITIES.includes(height)) explicitHeight = height;
        else invalidQuality = true;
        continue;
      }
      rest.push(token);
    }
    if (invalidQuality) return say('Quality must be 144, 240, 360, 480, 720 or 1080.');

    // Only a trailing quality number is an option: words such as "song" or
    // "video" can legitimately be part of a title, so they need --audio/--video.
    const tokens = [...rest];
    if (tokens.length > 1) {
      const last = String(tokens.at(-1) || '').toLowerCase().replace(/p$/, '');
      if (QUALITIES.includes(Number(last))) {
        explicitHeight = explicitHeight || Number(last);
        tokens.pop();
      }
    }
    let input = tokens.join(' ').trim();
    if (input.startsWith('!')) { first = true; input = input.slice(1).trim(); }
    if (!input) return say(`Usage: ${module.exports.usage}`);

    return musicSources.deliverMusic(sock, msg, extra, {
      input,
      kind: explicitKind || 'audio',
      height: explicitHeight || Number(config.video?.defaultQuality) || 720,
      firstHit: first,
      maxResults: Number(config.search?.maxResults) || 5,
    });
  },
};
