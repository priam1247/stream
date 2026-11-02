'use strict';

/**
 * gateway/registry.js — scans commands/, validates command.json, holds state.
 *
 * A command with a broken file or an invalid command.json is SKIPPED, marked ❌,
 * and the bot still starts. That is the whole point: one bad folder must never
 * stop the rest.
 *
 * Nothing in here requires a command's index.js. Loading command code is the
 * runner's job, in a child process, so a top-level throw in a command cannot
 * take the gateway down.
 */

const fs = require('fs');
const path = require('path');
const { paths } = require('../lib/paths');
const status = require('./status');
const { gatewayLog } = require('./log');
const { isValidRole, ROLES } = require('./users/roles');

const NAME_RE = /^[a-z0-9_]{1,40}$/;
const ROLE_VALUES = new Set(['user', 'admin', 'owner']);
const LANES = new Set(['light', 'heavy', 'single']);

const REQUIRED = [
  'name', 'aliases', 'category', 'description', 'usage',
  'role', 'cooldownSec', 'timeoutSec', 'lane', 'limits', 'sample',
];

/** @type {Map<string, object>} primary name -> entry */
const byName = new Map();
/** @type {Map<string, object>} alias or name -> entry */
const byTrigger = new Map();
/** @type {Map<string, string>} command folder -> load error */
const loadErrors = new Map();

function validateMeta(meta, folder) {
  const problems = [];
  if (!meta || typeof meta !== 'object') return ['command.json must be an object'];

  for (const key of REQUIRED) {
    if (meta[key] === undefined) problems.push(`missing "${key}"`);
  }
  if (meta.name !== undefined && !NAME_RE.test(String(meta.name))) {
    problems.push(`"name" must match ${NAME_RE}`);
  }
  if (meta.name !== undefined && String(meta.name) !== folder) {
    problems.push(`"name" (${meta.name}) must equal the folder name (${folder})`);
  }
  if (meta.aliases !== undefined && !Array.isArray(meta.aliases)) {
    problems.push('"aliases" must be an array');
  }
  if (Array.isArray(meta.aliases)) {
    for (const alias of meta.aliases) {
      if (!NAME_RE.test(String(alias))) problems.push(`bad alias: ${JSON.stringify(alias)}`);
    }
  }
  if (meta.role !== undefined && !ROLE_VALUES.has(meta.role)) {
    problems.push(`"role" must be one of ${[...ROLE_VALUES].join(', ')}`);
  }
  if (meta.cooldownSec !== undefined && !(Number.isFinite(meta.cooldownSec) && meta.cooldownSec >= 0)) {
    problems.push('"cooldownSec" must be a number >= 0');
  }
  if (meta.timeoutSec !== undefined && !(Number.isFinite(meta.timeoutSec) && meta.timeoutSec > 0)) {
    problems.push('"timeoutSec" must be a number > 0');
  }
  if (meta.lane !== undefined && !LANES.has(meta.lane)) {
    problems.push(`"lane" must be one of ${[...LANES].join(', ')}`);
  }
  if (meta.limits !== undefined && (typeof meta.limits !== 'object' || Array.isArray(meta.limits))) {
    problems.push('"limits" must be an object');
  }
  // `sample` may be empty for commands that take no arguments (.ping, .status)
  // or only an optional one (.menu [section]). A mandatory `<arg>` needs a
  // sample, otherwise its check.js would be testing nothing.
  if (meta.sample !== undefined && typeof meta.sample !== 'string') {
    problems.push('"sample" must be a string');
  }
  if (meta.sample !== undefined && typeof meta.sample === 'string'
    && !meta.sample.trim() && /<[^>]+>/.test(String(meta.usage || ''))) {
    problems.push('"sample" must be non-empty for a command that takes an argument');
  }
  return problems;
}

function checkFiles(folderPath) {
  const index = path.join(folderPath, 'index.js');
  if (!fs.existsSync(index)) return ['index.js is missing'];
  if (!fs.existsSync(path.join(folderPath, 'check.js'))) return ['check.js is missing'];
  // NOTES.md used to be required here. It was documentation nothing read, and the
  // project has a hard file-count ceiling, so the requirement is gone. Any
  // NOTES.md that still exists is simply ignored.
  return [];
}

function register(entry) {
  byName.set(entry.name, entry);
  byTrigger.set(entry.name, entry);
  for (const alias of entry.meta.aliases) byTrigger.set(alias, entry);
}

/**
 * @returns {{loaded:number, failed:number, errors:Object<string,string[]>}}
 */
function load({ commandsDir = paths.commands, markStatus = true } = {}) {
  byName.clear();
  byTrigger.clear();
  loadErrors.clear();

  if (!fs.existsSync(commandsDir)) {
    gatewayLog.error('commands directory is missing', { commandsDir });
    return { loaded: 0, failed: 0, errors: {} };
  }

  const folders = fs.readdirSync(commandsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !name.startsWith('_'))
    .sort();

  const errors = {};
  for (const folder of folders) {
    const folderPath = path.join(commandsDir, folder);
    const metaPath = path.join(folderPath, 'command.json');

    if (!fs.existsSync(metaPath)) {
      errors[folder] = ['command.json is missing'];
      loadErrors.set(folder, errors[folder]);
      continue;
    }

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (err) {
      errors[folder] = [`command.json is not valid JSON: ${err.message}`];
      loadErrors.set(folder, errors[folder]);
      continue;
    }

    const problems = [...validateMeta(meta, folder), ...checkFiles(folderPath)];
    if (problems.length) {
      errors[folder] = problems;
      loadErrors.set(folder, problems);
      continue;
    }

    register({ folder, folderPath, name: meta.name, meta });
  }

  // Duplicate detection must run after registration so it sees every alias.
  const seen = new Map();
  const duplicates = [];
  for (const [trigger, entry] of byTrigger.entries()) {
    if (seen.has(trigger) && seen.get(trigger) !== entry.name) {
      duplicates.push(`"${trigger}" claimed by both ${seen.get(trigger)} and ${entry.name}`);
    } else {
      seen.set(trigger, entry.name);
    }
  }
  if (duplicates.length) {
    // Ambiguous routing is worse than a missing command: refuse to start with it.
    throw new Error(`duplicate command names or aliases:\n  ${duplicates.join('\n  ')}`);
  }

  if (markStatus) {
    status.load();
    for (const name of byName.keys()) {
      const current = status.snapshot()[name];
      if (!current || current.state === 'unknown') status.markOk(name, { source: 'loaded' });
      else if (current.state === 'ok' && current.source === 'loaded') status.markOk(name, { source: 'loaded' });
    }
    for (const [folder, problems] of Object.entries(errors)) {
      status.markBroken(folder, problems.join('; '), { source: 'load' });
      gatewayLog.error('command skipped at load', { command: folder, problems });
    }
  }

  return { loaded: byName.size, failed: Object.keys(errors).length, errors };
}

function get(trigger) {
  return byTrigger.get(String(trigger || '').toLowerCase()) || null;
}

function list() {
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function names() {
  return [...byName.keys()].sort();
}

function triggers() {
  return [...byTrigger.keys()].sort();
}

function loadErrorFor(folder) {
  return loadErrors.get(folder) || null;
}

function _clear() {
  byName.clear();
  byTrigger.clear();
  loadErrors.clear();
}

module.exports = {
  load,
  get,
  list,
  names,
  triggers,
  loadErrorFor,
  validateMeta,
  REQUIRED,
  ROLE_VALUES,
  ROLES,
  _clear,
};
