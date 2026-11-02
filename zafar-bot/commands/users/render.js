'use strict';

/** Parsing and text rendering for .users. Pure functions. */

function parseArgs(args) {
  const list = [...(args || [])].map((a) => String(a).trim()).filter(Boolean);
  const sub = (list.shift() || '').toLowerCase();
  let target = list.shift() || '';
  // Allow "265991234567@s.whatsapp.net" and "+265 991 234 567".
  target = target.replace(/@.*$/, '').replace(/\D/g, '');
  const extra = list.join(' ').trim();
  return { sub, target, extra };
}

const ICON = { owner: '👑', admin: '🛡️', user: '👤', banned: '⛔' };

function formatList(users, { number }) {
  if (!users.length) {
    return `_No users on ${number}._\nWhitelist mode would refuse everyone, so add users with .users add <number>.`;
  }
  const lines = [`*Users on ${number}* (${users.length})`, ''];
  for (const user of users) {
    const icon = ICON[user.role] || '👤';
    const blocked = user.blockedCommands?.length ? ` · blocked: ${user.blockedCommands.join(', ')}` : '';
    lines.push(`${icon} ${user.number}${user.name ? ` · ${user.name}` : ''} · ${user.role}${blocked}`);
  }
  return lines.join('\n');
}

function formatInfo(user) {
  if (!user) return '❌ No such user on this number.';
  const usage = Object.entries(user.usage || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}: ${count}`)
    .join(', ');
  return [
    `*${user.number}*`,
    `name: ${user.name || '—'}`,
    `role: ${user.role}`,
    `status: ${user.status}`,
    `joined: ${String(user.joinedAt || '—').slice(0, 10)}`,
    `last seen: ${user.lastSeen || '—'}`,
    `blocked: ${user.blockedCommands?.length ? user.blockedCommands.join(', ') : 'none'}`,
    `usage: ${usage || 'none'}`,
  ].join('\n');
}

module.exports = { parseArgs, formatList, formatInfo, ICON };
