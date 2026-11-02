'use strict';

/**
 * commands/status/index.js — the health board.
 *
 *   ✅ ping    ✅ menu    ✅ paper
 *   ✅ song    ❌ ig  → snapsave 403 (last ok: 2h ago)
 *   ✅ video   ✅ fb      ⛔ movie (disabled by admin)
 *
 * The board is built from ctx.statuses (the gateway's status.js snapshot) and
 * ctx.catalogue (what loaded). Pure rendering, no I/O.
 */

const meta = require('./command.json');
const { renderBoard, unknownCommandDetail } = require('./board');

async function run(ctx) {
  const only = String(ctx.text || '').trim().toLowerCase();

  const catalogue = Array.isArray(ctx.catalogue) ? ctx.catalogue : [];
  const statuses = ctx.statuses || {};

  if (!catalogue.length && !Object.keys(statuses).length) {
    return ctx.reply('❌ No commands are loaded and no status is recorded. The registry failed.');
  }

  if (only) {
    const row = catalogue.find((c) => c.name === only || (c.aliases || []).includes(only));
    if (!row) return ctx.reply(`❌ No command named *${only}*.`);
    return ctx.reply(unknownCommandDetail(row, statuses[row.name], { prefix: ctx.prefix }));
  }

  return ctx.reply(renderBoard(catalogue, statuses, { prefix: ctx.prefix }));
}

module.exports = { run };
