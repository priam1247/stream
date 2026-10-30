'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startSessionServices } = require('../utils/serviceStartup');

test('failed session startup cleans up before retry and never starts a bridge', async () => {
  const events = [];
  const failing = { start: async () => { events.push('start'); throw new Error('failed'); }, stop: async () => events.push('stop') };
  await assert.rejects(startSessionServices(failing, async () => events.push('bridge'), async () => events.push('cleanup')), /failed/);
  assert.deepEqual(events, ['start', 'stop', 'cleanup']);
  const next = { start: async () => events.push('retry'), stop: async () => events.push('stop-retry') };
  await startSessionServices(next, async () => events.push('bridge'));
  assert.deepEqual(events, ['start', 'stop', 'cleanup', 'retry', 'bridge']);
});

test('a bridge failure stops already started sessions', async () => {
  const events = [];
  const sessions = { start: async () => events.push('start'), stop: async () => events.push('stop') };
  await assert.rejects(startSessionServices(sessions, async () => { events.push('bridge'); throw new Error('bridge failed'); }), /bridge failed/);
  assert.deepEqual(events, ['start', 'bridge', 'stop']);
});
