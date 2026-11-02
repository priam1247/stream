'use strict';

/**
 * commands/video/index.js — .video <name|url>
 *
 * Preserved from the old commands/media/video.js + utils/xjxMedia.js:
 *   same name, same alias (ytmp4), same usage, same failure wording,
 *   same 480p default that the old .video used.
 *
 * CHANGED (fallbacks removed): the old chain was KnightBot → Keithsite.
 * Only KnightBot remains. One path, loud failure.
 */

const meta = require('./command.json');
const search = require('./search');
const knightbot = require('./knightbot');

async function run(ctx) {
  const input = String(ctx.text || '').trim();

  // 1. validate
  if (!input) return ctx.reply('🎬 Please provide a video name or YouTube URL.');
  if (input.length > meta.limits.maxInputChars) {
    return ctx.reply(`❌ That search is too long (max ${meta.limits.maxInputChars} characters).`);
  }

  await ctx.react('🎬');

  // 2. resolve the YouTube target (one path: yt-search)
  const target = await search.resolve(input);
  if (!target) return ctx.reply('❌ No videos found for that search.');

  // 3. limits before downloading
  const maxMinutes = Number(meta.limits.maxDurationMin) || 0;
  if (maxMinutes && target.durationSeconds > maxMinutes * 60) {
    return ctx.reply(`❌ That video is longer than ${maxMinutes} minutes.`);
  }

  // 4. one resolver
  const media = await knightbot.fetchVideo(target.url, {
    tmp: ctx.tmp,
    log: ctx.log,
    quality: 480,
    maxSizeMB: meta.limits.maxSizeMB,
  });

  // 5. send
  await ctx.send.video(media.file, String(target.title || 'video').slice(0, 200));
  return undefined;
}

module.exports = { run };
