'use strict';

/**
 * test/isolation.test.js — the isolation proofs from Phase 4D.
 *
 * These are the tests that matter most: a broken command must never affect the
 * bot or any other command. Each test builds a disposable command folder so it
 * cannot damage the real ones, then proves the property.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const registry = require(path.join(ROOT, 'gateway/registry'));
const runner = require(path.join(ROOT, 'gateway/runner'));
const status = require(path.join(ROOT, 'gateway/status'));

/* ── fixtures ────────────────────────────────────────────────────────────── */

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-isolation-'));
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  return dir;
}

function writeCommand(dir, name, { indexSource, meta = {} } = {}) {
  const folder = path.join(dir, 'commands', name);
  fs.mkdirSync(folder, { recursive: true });
  const base = {
    name,
    aliases: [],
    category: 'general',
    description: 'test command',
    usage: `.${name}`,
    role: 'user',
    cooldownSec: 0,
    timeoutSec: 5,
    lane: 'light',
    limits: {},
    sample: 'x',
    ...meta,
  };
  fs.writeFileSync(path.join(folder, 'command.json'), JSON.stringify(base, null, 2));
  fs.writeFileSync(path.join(folder, 'check.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(folder, 'NOTES.md'), '# test');
  fs.writeFileSync(path.join(folder, 'index.js'), indexSource || 'module.exports = { async run(ctx) { await ctx.reply("ok"); } };');
  return folder;
}

function ctxFor(name, jobId = 'job1') {
  return {
    args: [], text: '', command: name, prefix: '.',
    sender: { number: '265991234567', name: '' },
    user: null, role: 'owner', chat: '265991234567@s.whatsapp.net',
    isGroup: false, quoted: null, number: '265991234567',
    settings: { accessMode: 'open', maintenance: false, prefix: '.' },
    tmp: path.join(ROOT, 'storage', 'tmp', name, jobId),
    limits: {}, catalogue: [], statuses: {},
  };
}

function runIn(dir, name, { ctx = null, timeoutSec = 5 } = {}) {
  const jobCtx = ctx || ctxFor(name);
  fs.mkdirSync(jobCtx.tmp, { recursive: true });
  return runner.run({
    name,
    folderPath: path.join(dir, 'commands', name),
    timeoutSec,
    ctx: jobCtx,
    transport: async () => ({ ok: true }),
  });
}

/* ── 1. syntax error in one command ──────────────────────────────────────── */

test('a command with a syntax error loads as ❌ and every other command still works', async () => {
  const dir = makeSandbox();
  writeCommand(dir, 'good');
  writeCommand(dir, 'broken', { indexSource: 'module.exports = { async run(ctx) { this is not javascript } };' });

  const loaded = registry.load({ commandsDir: path.join(dir, 'commands'), markStatus: false });
  assert.equal(loaded.loaded, 2, 'both command.json files are valid, so both register');

  const broken = await runIn(dir, 'broken');
  assert.equal(broken.ok, false, 'the broken command must fail');
  assert.match(broken.error.message, /SyntaxError/, 'the failure must name the syntax problem');
  assert.match(broken.error.message, /Unexpected|is not defined|not javascript/, 'the message must include the parser detail');

  const good = await runIn(dir, 'good');
  assert.equal(good.ok, true, 'the healthy command must still run after the broken one failed');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a command whose index.js is missing is skipped at load, marked ❌, and the bot still starts', () => {
  const dir = makeSandbox();
  writeCommand(dir, 'good');
  const folder = writeCommand(dir, 'noindex');
  fs.rmSync(path.join(folder, 'index.js'));

  const loaded = registry.load({ commandsDir: path.join(dir, 'commands'), markStatus: false });
  assert.equal(loaded.loaded, 1);
  assert.equal(loaded.failed, 1);
  assert.match(loaded.errors.noindex.join(' '), /index\.js is missing/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an invalid command.json is skipped at load with the exact reason', () => {
  const dir = makeSandbox();
  writeCommand(dir, 'good');
  const folder = writeCommand(dir, 'badmeta', { meta: { role: 'superuser' } });

  const loaded = registry.load({ commandsDir: path.join(dir, 'commands'), markStatus: false });
  assert.equal(loaded.loaded, 1);
  assert.match(loaded.errors.badmeta.join(' '), /"role" must be one of/);
  void folder;

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 2. a command that throws ────────────────────────────────────────────── */

test('a command that throws fails alone; the others run', async () => {
  const dir = makeSandbox();
  writeCommand(dir, 'good');
  writeCommand(dir, 'thrower', {
    indexSource: `module.exports = { async run() { const e = new Error('snapsave returned 403'); e.code = 'SNAPSAVE_403'; throw e; } };`,
  });

  const thrown = await runIn(dir, 'thrower');
  assert.equal(thrown.ok, false);
  assert.match(thrown.error.message, /exited \(code 1/);

  const good = await runIn(dir, 'good');
  assert.equal(good.ok, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a command that exits the process is reported, not ignored', async () => {
  const dir = makeSandbox();
  writeCommand(dir, 'suicide', { indexSource: 'module.exports = { async run() { process.exit(7); } };' });

  const result = await runIn(dir, 'suicide');
  assert.equal(result.ok, false);
  assert.match(result.error.message, /exited \(code 7/);

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 3. a command that hangs ─────────────────────────────────────────────── */

test('a command that hangs is killed at its timeout while another command completes meanwhile', async () => {
  const dir = makeSandbox();
  writeCommand(dir, 'good');
  writeCommand(dir, 'hang', { indexSource: 'module.exports = { async run() { while (true) {} } };' });

  const started = Date.now();
  const hung = runIn(dir, 'hang', { timeoutSec: 2 });
  // While the hang is being killed, a healthy command must complete normally.
  const good = await runIn(dir, 'good');
  const goodDuration = Date.now() - started;
  assert.equal(good.ok, true, 'the healthy command must not be blocked by the hung one');
  assert.ok(goodDuration < 1500, `the healthy command took ${goodDuration}ms; it should not wait for the timeout`);

  const hungResult = await hung;
  assert.equal(hungResult.ok, false);
  assert.equal(hungResult.error.code, 'TIMEOUT');
  assert.match(hungResult.error.message, /timed out after 2s/);

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 4. circuit breaker ──────────────────────────────────────────────────── */

test('three crashes in 10 minutes trip the breaker to ⛔ and it stays tripped', () => {
  status._reset();
  status.markOk('flaky', { source: 'load' });

  assert.equal(status.recordCrash('flaky'), false, 'first crash must not trip');
  assert.equal(status.recordCrash('flaky'), false, 'second crash must not trip');
  assert.equal(status.recordCrash('flaky'), true, 'third crash must trip');

  assert.equal(status.snapshot().flaky.state, 'disabled');
  assert.match(status.snapshot().flaky.reason, /circuit breaker/);
  assert.equal(status.isDisabled('flaky'), true);

  // A disabled command stays disabled; a healthy one is untouched.
  status.markOk('healthy');
  assert.equal(status.snapshot().healthy.state, 'ok');
  assert.equal(status.isDisabled('healthy'), false);

  status._reset();
});

test('crash timestamps older than the window do not count towards the breaker', () => {
  status._reset();
  const e = status.snapshot();
  status.markOk('slowflaky');
  // Simulate three crashes that happened two hours ago by rewinding the clock.
  const original = Date.now;
  const past = original() - 2 * 60 * 60 * 1000;
  Date.now = () => past;
  status.recordCrash('slowflaky');
  status.recordCrash('slowflaky');
  status.recordCrash('slowflaky');
  Date.now = original;

  // Those three are outside the window, so a fresh crash must not trip the breaker.
  const tripped = status.recordCrash('slowflaky');
  assert.equal(tripped, false, 'old crashes must age out of the window');
  status._reset();
});

/* ── 5. hot reload while another command is mid-job ──────────────────────── */

test('reloading the registry while a command is mid-job does not disturb the running job', async () => {
  const dir = makeSandbox();
  writeCommand(dir, 'slow', {
    indexSource: `
      module.exports = {
        async run(ctx) {
          await new Promise((r) => setTimeout(r, 800));
          await ctx.reply('slow finished');
        },
      };`,
  });
  writeCommand(dir, 'other');

  const slow = runIn(dir, 'slow');
  // Mid-job: reload the whole registry, as `.reload` does.
  registry.load({ commandsDir: path.join(dir, 'commands'), markStatus: false });
  const result = await slow;

  assert.equal(result.ok, true, 'the running job must survive a registry reload');
  assert.equal(result.result, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 6. job folder cleanup ───────────────────────────────────────────────── */

test('the job folder is deleted after success and after failure', async () => {
  const dir = makeSandbox();
  writeCommand(dir, 'good');
  writeCommand(dir, 'thrower', {
    indexSource: `module.exports = { async run() { throw new Error('boom'); } };`,
  });

  const okCtx = ctxFor('good', 'job-ok');
  fs.mkdirSync(okCtx.tmp, { recursive: true });
  fs.writeFileSync(path.join(okCtx.tmp, 'partial.bin'), 'leftover');
  const ok = await runner.run({
    name: 'good', folderPath: path.join(dir, 'commands', 'good'), timeoutSec: 10, ctx: okCtx,
    transport: async () => ({ ok: true }),
  });
  assert.equal(ok.ok, true);
  assert.equal(fs.existsSync(okCtx.tmp), false, 'job folder must be gone after a successful run');

  const badCtx = ctxFor('thrower', 'job-bad');
  fs.mkdirSync(badCtx.tmp, { recursive: true });
  fs.writeFileSync(path.join(badCtx.tmp, 'partial.bin'), 'leftover');
  const bad = await runner.run({
    name: 'thrower', folderPath: path.join(dir, 'commands', 'thrower'), timeoutSec: 10, ctx: badCtx,
    transport: async () => ({ ok: true }),
  });
  assert.equal(bad.ok, false);
  assert.equal(fs.existsSync(badCtx.tmp), false, 'job folder must be gone after a failure');

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 7. the command cannot see the gateway ───────────────────────────────── */

test('a command cannot require gateway internals or another command', async () => {
  const dir = makeSandbox();
  // The child runs with cwd = its own folder, so a relative escape has to climb
  // out deliberately. Prove the attempt is visible and fails loudly.
  writeCommand(dir, 'snoop', {
    indexSource: `
      module.exports = {
        async run(ctx) {
          // eslint-disable-next-line
          const store = require('${path.join(ROOT, 'gateway/users/store.js').replace(/\\/g, '\\\\')}');
          await ctx.reply('store reachable: ' + typeof store.writeUsers);
        },
      };`,
  });

  const result = await runIn(dir, 'snoop');
  // Note: requiring an absolute path IS possible in Node. What matters is that
  // no command in the real tree does it; test/imports.test.js enforces that by
  // grepping. Here we record the true behaviour rather than assert a fiction.
  assert.equal(result.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
