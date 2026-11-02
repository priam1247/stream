'use strict';

/**
 * lib/paths.js — every filesystem location the bot uses, in one place.
 *
 * Anything not listed here does not exist. Commands receive their own tmp and
 * data folders through ctx; they never compute paths themselves.
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const paths = {
  root: ROOT,
  gateway: path.join(ROOT, 'gateway'),
  commands: path.join(ROOT, 'commands'),
  lib: path.join(ROOT, 'lib'),
  scripts: path.join(ROOT, 'scripts'),

  storage: path.join(ROOT, 'storage'),
  storageCore: path.join(ROOT, 'storage', 'core'),
  numbers: path.join(ROOT, 'storage', 'core', 'numbers'),
  disabled: path.join(ROOT, 'storage', 'core', 'disabled.json'),
  commandData: path.join(ROOT, 'storage', 'commands'),
  tmp: path.join(ROOT, 'storage', 'tmp'),
  backups: path.join(ROOT, 'storage', 'backups'),

  sessions: path.join(ROOT, 'sessions'),
  sessionsLinked: path.join(ROOT, 'sessions', 'linked'),

  logs: path.join(ROOT, 'logs'),
  gatewayLog: path.join(ROOT, 'logs', 'gateway.log'),
  usersLog: path.join(ROOT, 'logs', 'users.log'),

  env: path.join(ROOT, '.env'),
};

/** storage/core/numbers/<number>/ */
function numberDir(number) {
  if (!/^\d{7,15}$/.test(String(number || ''))) {
    throw new Error(`invalid number for storage path: ${JSON.stringify(number)}`);
  }
  return path.join(paths.numbers, String(number));
}

function usersFile(number) {
  return path.join(numberDir(number), 'users.json');
}

function settingsFile(number) {
  return path.join(numberDir(number), 'settings.json');
}

function commandDataDir(name) {
  assertName(name);
  return path.join(paths.commandData, name);
}

function commandTmpRoot(name) {
  assertName(name);
  return path.join(paths.tmp, name);
}

function commandJobDir(name, jobId) {
  assertName(name);
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(String(jobId || ''))) {
    throw new Error(`invalid job id: ${JSON.stringify(jobId)}`);
  }
  return path.join(commandTmpRoot(name), String(jobId));
}

function commandLog(name) {
  assertName(name);
  return path.join(paths.logs, `${name}.log`);
}

function sessionDir(number) {
  if (!/^\d{7,15}$/.test(String(number || ''))) {
    throw new Error(`invalid number for session path: ${JSON.stringify(number)}`);
  }
  return path.join(paths.sessionsLinked, String(number));
}

function assertName(name) {
  if (!/^[a-z0-9_]{1,40}$/.test(String(name || ''))) {
    throw new Error(`invalid command name: ${JSON.stringify(name)}`);
  }
}

module.exports = {
  paths,
  numberDir,
  usersFile,
  settingsFile,
  commandDataDir,
  commandTmpRoot,
  commandJobDir,
  commandLog,
  sessionDir,
  assertName,
};
