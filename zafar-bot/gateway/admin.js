'use strict';

/**
 * gateway/admin.js — the write side of the user mechanism, and the only place
 * that touches mutable gateway state on behalf of an admin command.
 *
 * Commands ask; the gateway applies. `ctx.admin({action, target, extra})` is the
 * single door, and every write goes through users/store.js.
 *
 * Authorisation is re-checked HERE, not just in command.json. A command that
 * says `role: admin` must not be able to promote somebody because an admin
 * called it — promoting to owner, editing the owner, and switching a number's
 * access mode are owner-only operations regardless of the command's own role.
 */

const store = require('./users/store');
const registry = require('./registry');
const status = require('./status');
const jid = require('../lib/jid');
const { gatewayLog } = require('./log');
const { RANK } = require('./users/roles');

function actorRole(number, sender) {
  const owner = store.readOwner();
  if (owner && owner === jid.digits(sender)) return 'owner';
  const user = store.getUser(number, sender);
  return user?.role || null;
}

function requireRole(actor, needed) {
  if ((RANK[actor] ?? 0) < (RANK[needed] ?? 0)) {
    throw new Error(`this action needs role "${needed}"; you are "${actor || 'unknown'}"`);
  }
}

/**
 * @param {object} args
 * @param {string} args.number   the linked number receiving the message
 * @param {string} args.sender   the sender's number
 * @param {object} args.request  { action, target, extra }
 */
async function apply({ number, sender, request }) {
  const action = String(request?.action || '').toLowerCase();
  const target = jid.digits(request?.target || '');
  const extra = String(request?.extra || '').trim();
  const actor = actorRole(number, sender);

  requireRole(actor, 'admin');
  const owner = store.readOwner();

  switch (action) {
    case 'list':
      return { users: store.listUsers(number) };

    case 'info': {
      if (!jid.isNumber(target)) throw new Error('a valid number is required');
      const user = store.getUser(number, target);
      if (!user && owner === target) {
        return {
          user: {
            number: target, name: 'owner', role: 'owner', status: 'active',
            joinedAt: '—', lastSeen: '—', blockedCommands: [], usage: {},
          },
        };
      }
      return { user };
    }

    case 'add': {
      if (!jid.isNumber(target)) throw new Error('a valid number is required');
      const record = store.addUser(number, target, { reason: `added by ${sender}` });
      return { message: `✅ Added *${target}* as ${record.role}.`, user: record };
    }

    case 'remove': {
      if (!jid.isNumber(target)) throw new Error('a valid number is required');
      if (owner === target) throw new Error('refusing to remove the owner');
      store.removeUser(number, target);
      return { message: `✅ Removed *${target}* from this number.` };
    }

    case 'ban': {
      if (!jid.isNumber(target)) throw new Error('a valid number is required');
      if (owner === target) throw new Error('refusing to ban the owner');
      store.banUser(number, target);
      return { message: `⛔ Banned *${target}* on this number.` };
    }

    case 'unban': {
      if (!jid.isNumber(target)) throw new Error('a valid number is required');
      store.unbanUser(number, target);
      return { message: `✅ Unbanned *${target}* on this number.` };
    }

    case 'role': {
      if (!jid.isNumber(target)) throw new Error('a valid number is required');
      const role = extra.toLowerCase();
      if (!['admin', 'user'].includes(role)) {
        throw new Error('role must be "admin" or "user" (the owner is set once with add-owner)');
      }
      // Changing an admin's role is owner-only.
      const existing = store.getUser(number, target);
      if (existing?.role === 'admin') requireRole(actor, 'owner');
      store.setRole(number, target, role);
      return { message: `✅ *${target}* is now ${role} on this number.` };
    }

    case 'block': {
      if (!jid.isNumber(target)) throw new Error('a valid number is required');
      const command = extra.toLowerCase();
      if (!command) throw new Error('a command name is required');
      if (!registry.get(command)) {
        throw new Error(`no command named "${command}"`);
      }
      store.blockCommand(number, target, command);
      return { message: `✅ Blocked *${target}* from .${command} on this number.` };
    }

    case 'unblock': {
      if (!jid.isNumber(target)) throw new Error('a valid number is required');
      const command = extra.toLowerCase();
      if (!command) throw new Error('a command name is required');
      store.unblockCommand(number, target, command);
      return { message: `✅ Unblocked *${target}* from .${command}.` };
    }

    /* ── toggle / reload / botmanage / sessions ──────────────────────────── */

    case 'toggle': {
      const name = String(request?.extra || '').toLowerCase();
      const command = registry.get(name);
      if (!command) throw new Error(`no command named "${name}"`);
      const currentlyDisabled = storeDisabled(name);
      if (currentlyDisabled) {
        setDisabled(name, null);
        status.enable(name);
        gatewayLog.info('command enabled', { command: name, by: sender });
        return { message: `✅ .${name} enabled.` };
      }
      setDisabled(name, `disabled by ${sender}`);
      status.markDisabled(name, `disabled by ${sender}`);
      gatewayLog.info('command disabled', { command: name, by: sender });
      return { message: `⛔ .${name} disabled.` };
    }

    case 'reload': {
      const name = String(request?.extra || '').toLowerCase();
      if (!registry.get(name)) throw new Error(`no command named "${name}"`);
      // Reload the whole registry entry set, then report on this one command.
      const result = registry.load();
      const problems = result.errors[name];
      if (problems) {
        status.markBroken(name, problems.join('; '), { source: 'load' });
        return { message: `❌ .${name} failed to reload: ${problems.join('; ')}` };
      }
      status.markOk(name, { source: 'reload' });
      gatewayLog.info('command reloaded', { command: name, by: sender, loaded: result.loaded, failed: result.failed });
      return { message: `♻️ Reloaded .${name}. Nothing else was restarted. (registry: ${result.loaded} loaded, ${result.failed} failed)` };
    }

    case 'restart': {
      requireRole(actor, 'owner');
      gatewayLog.warn('restart requested', { by: sender });
      // Deployments run under pm2 (ecosystem.config.js); exiting non-zero lets it
      // bring the process back with fresh code.
      setTimeout(() => process.exit(1), 500);
      return { message: '♻️ Restarting the service. It will be back in a few seconds.' };
    }

    case 'access': {
      requireRole(actor, 'owner');
      const mode = String(request?.extra || '').toLowerCase();
      if (!['open', 'whitelist'].includes(mode)) throw new Error('access mode must be "open" or "whitelist"');
      store.setAccessMode(number, mode);
      return { message: `✅ Access mode on *${number}* is now *${mode}*.` };
    }

    case 'maintenance': {
      requireRole(actor, 'owner');
      const flag = String(request?.extra || '').toLowerCase();
      if (!['on', 'off'].includes(flag)) throw new Error('maintenance must be "on" or "off"');
      store.setMaintenance(number, flag === 'on');
      return { message: `🔧 Maintenance on *${number}* is now *${flag}*.` };
    }

    case 'sessions-status': {
      requireRole(actor, 'owner');
      return { sessions: request?.sessions || [] };
    }

    case 'sessions-link': {
      requireRole(actor, 'owner');
      if (!jid.isNumber(target)) throw new Error('a valid number is required');
      if (typeof request?.requestPairing !== 'function') {
        throw new Error('pairing is not wired on this gateway');
      }
      const { code } = await request.requestPairing(target);
      return {
        message: [
          `🔗 Pairing code for *${target}*: *${code}*`,
          '',
          'WhatsApp → Linked devices → Link a device → Link with phone number instead.',
        ].join('\n'),
      };
    }

    default:
      throw new Error(`unknown admin action: ${JSON.stringify(action)}`);
  }
}

/* ── disabled.json ─────────────────────────────────────────────────────────── */

const { paths } = require('../lib/paths');
const { readJsonSafe, writeJsonAtomic } = require('../lib/fsutil');
const path = require('path');

const DISABLED_FILE = paths.disabled;

function readDisabled() {
  const res = readJsonSafe(DISABLED_FILE, { defaultValue: { commands: {} }, validate: (d) => Boolean(d && d.commands) });
  return res.ok ? res.data : { commands: {} };
}

function storeDisabled(name) {
  return Boolean(readDisabled().commands?.[name]);
}

function setDisabled(name, reason) {
  const data = readDisabled();
  data.commands = data.commands || {};
  if (reason) data.commands[name] = { reason, at: new Date().toISOString() };
  else delete data.commands[name];
  writeJsonAtomic(DISABLED_FILE, data);
}

/** Apply disabled.json to the status board at boot. */
function applyDisabledAtBoot() {
  const data = readDisabled();
  for (const [name, value] of Object.entries(data.commands || {})) {
    if (registry.get(name)) status.markDisabled(name, value.reason || 'disabled');
  }
}

module.exports = { apply, applyDisabledAtBoot, readDisabled, setDisabled, actorRole, requireRole };
