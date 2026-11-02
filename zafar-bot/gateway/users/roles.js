'use strict';

/**
 * gateway/users/roles.js — owner > admin > user > banned.
 *
 * "banned" is a status, not a rank, but it is expressed as a role so a single
 * comparison answers "may this person run a command that needs role X".
 */

const RANK = {
  banned: 0,
  user: 1,
  admin: 2,
  owner: 3,
};

const ROLES = Object.keys(RANK);

function rank(role) {
  return RANK[role] ?? 0;
}

function isValidRole(role) {
  return Object.prototype.hasOwnProperty.call(RANK, role);
}

/** Does `role` satisfy `required`? */
function atLeast(role, required) {
  return rank(role) >= rank(required);
}

function isBanned(role) {
  return role === 'banned';
}

function isStaff(role) {
  return atLeast(role, 'admin');
}

module.exports = { RANK, ROLES, rank, isValidRole, atLeast, isBanned, isStaff };
