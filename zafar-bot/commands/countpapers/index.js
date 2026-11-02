'use strict';

/**
 * commands/countpapers/index.js — vault headline count.
 * Same name, same aliases, same wording as the old bot.
 */

const vault = require('./vault');
const { makeAdapter } = require('./adapter');

async function run(ctx) {
  process.env.ZAFAR_JOB_TMP = ctx.tmp;
  vault.countpapersCmd.setLog
    ? vault.countpapersCmd.setLog(ctx.log)
    : vault.setLog(ctx.log);

  const { sock, msg, extra } = makeAdapter(ctx);
  return vault.countpapersCmd.execute(sock, msg, ctx.args, extra);
}

module.exports = { run };
