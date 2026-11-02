'use strict';

/**
 * commands/debrid/index.js — static informational reply.
 *
 * Preserved exactly: the old debrid.js returned this same sentence because
 * debrid services were removed from the bot. It has no external service and
 * cannot fail, which makes it a useful "is the gateway alive" probe.
 */

async function run(ctx) {
  return ctx.reply('Movie downloads use keyless sources and direct torrents; debrid services are no longer used.');
}

module.exports = { run };
