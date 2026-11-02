/**
 * Track active media work without making commands wait for a lane.
 *
 * Downloads reserve disk independently. When memory is critically low we
 * reject immediately rather than silently queue a user behind other jobs.
 */
'use strict';

const os = require('os');
const config = require('../config');

const lanes = { light: 0, heavy: 0, search: 0 };

async function runInLane(name, fn) {
  if (!Object.hasOwn(lanes, name)) throw new Error(`unknown job lane: ${name}`);
  if (typeof fn !== 'function') throw new TypeError('job must be a function');

  const minimum = Math.max(0, Number(config.queue?.minFreeMB) || 0) * 1024 * 1024;
  let free = null;
  try { free = os.freemem(); } catch { /* no reliable measurement */ }
  if (minimum && Number.isFinite(free) && free < minimum) {
    throw Object.assign(new Error('not enough memory to start this request'), { code: 'NOT_ENOUGH_MEMORY' });
  }

  lanes[name]++;
  try { return await fn(); }
  finally { lanes[name]--; }
}

function stats() {
  return Object.fromEntries(Object.entries(lanes).map(([name, running]) => [
    name, { running, waiting: 0, active: running, queued: 0 },
  ]));
}

module.exports = { runInLane, stats };
