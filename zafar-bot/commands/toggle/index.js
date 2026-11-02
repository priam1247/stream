'use strict';

/**
 * commands/toggle/index.js — enable/disable ONE command.
 *
 *   .toggle <command>   flips it
 *
 * Disabled commands stay loaded, keep their status, and refuse loudly with a
 * reason. Nothing restarts.
 */

const meta = require('./command.json');

async function run(ctx) {
  const name = String(ctx.text || '').trim().toLowerCase();

  if (!name) return ctx.reply(`Usage: ${meta.usage}`);

  const known = (ctx.catalogue || []).some((row) => row.name === name);
  if (!known) return ctx.reply(`❌ No command named *${name}*.`);

  const result = await ctx.admin({ action: 'toggle', extra: name });
  return ctx.reply(result.message);
}

module.exports = { run };
