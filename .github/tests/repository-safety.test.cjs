const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('repository workflow runs checks only and never uploads or restarts a host', () => {
  const workflows = fs.readdirSync(path.join(root, '.github/workflows'));
  assert.deepEqual(workflows, ['ci.yml']);
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm run selftest/);
  assert.match(ci, /npm run test:sessions/);
  assert.match(ci, /npm run build/);
  assert.doesNotMatch(ci, /sftp|lftp|scp|ssh|rsync|panel_api_key|botkeep_api_key/i);
  assert.doesNotMatch(ci, /^\s*(?:deploy|upload|restart):/m);
});
