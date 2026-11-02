'use strict';

/**
 * test/boot.test.js — the process must stay up.
 *
 * This exists because of a real outage: with no linked numbers, nothing held the
 * event loop open, so Node exited 0 immediately after boot. A panel reads exit 0
 * as "crashed" and refuses to restart, so the bot appeared dead forever.
 *
 * These tests start the real entry point as a child process and assert on what a
 * panel would see.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Make a throwaway copy of the tree with no sessions and no storage. */
function freshTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-boot-'));
  for (const name of ['gateway', 'lib', 'commands', 'sessions', 'logs']) {
    const from = path.join(ROOT, name);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dir, name), {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}sessions${path.sep}linked${path.sep}`),
    });
  }
  fs.mkdirSync(path.join(dir, 'sessions', 'linked'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  // Reuse the installed dependencies instead of copying ~200 MB.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'index.js'), path.join(dir, 'index.js'));
  return dir;
}

function runBoot(dir, { ms = 4000, env = {}, args = ['--expose-gc', 'index.js'] } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: dir,
      env: { ...process.env, PAIR_NUMBER: '', LOG_LEVEL: 'info', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    const timer = setTimeout(() => {
      // Still running after the window: that is the pass condition.
      child.kill('SIGTERM');
      resolve({ alive: true, code: null, out });
    }, ms);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ alive: false, code, out });
    });
  });
}

test('the bot stays running with no linked numbers at all', async () => {
  const dir = freshTree();
  const result = await runBoot(dir);

  assert.equal(result.alive, true,
    `the process exited on its own (code ${result.code}). A panel reads that as a crash.\n${result.out}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('boot says something on the console when there is nothing to connect', async () => {
  const dir = freshTree();
  const result = await runBoot(dir);
  assert.match(result.out, /PAIR_NUMBER is not set/, `the panel showed nothing useful:\n${result.out}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('boot warns when no owner is set', async () => {
  const dir = freshTree();
  const result = await runBoot(dir);
  assert.match(result.out, /no owner set/, `the owner warning never reached the console:\n${result.out}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('node . stays up (package.json main)', async () => {
  // `node .` resolves package.json "main" -> index.js. It used to exit 0 because
  // the wrapper only *required* the gateway and boot never ran.
  const dir = freshTree();
  const result = await runBoot(dir, { args: ['.'] });
  assert.equal(result.alive, true, `node . exited with ${result.code}; a panel calls that a crash`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pm2-style start of gateway/index.js stays up', async () => {
  // ecosystem.config.js points straight at gateway/index.js: that path must also
  // boot, not just sit there.
  const dir = freshTree();
  const result = await runBoot(dir, { args: ['--expose-gc', 'gateway/index.js'] });
  assert.equal(result.alive, true, `direct gateway start exited with ${result.code}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dead owner cannot be the reason the bot stays up', async () => {
  // The service-lifetime timer is what holds the loop open. Prove it is not
  // accidentally leaning on a socket or the dashboard.
  const dir = freshTree();
  const result = await runBoot(dir, { env: { DASHBOARD_URL: '', BOT_SYNC_TOKEN: '' } });
  assert.equal(result.alive, true, 'nothing else is holding the loop open');
  fs.rmSync(dir, { recursive: true, force: true });
});
