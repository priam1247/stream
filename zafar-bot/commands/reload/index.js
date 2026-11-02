'use strict';

/**
 * commands/reload/index.js — hot reload ONE command.
 *
 *   .reload <command>
 *
 * Only the registry is re-scanned and only this command's entry is replaced.
 * No socket restarts, no other command is touched, and a command mid-job keeps
 * running in its own child process.
 */

const meta = require('./command.json');

async function run(ctx) {
  const name = String(ctx.text || '').trim().toLowerCase();

  if (!name) return ctx.reply(`Usage: ${meta.usage}`);

  const result = await ctx.admin({ action: 'reload', extra: name });
  return ctx.reply(result.message);
}

module.exports = { run };
