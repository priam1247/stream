'use strict';

/**
 * commands/info/index.js — .info [series] <title>
 *
 * Preserved from the old commands/general/info.js: same aliases (meta, ids,
 * lookup), same `[series]` prefix word, same rendered card.
 *
 * It needs title metadata. That lookup lived in the shared engine, which is now
 * owned by .movie and .series individually. Rather than import another
 * command's engine (rule 1), .info queries the same keyless metadata source
 * directly: Cinemeta (Stremio), no API key, no fallback list.
 */

const meta = require('./command.json');
const { parseArgs, render, lookup } = require('./lookup');

async function run(ctx) {
  const input = String(ctx.text || '').trim();

  if (!input) return ctx.reply(`Usage: ${meta.usage}`);
  if (input.length > meta.limits.maxInputChars) {
    return ctx.reply(`❌ That title is too long (max ${meta.limits.maxInputChars} characters).`);
  }

  const { title, type } = parseArgs(ctx.args);
  if (!title) return ctx.reply(`Usage: ${meta.usage}`);

  // One metadata source, one request, no fallback.
  const item = await lookup(title, type);
  if (!item) return ctx.reply(`❌ Not found: *${title}*`);

  const text = render(item);
  return ctx.reply(text);
}

module.exports = { run };
