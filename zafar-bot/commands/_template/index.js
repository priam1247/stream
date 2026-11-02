'use strict';

/**
 * commands/_template/index.js — the shape every command follows.
 *
 * Read top to bottom:
 *   1. validate input
 *   2. check limits BEFORE doing any work
 *   3. do the work
 *   4. send through ctx
 *
 * No try/catch around the whole flow. A failure must reach the runner so the
 * user gets "⚠️ down" and logs/<name>.log gets the exact reason. Swallowing it
 * here would hide the failure, which is the whole thing this structure exists
 * to prevent.
 */

const meta = require('./command.json');
const { run: work } = require('./logic');

async function run(ctx) {
  const input = String(ctx.text || '').trim();

  // 1. validate
  if (!input) {
    return ctx.reply(`Usage: ${meta.usage}`);
  }
  if (input.length > meta.limits.maxInputChars) {
    return ctx.reply(`❌ That input is too long (max ${meta.limits.maxInputChars} characters).`);
  }

  // 3. do the work
  const answer = work(input);

  // 4. send
  await ctx.react('✅');
  return ctx.reply(answer);
}

module.exports = { run };
