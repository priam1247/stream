'use strict';

/**
 * commands/song/index.js — .song <name|url>
 *
 * Preserved from the old commands/media/song.js + utils/xjxMedia.js:
 *   - same command name, same aliases (play, yta)
 *   - same usage strings and same failure wording
 *   - yt-search picks the first result, then the resolver is asked for audio
 *
 * CHANGED (fallbacks removed, see MIGRATION_REPORT.md):
 *   The old resolver chain was KnightBot → ApisSupreme → Apix → Hector URL →
 *   Hector search, five providers tried in order. Only ONE survives here:
 *   ApisSupreme. It is the single path. When it fails the command throws a
 *   specific error and the user sees "⚠️ .song is down".
 */

const meta = require('./command.json');
const search = require('./search');
const apisupreme = require('./apisupreme');

async function run(ctx) {
  const input = String(ctx.text || '').trim();

  // 1. validate
  if (!input) {
    return ctx.reply(`🎵 Please provide a song name or YouTube URL.`);
  }
  if (input.length > meta.limits.maxInputChars) {
    return ctx.reply(`❌ That search is too long (max ${meta.limits.maxInputChars} characters).`);
  }

  await ctx.react('🎵');

  // 2. resolve the YouTube target (one path: yt-search)
  const target = await search.resolve(input);
  if (!target) {
    return ctx.reply('❌ No songs found for that search.');
  }

  // 3. check limits BEFORE downloading
  if (target.durationSeconds && target.durationSeconds > meta.limits.maxDurationMin * 60) {
    return ctx.reply(
      `❌ That track is ${Math.round(target.durationSeconds / 60)} minutes long. `
      + `The limit is ${meta.limits.maxDurationMin} minutes.`,
    );
  }

  // 4. one resolver, one path
  const track = await apisupreme.fetchAudio(target.url);

  // 5. send through ctx
  const caption = `${track.title || target.title}`.slice(0, 200);
  await ctx.send.audio(track.file, caption);

  return undefined;
}

module.exports = { run };
