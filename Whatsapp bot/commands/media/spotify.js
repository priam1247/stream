const config = require('../../config');
const spotify = require('../../utils/spotify');
const YT = require('../../utils/youtubedl');
const youtubeSearch = require('../../utils/youtubeSearch');
const deezer = require('../../utils/deezer');
const deezerCommand = require('./deezer');
const { downloadAndSend } = require('../../utils/mediaPipeline');

module.exports = {
  name: 'spotify',
  aliases: ['sp', 'spot', 'spotdl'],
  category: 'media',
  description: 'Download a Spotify track as MP3',
  usage: '.spotify <Spotify link or song>',

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
    const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});

    const input = args.join(' ').trim();
    if (!input) return say(`Usage: ${module.exports.usage}`);

    const status = await extra.status('🎧 Resolving…').catch(() => null);
    const update = (t) => (status ? status.update(t) : say(t));

    try {
      const track = await spotify.resolveTrack(input);
      const shown = track.artists ? `${track.artists} — ${track.title}` : track.title;

      // Reduce cross-platform mismatches with title, artist, duration and ISRC
      // when Spotify provides it; otherwise retain the YouTube fallback.
      if (deezer.configured() && (track.source === 'query' || (track.type === 'track' && track.artists))) {
        await update(`🎧 *${shown}*`);
        const expected = track.source === 'query' ? null : {
          title: track.title, artist: track.artists, duration: (track.durationMs || 0) / 1000,
          isrc: track.isrc || '',
        };
        const handled = await deezerCommand.attempt(sock, msg, extra, {
          input: track.searchQuery, sendAs: String(config.song?.sendAs || 'document').toLowerCase(),
          firstHit: true, fallback: true, expected,
        });
        if (handled) return;
      }

      const results = await youtubeSearch.searchYouTube(track.searchQuery, { limit: 3 });
      if (!results.length) {
        await react('❌');
        return update(`❌ Not found: *${shown}*`);
      }

      const best = results[0];
      await update(`🎧 *${shown}*`);

      return downloadAndSend(sock, msg, extra, {
        url: best.url,
        kind: 'audio',
        title: track.artists ? `${track.title} - ${track.artists}` : track.title,
        author: track.artists,
        attempts: [{ engine: 'spotify+yt-dlp', code: 'OK' }],
        lane: 'light',
        cache: false,
      });
    } catch (e) {
      console.error('[spotify] error:', e.message);
      await react('❌');
      const isOwner = Boolean(extra?.isOwner);
      const hint = e.code === 'SPOTIFY_META'
        ? `❌ Invalid Spotify link. Try \`${config.prefix}song <title>\`.`
        : YT.friendlyError(e, { isOwner });
      return update(hint);
    }
  },
};
