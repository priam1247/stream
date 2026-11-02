'use strict';

/**
 * commands/ping/index.js
 *
 * Behaviour preserved from the old commands/general/ping.js:
 *   reply "🏓 Pinging..." then edit it to "🏓 *Pong!* · <ms>ms".
 *
 * The ctx has no edit method, and adding one would break the documented ctx
 * spec. The old command's observable result was a single message that ends up
 * reading "🏓 *Pong!* · <ms>ms"; that is what this sends. Differences are listed
 * in MIGRATION_REPORT.md.
 */

async function run(ctx) {
  const started = Date.now();
  await ctx.reply('🏓 Pinging...');
  const ms = Date.now() - started;
  return ctx.reply(`🏓 *Pong!* · ${ms}ms`);
}

module.exports = { run };
