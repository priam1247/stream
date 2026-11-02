'use strict';

/**
 * commands/refreshpapers/index.js — owner-only forced vault re-sync.
 * Same name, same aliases (refreshvault, reloadpapers), same wording.
 */

const vault = require('./vault');
const { makeAdapter } = require('./adapter');

async function run(ctx) {
  process.env.ZAFAR_JOB_TMP = ctx.tmp;
  // Limits live in command.json. Handed to the ported vault explicitly so there
  // is exactly one place a cap can come from.
  vault.configureLimits(meta.limits);
  vault.refreshpapersCmd.setLog
    ? vault.refreshpapersCmd.setLog(ctx.log)
    : vault.setLog(ctx.log);

  const { sock, msg, extra } = makeAdapter(ctx);
  return vault.refreshpapersCmd.execute(sock, msg, ctx.args, extra);
}

module.exports = { run };
