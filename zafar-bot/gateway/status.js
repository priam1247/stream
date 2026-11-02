'use strict';

/**
 * gateway/status.js — collects ✅ ❌ ⛔ per command and persists it.
 *
 * States:
 *   ok        ✅ its check.js passed, or a real run completed
 *   broken    ❌ check or a real run failed; carries the reason and last ok time
 *   disabled  ⛔ admin toggle, or the circuit breaker tripped
 *
 * Persistence: storage/core/status.json is written atomically. Storage failures
 * are logged and ignored — a status file must never take the bot down.
 */

const path = require('path');
const { paths } = require('../lib/paths');
const { writeJsonAtomic, readJsonSafe } = require('../lib/fsutil');
const { gatewayLog } = require('./log');

const FILE = path.join(paths.storageCore, 'status.json');
const BREAKER_WINDOW_MS = 10 * 60 * 1000;
const BREAKER_THRESHOLD = 3;

/** name -> { state, reason, lastOkAt, lastErrorAt, crashes:[ts], source } */
const state = new Map();

function load() {
  const res = readJsonSafe(FILE, { defaultValue: { commands: {} } });
  if (!res.ok) return;
  for (const [name, value] of Object.entries(res.data?.commands || {})) {
    state.set(name, {
      state: value.state || 'unknown',
      reason: value.reason || '',
      lastOkAt: value.lastOkAt || null,
      lastErrorAt: value.lastErrorAt || null,
      crashes: [],
      source: value.source || 'persisted',
    });
  }
}

function save() {
  const commands = {};
  for (const [name, value] of state.entries()) {
    commands[name] = {
      state: value.state,
      reason: value.reason,
      lastOkAt: value.lastOkAt,
      lastErrorAt: value.lastErrorAt,
      source: value.source,
    };
  }
  try {
    writeJsonAtomic(FILE, { commands, savedAt: new Date().toISOString() });
  } catch (err) {
    gatewayLog.warn('could not persist status.json', { error: err.message });
  }
}

function entry(name) {
  if (!state.has(name)) {
    state.set(name, { state: 'unknown', reason: '', lastOkAt: null, lastErrorAt: null, crashes: [], source: 'runtime' });
  }
  return state.get(name);
}

function markOk(name, { source = 'run' } = {}) {
  const e = entry(name);
  e.state = 'ok';
  e.reason = '';
  e.lastOkAt = new Date().toISOString();
  e.source = source;
  e.crashes = [];
  save();
}

function markBroken(name, reason, { source = 'run' } = {}) {
  const e = entry(name);
  e.state = 'broken';
  e.reason = String(reason || 'failed');
  e.lastErrorAt = new Date().toISOString();
  e.source = source;
  save();
}

function markDisabled(name, reason) {
  const e = entry(name);
  e.state = 'disabled';
  e.reason = reason || 'disabled';
  save();
}

function enable(name) {
  const e = entry(name);
  e.state = 'unknown';
  e.reason = '';
  e.crashes = [];
  save();
}

function isDisabled(name) {
  return entry(name).state === 'disabled';
}

/**
 * Circuit breaker. Returns true when the breaker has just tripped.
 * Only a real run failure counts; a policy refusal never does.
 */
function recordCrash(name) {
  const e = entry(name);
  const now = Date.now();
  e.crashes = [...(e.crashes || []).filter((ts) => now - ts < BREAKER_WINDOW_MS), now];
  entry(name);
  if (e.crashes.length >= BREAKER_THRESHOLD) {
    markDisabled(name, `circuit breaker: ${e.crashes.length} crashes in 10 minutes`);
    gatewayLog.error('circuit breaker tripped', { command: name, crashes: e.crashes.length });
    return true;
  }
  return false;
}

function snapshot() {
  const out = {};
  for (const [name, value] of state.entries()) {
    out[name] = {
      state: value.state,
      reason: value.reason,
      lastOkAt: value.lastOkAt,
      lastErrorAt: value.lastErrorAt,
      source: value.source,
    };
  }
  return out;
}

function _reset() {
  state.clear();
}

module.exports = {
  FILE,
  BREAKER_THRESHOLD,
  BREAKER_WINDOW_MS,
  load,
  save,
  markOk,
  markBroken,
  markDisabled,
  enable,
  isDisabled,
  recordCrash,
  snapshot,
  _reset,
};
