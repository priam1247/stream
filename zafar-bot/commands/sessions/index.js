'use strict';

/**
 * commands/sessions/index.js — which numbers are linked.
 *
 *   .sessions          live session states
 *   .sessions status   same
 *   .sessions link <number>   ask the gateway for a pairing code
 *
 * Pairing itself belongs to the gateway (it owns sockets). The command only
 * asks; the code arrives in the chat.
 */

const meta = require('./command.json');

async function run(ctx) {
  const parts = String(ctx.text || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const action = parts[0] || 'status';

  if (action === 'status' || !parts.length) {
    const result = await ctx.admin({ action: 'sessions-status' });
    const list = result.sessions || [];
    if (!list.length) return ctx.reply('_No sessions are running._');
    const lines = ['*Linked sessions*', ''];
    for (const s of list) {
      const dot = s.state === 'open' ? '🟢' : s.state === 'logged_out' ? '⛔' : '🟠';
      lines.push(`${dot} ${s.number} · ${s.state}${s.lastError ? ` · ${String(s.lastError).slice(0, 80)}` : ''}`);
    }
    return ctx.reply(lines.join('\n'));
  }

  if (action === 'link') {
    const number = (parts[1] || '').replace(/\D/g, '');
    if (!number) return ctx.reply(`Usage: ${meta.usage}`);
    const result = await ctx.admin({ action: 'sessions-link', extra: number });
    return ctx.reply(result.message);
  }

  return ctx.reply(`Usage: ${meta.usage}`);
}

module.exports = { run };
