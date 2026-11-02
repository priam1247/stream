'use strict';

/**
 * commands/_template/logic.js — the command's own code, no ctx, no sending.
 *
 * Keeping the pure part separate is what makes check.js able to test the real
 * path instead of a copy of it.
 */

function run(input) {
  return `Echo: ${input}`;
}

module.exports = { run };
