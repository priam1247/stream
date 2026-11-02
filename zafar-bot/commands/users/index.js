'use strict';

/**
 * commands/users/index.js — user management for THIS number only.
 *
 *   .users list
 *   .users info <number>
 *   .users add <number>
 *   .users remove <number>
 *   .users ban <number>
 *   .users unban <number>
 *   .users role <number> admin|user
 *   .users block <number> <command>
 *   .users unblock <number> <command>
 *   .users approve <number>          (same as add; the word the owner uses)
 *   .users group on|off <jid>        (let the bot answer in one group)
 *
 * This command never imports gateway/users/store.js. It cannot: commands only
 * see ctx. It sends an admin request through ctx.admin, and the gateway applies
 * it through the store, which is the only writer of users.json.
 */

const meta = require('./command.json');
const { parseArgs, formatList, formatInfo } = require('./render');

const SUBCOMMANDS = ['list', 'info', 'add', 'remove', 'ban', 'unban', 'role', 'block', 'unblock', 'approve', 'group'];

const USAGE = [
  `${meta.usage}`,
  '',
  `.users list`,
  `.users info <number>`,
  `.users add <number>`,
  `.users remove <number>`,
  `.users ban <number> | unban <number>`,
  `.users role <number> admin|user`,
  `.users block <number> <command> | unblock <number> <command>`,
  '.users approve <number>',
  '.users group on|off <group jid>',
].join('\n');

async function run(ctx) {
  const { sub, target, extra } = parseArgs(ctx.args);

  // 1. validate
  if (!sub) return ctx.reply(USAGE);
  if (!SUBCOMMANDS.includes(sub)) {
    return ctx.reply(`❌ Unknown: *${sub}*\n\n${USAGE}`);
  }
  if (sub === 'group') {
    // .users group on|off <jid>
    const [action, groupJid] = String(ctx.text || '').replace(/^group\s*/i, '').split(/\s+/).filter(Boolean);
    const result = await ctx.admin({ action: 'group', extra: `${action || ''} ${groupJid || ''}`.trim() });
    return ctx.reply(result.message);
  }
  if (sub !== 'list' && !target) {
    return ctx.reply(`Usage: .users ${sub} <number>`);
  }

  // 2. ask the gateway to perform the action
  const request = { action: sub, target, extra };
  const result = await ctx.admin(request);

  // 3. render
  if (sub === 'list') {
    return ctx.reply(formatList(result.users, { number: ctx.number }));
  }
  if (sub === 'info') {
    return ctx.reply(formatInfo(result.user));
  }
  return ctx.reply(result.message);
}

module.exports = { run };
