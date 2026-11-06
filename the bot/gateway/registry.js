'use strict';

/**
 * Command registry — scans commands/<folder>/index.js and isolates each folder.
 *
 *  - A folder that fails to load is skipped and marked broken; the rest load.
 *  - A folder may export one command or an array of commands.
 *  - Switching off is per COMMAND (`.off ig` stops .ig/.instagram only, not
 *    .tiktok or .fb that live in the same folder). The state survives restarts
 *    (database/disabled-commands.json). `.off <folder>` switches off every
 *    command in that folder.
 *  - Circuit breaker: 3 CONSECUTIVE crashes/timeouts of one command within
 *    10 minutes switch that command off. A success resets the count, so a
 *    flaky command that mostly works is never switched off.
 *  - The commands that control the bot (.on/.off/.status/.restart) can never
 *    be switched off, by hand or by the breaker, so you can always recover.
 *  - board() reports every folder as ok / partial / broken / disabled.
 *
 * Nothing here ever substitutes a backup implementation: a broken command
 * stays broken, visibly, until it is fixed.
 */

const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('../lib/jsonStore');

const COMMANDS_DIR = path.join(__dirname, '..', 'commands');
const STATE_FILE = path.join(__dirname, '..', 'database', 'disabled-commands.json');
const BREAKER_LIMIT = 3;
const BREAKER_WINDOW_MS = 10 * 60 * 1000;
const PROTECTED = new Set(['on', 'off', 'status', 'restart']);

const folders = new Map();   // folder -> { names: [], state, reason, loadedAt }
const owners = new Map();    // trigger (name or alias) -> folder
const canon = new Map();     // trigger -> canonical command name
const failures = new Map();  // canonical name -> consecutive-failure timestamps

const validState = (d) => Boolean(d && typeof d === 'object' && d.disabled && typeof d.disabled === 'object');
function readState() {
  const res = readJsonSafe(STATE_FILE, { defaultValue: { disabled: {} }, validate: validState });
  return res.ok ? res.data : { disabled: {} };
}
function writeState(state) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); writeJsonAtomic(STATE_FILE, state); }
  catch (err) { console.error(`[registry] could not save command state: ${err.message}`); }
}

function loadFolder(name, commands) {
  const entry = path.join(COMMANDS_DIR, name, 'index.js');
  const info = { names: [], state: 'ok', reason: '', loadedAt: Date.now() };
  folders.set(name, info);
  if (!fs.existsSync(entry)) { info.state = 'broken'; info.reason = 'index.js missing'; return; }
  try {
    const exported = require(entry);
    const list = Array.isArray(exported) ? exported : [exported];
    for (const command of list) {
      if (!command || !command.name) continue;
      if (typeof command.execute !== 'function') throw new Error(`.${command.name} has no execute()`);
      commands.set(command.name, command);
      owners.set(command.name, name);
      canon.set(command.name, command.name);
      info.names.push(command.name);
      for (const alias of command.aliases || []) {
        commands.set(alias, command);
        owners.set(alias, name);
        canon.set(alias, command.name);
      }
    }
    if (!info.names.length) throw new Error('no command exported');
  } catch (error) {
    info.state = 'broken';
    info.reason = String(error?.message || error).slice(0, 300);
    console.error(`Error loading command folder "${name}": ${info.reason}`);
  }
}

const loadCommands = () => {
  const commands = new Map();
  folders.clear();
  owners.clear();
  canon.clear();
  if (!fs.existsSync(COMMANDS_DIR)) {
    console.log('Commands directory not found');
    return commands;
  }
  for (const name of fs.readdirSync(COMMANDS_DIR).sort()) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    if (!fs.statSync(path.join(COMMANDS_DIR, name)).isDirectory()) continue;
    loadFolder(name, commands);
  }
  return commands;
};

/**
 * Reload ONE command folder from disk without touching any other command.
 * Mutates the live `commands` map: the folder's old names are removed first,
 * then whatever loads cleanly is registered again.
 */
function reloadFolder(nameOrFolder, commands) {
  const key = String(nameOrFolder || '').toLowerCase();
  const folder = folders.has(key) ? key : (owners.get(key) || (fs.existsSync(path.join(COMMANDS_DIR, key, 'index.js')) ? key : null));
  if (!folder) return null;
  for (const [trigger, owner] of [...owners.entries()]) {
    if (owner === folder) { owners.delete(trigger); canon.delete(trigger); commands.delete(trigger); }
  }
  const prefix = path.join(COMMANDS_DIR, folder) + path.sep;
  for (const mod of Object.keys(require.cache)) if (mod.startsWith(prefix)) delete require.cache[mod];
  loadFolder(folder, commands);
  for (const name of folders.get(folder).names) failures.delete(name);
  return { folder, ...folders.get(folder) };
}

/** Folder that owns a command name or alias. */
const folderOf = (trigger) => owners.get(String(trigger || '').toLowerCase()) || null;

/** Canonical command names a user-supplied target refers to (a trigger, or a whole folder). */
function targetsOf(target) {
  const key = String(target || '').replace(/^\./, '').toLowerCase();
  if (canon.has(key)) return [canon.get(key)];
  if (folders.has(key)) return [...folders.get(key).names];
  return [];
}

function disabledInfo(trigger) {
  const key = String(trigger || '').toLowerCase();
  const name = canon.get(key) || key;
  const disabled = readState().disabled;
  return disabled[name] || null;
}

/** Switch commands off. Returns { names, skipped } or null when the target is unknown. */
function disable(target, reason = 'owner') {
  const names = targetsOf(target);
  if (!names.length) return null;
  const skipped = names.filter((n) => PROTECTED.has(n));
  const todo = names.filter((n) => !PROTECTED.has(n));
  if (todo.length) {
    const state = readState();
    for (const n of todo) state.disabled[n] = { reason, at: new Date().toISOString() };
    writeState(state);
  }
  return { names: todo, skipped };
}

/** Switch commands back on. Returns the names switched on, or null when the target is unknown. */
function enable(target) {
  const names = targetsOf(target);
  if (!names.length) return null;
  const state = readState();
  for (const n of names) { delete state.disabled[n]; failures.delete(n); }
  writeState(state);
  return names;
}

/** A command finished without crashing: the consecutive-failure count starts over. */
function recordSuccess(trigger) {
  const name = canon.get(String(trigger || '').toLowerCase());
  if (name) failures.delete(name);
}

/** Record a crash/timeout. Returns true when the breaker just switched the command off. */
function recordFailure(trigger, now = Date.now()) {
  const name = canon.get(String(trigger || '').toLowerCase());
  if (!name || PROTECTED.has(name)) return false;
  const recent = (failures.get(name) || []).filter((t) => now - t < BREAKER_WINDOW_MS);
  recent.push(now);
  failures.set(name, recent);
  if (recent.length >= BREAKER_LIMIT && !disabledInfo(name)) {
    disable(name, 'breaker');
    return true;
  }
  return false;
}

/** One row per command folder: ok / partial / broken / disabled. */
function board() {
  const disabled = readState().disabled;
  return [...folders.entries()].map(([folder, info]) => {
    if (info.state === 'broken') return { folder, commands: info.names, state: 'broken', reason: info.reason, off: [] };
    const off = info.names.filter((n) => disabled[n]);
    const state = !off.length ? 'ok' : off.length === info.names.length ? 'disabled' : 'partial';
    return { folder, commands: info.names, state, reason: off.length ? disabled[off[0]].reason : '', off };
  });
}

module.exports = {
  loadCommands, reloadFolder, folderOf, targetsOf, disable, enable, disabledInfo,
  recordFailure, recordSuccess, board, PROTECTED,
  BREAKER_LIMIT, BREAKER_WINDOW_MS, STATE_FILE,
};
