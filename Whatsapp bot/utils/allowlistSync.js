/**
 * Compatibility wrapper for `utils/dashboardSync.js`.
 * Kept in-tree for existing imports and manually updated installations.
 */

'use strict';

const { startDashboardSync, triggerImmediateSync } = require('./dashboardSync');

function startAllowlistSync(opts = {}) {
  return startDashboardSync(opts);
}

module.exports = { startAllowlistSync, triggerImmediateSync };
