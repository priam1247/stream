'use strict';

/**
 * commands/paper/index.js — .paper <code> [module] [year] | .paper browse [code] [page]
 *
 * Preserved from the old commands/general/paper.js: same command name, same
 * aliases (papers, pastpaper, pp), same usage text, same "already sent in this
 * chat within the last 3 days" rule, same Drime vault, same snapshot format.
 *
 * The working logic is the original 863-line implementation, copied into
 * vault.js and driven through adapter.js so it runs against ctx.
 */

const meta = require('./command.json');
const vault = require('./vault');
const { makeAdapter } = require('./adapter');

async function run(ctx) {
  const input = String(ctx.text || '').trim();

  if (input.length > meta.limits.maxInputChars) {
    return ctx.reply(`Usage: ${meta.usage}`);
  }

  // The job's temp folder is where downloads land and where the gateway will
  // delete everything afterwards.
  process.env.ZAFAR_JOB_TMP = ctx.tmp;
  // Limits live in command.json. Handed to the ported vault explicitly so there
  // is exactly one place a cap can come from.
  vault.configureLimits(meta.limits);
  vault.paperCommand.setLog(ctx.log);

  const { sock, msg, extra } = makeAdapter(ctx);
  return vault.paperCommand.execute(sock, msg, ctx.args, extra);
}

module.exports = { run };
