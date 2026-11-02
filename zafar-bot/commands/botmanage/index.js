'use strict';

/**
 * commands/botmanage/index.js — owner switchboard.
 *
 *   .botmanage access open|whitelist
 *   .botmanage maintenance on|off
 *   .botmanage restart
 *   .botmanage show
 */

const meta = require('./command.json');

const USAGE = [
  `Usage: ${meta.usage}`,
  '',
  '.botmanage show',
  '.botmanage access open|whitelist',
  '.botmanage maintenance on|off',
  '.botmanage restart',
].join('\n');

async function run(ctx) {
  const parts = String(ctx.text || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const action = parts[0] || '';

  if (!action || action === 'show') {
    return ctx.reply([
      `*Bot status on ${ctx.number}*`,
      `access mode: ${ctx.settings.accessMode}`,
      `maintenance: ${ctx.settings.maintenance ? 'on' : 'off'}`,
      `prefix: ${ctx.prefix}`,
    ].join('\n'));
  }

  if (!['access', 'maintenance', 'restart'].includes(action)) {
    return ctx.reply(`❌ Unknown action: *${action}*\n\n${USAGE}`);
  }

  const extra = parts.slice(1).join(' ');
  if (action !== 'restart' && !extra) {
    return ctx.reply(`Usage: .botmanage ${action} ${action === 'access' ? 'open|whitelist' : 'on|off'}`);
  }

  const result = await ctx.admin({ action, extra });
  return ctx.reply(result.message);
}

module.exports = { run };
