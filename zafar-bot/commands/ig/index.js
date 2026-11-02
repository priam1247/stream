'use strict';

/**
 * commands/ig/index.js — .ig <Instagram link>
 *
 * Preserved from the old commands/media/shortcuts.js + utils/socialMedia.js:
 *   same aliases (instagram, insta, igdl, reels), same 10-item cap, same
 *   ordering (all items posted in the order the scraper returned them).
 *
 * CHANGED (structure): the code that used to be shared with .fb now lives in
 * this folder only.
 */

const meta = require('./command.json');
const urls = require('./urls');
const scraper = require('./scraper');
const { download } = require('./download');

async function run(ctx) {
  const input = String(ctx.text || '').trim();

  // 1. validate
  if (!input) return ctx.reply(`Usage: ${meta.usage}`);

  let parsed;
  try {
    parsed = urls.normalize(input);
  } catch (err) {
    return ctx.reply('❌ Please send a valid public Instagram link.');
  }

  await ctx.react('📥');

  // 2. resolve (one provider)
  const items = await scraper.resolve(parsed.href, {
    log: ctx.log,
    maxItems: meta.limits.maxItems,
  });

  // 3. download + send each item, refusing oversize before writing
  let sent = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const media = await download(item.url, {
      tmp: ctx.tmp,
      index: i,
      ext: item.ext,
      maxSizeMB: meta.limits.maxSizeMB,
      log: ctx.log,
    });

    if (item.kind === 'video') {
      await ctx.send.video(media.file, item.caption || '');
    } else {
      await ctx.send.image(media.file, item.caption || '');
    }
    sent += 1;
  }

  ctx.log.info(`delivered ${sent} item(s)`);
  return undefined;
}

module.exports = { run };
