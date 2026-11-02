'use strict';

/**
 * commands/fb/index.js — .fb <Facebook link>
 *
 * Preserved from the old commands/media/shortcuts.js + utils/socialMedia.js:
 *   same aliases (fbdl, facebookdl, facebook), same 1080p default hint,
 *   same reply shape on failure.
 *
 * CHANGED (structure): owns its own scraper and downloader.
 */

const meta = require('./command.json');
const urls = require('./urls');
const scraper = require('./scraper');
const { download } = require('./download');

async function run(ctx) {
  const input = String(ctx.text || '').trim();

  if (!input) return ctx.reply(`Usage: ${meta.usage}`);

  let parsed;
  try {
    parsed = urls.normalize(input);
  } catch {
    return ctx.reply('❌ Please send a valid public Facebook video link.');
  }

  await ctx.react('↘️');

  const item = await scraper.resolve(parsed.href, { log: ctx.log });

  const media = await download(item.url, {
    tmp: ctx.tmp,
    index: 0,
    ext: item.ext,
    maxSizeMB: meta.limits.maxSizeMB,
    log: ctx.log,
  });

  if (item.kind === 'video') {
    await ctx.send.video(media.file, item.caption || '');
  } else {
    await ctx.send.image(media.file, item.caption || '');
  }
  return undefined;
}

module.exports = { run };
