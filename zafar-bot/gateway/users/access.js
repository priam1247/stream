'use strict';

/**
 * gateway/users/access.js — "can this user run this command on this number?"
 *
 * Pure decision function. It performs no writes and sends no messages, so it is
 * trivial to test and impossible to accidentally use to mutate state.
 */

const roles = require('./roles');

/**
 * @param {object} args
 * @param {string} args.number        the linked number that received the message
 * @param {string} args.userNumber    the sender
 * @param {object} args.settings      that number's settings
 * @param {string} args.requiredRole  from command.json
 * @param {string} args.command       command name
 * @param {object} args.user          that number's user record, or null
 * @returns {{allowed:boolean, reason:string, role:string}}
 */
function canRun({ number, userNumber, settings, requiredRole, command, user, ownerNumber = '' }) {
  const role = user ? user.role || 'user' : null;
  let effective = roles.isValidRole(role) ? role : null;
  // The owner is the same person on every linked number: the global owner file
  // outranks whatever this number's users.json happens to say (including
  // "no record at all"), and no per-number record can demote it.
  if (ownerNumber && ownerNumber === userNumber) effective = 'owner';

  // 2. banned
  if (effective && roles.isBanned(effective)) {
    return { allowed: false, reason: 'banned', role: effective };
  }

  // 3. access mode
  if (!settings) {
    return { allowed: false, reason: 'no-settings', role: effective };
  }
  if (settings.accessMode === 'whitelist' && !user) {
    return { allowed: false, reason: 'not-whitelisted', role: effective };
  }
  if (!roles.isValidRole(requiredRole)) {
    return { allowed: false, reason: 'bad-command-role', role: effective };
  }

  const candidate = effective || 'user';

  // 4. maintenance
  if (settings.maintenance && !roles.isStaff(candidate)) {
    return { allowed: false, reason: 'maintenance', role: candidate };
  }

  // 5. required role
  if (!roles.atLeast(candidate, requiredRole)) {
    return { allowed: false, reason: 'role-too-low', role: candidate };
  }

  // 6. per-user, per-command block
  const blocked = Array.isArray(user?.blockedCommands) ? user.blockedCommands : [];
  if (blocked.map((c) => String(c).toLowerCase()).includes(String(command).toLowerCase())) {
    return { allowed: false, reason: 'blocked-command', role: candidate };
  }

  return { allowed: true, reason: 'ok', role: candidate };
}

module.exports = { canRun };
