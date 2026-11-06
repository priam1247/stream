'use strict';

// Offline regression tests for account-scoped delivery and restart recovery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-delivery-'));
const ROOT = createBotFixture(TMP);
const botRequire = createRequire(path.join(ROOT, 'scripts', 'test-delivery.js'));
process.chdir(TMP);
process.env.JOBS_DB = path.join(TMP, 'jobs.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JOBS_MIN_FREE_MB = '0';
process.env.INLINE_LIMIT = '104857600';
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });

const jobs = botRequire('../lib/persistentJobs');
const sockets = botRequire('../lib/accountSockets');
const delivery = botRequire('../lib/jobDelivery');
const temp = botRequire('../lib/tempManager');
const cleanup = botRequire('../lib/cleanup');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, ms = 2500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('timed out waiting for delivery');
}

jobs._setInspectorForTests(() => ({ effectiveFreeMB: 10000 }));
jobs.start({
  pollMs: 10,
  run: async (_provider, req) => {
    if (req.fail) throw new Error('a private diagnostic');
    fs.writeFileSync(req.file, 'test content');
    return { path: req.file, title: req.title || 'Example', size: 12, subs: [] };
  },
});
delivery.start();

test.after(async () => {
  await jobs.stop();
  jobs._resetForTests({ removeDb: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('offline and paused accounts retain their files and deliver only through the originating account', async () => {
  const primaryMessages = [];
  const linkedMessages = [];
  let allowed = false;
  const primary = { sendMessage: async (...args) => { primaryMessages.push(args); } };
  const linked = { __canRespond: () => allowed, sendMessage: async (...args) => { linkedMessages.push(args); } };
  sockets.setOnline('primary', primary);
  const file = path.join(process.env.MEDIA_DIR, 'movie_offline.bin');
  const id = jobs.enqueue({ provider: 'generic', req: { sessionId: 'linked:11111111', chatId: 'chat', file, title: 'A Bot Called Zafar' } });
  await waitFor(() => jobs.get(id)?.status === 'pending_delivery');
  assert.equal(temp.isHeld(file), true);
  sockets.setOnline('linked:11111111', linked);
  delivery.resumePending();
  await delay(30);
  assert.equal(linkedMessages.length, 0);
  assert.equal(primaryMessages.length, 0);
  assert.equal(fs.existsSync(file), true);
  allowed = true;
  sockets.setOnline('linked:11111111', linked);
  await waitFor(() => jobs.get(id)?.status === 'done');
  assert.equal(linkedMessages.length, 1);
  assert.equal(primaryMessages.length, 0);
  assert.match(linkedMessages[0][1].caption, /A Bot Called Zafar/, 'user-supplied titles must not be rewritten');
  assert.equal(fs.existsSync(file), false);
  assert.equal(temp.isHeld(file), false);
  delivery.resumePending(); delivery.resumePending();
  await delay(20);
  assert.equal(linkedMessages.length, 1);
  sockets.setOffline('primary', primary);
  sockets.setOffline('linked:11111111', linked);
});

test('delivered legacy jobs never unlink files through a symlinked parent outside the media root', async () => {
  const outside = fs.mkdtempSync(path.join(TMP, 'outside-media-'));
  const link = path.join(process.env.MEDIA_DIR, 'escape');
  fs.symlinkSync(outside, link, 'dir');
  const file = path.join(link, 'victim.bin');
  const sock = { sendMessage: async () => ({}) };
  sockets.setOnline('linked:55555555', sock);
  try {
    const id = jobs.enqueue({ provider: 'generic', req: { sessionId: 'linked:55555555', chatId: 'chat', file } });
    await waitFor(() => jobs.get(id)?.status === 'done');
    assert.equal(fs.existsSync(path.join(outside, 'victim.bin')), true);
  } finally { sockets.setOffline('linked:55555555', sock); }
});

test('failed sends are retried without duplicating a concurrent delivery', async () => {
  const file = path.join(process.env.MEDIA_DIR, 'movie_retry.bin');
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sock = { sendMessage: async () => {
    calls++;
    if (calls === 1) throw new Error('temporary network failure');
    await gate;
  } };
  sockets.setOnline('linked:22222222', sock);
  const id = jobs.enqueue({ provider: 'generic', req: { sessionId: 'linked:22222222', chatId: 'chat', file } });
  await waitFor(() => calls === 1);
  assert.equal(jobs.get(id).status, 'pending_delivery');
  assert.equal(fs.existsSync(file), true);
  delivery.resumePending();
  await waitFor(() => calls === 2);
  delivery.resumePending(); delivery.resumePending();
  await delay(15);
  assert.equal(calls, 2);
  release();
  await waitFor(() => jobs.get(id).status === 'done');
  assert.equal(fs.existsSync(file), false);
  sockets.setOffline('linked:22222222', sock);
});

test('terminal failures wait for the right account; legacy jobs use only the primary', async () => {
  const primaryMessages = [];
  const linkedMessages = [];
  const primary = { sendMessage: async (...args) => primaryMessages.push(args) };
  const linked = { sendMessage: async (...args) => linkedMessages.push(args) };
  sockets.setOnline('primary', primary);
  const failed = jobs.enqueue({ provider: 'generic', req: { sessionId: 'linked:33333333', chatId: 'chat', fail: true } });
  await waitFor(() => jobs.get(failed)?.status === 'pending_failure');
  assert.equal(primaryMessages.length, 0);
  sockets.setOnline('linked:33333333', linked);
  await waitFor(() => jobs.get(failed)?.status === 'dead');
  assert.equal(linkedMessages.length, 1);
  assert.doesNotMatch(linkedMessages[0][1].text, /private diagnostic/);
  const file = path.join(process.env.MEDIA_DIR, 'movie_legacy.bin');
  const legacy = jobs.enqueue({ provider: 'generic', req: { chatId: 'legacy-chat', file } });
  await waitFor(() => jobs.get(legacy)?.status === 'done');
  assert.equal(primaryMessages.length, 1);
  assert.equal(primaryMessages[0][0], 'legacy-chat');
  assert.equal(linkedMessages.length, 1);
  sockets.setOffline('primary', primary);
  sockets.setOffline('linked:33333333', linked);
});

test('all pending files are protected, including entries beyond 500', () => {
  const raw = new DatabaseSync(process.env.JOBS_DB);
  const insert = raw.prepare("INSERT INTO jobs (provider, req, status, result, created_at) VALUES ('generic', ?, 'pending_delivery', ?, ?)");
  const files = [];
  raw.exec('BEGIN');
  for (let i = 0; i < 510; i++) {
    const file = path.join(process.env.MEDIA_DIR, `movie_bulk_${i}.mp4`);
    fs.writeFileSync(file, 'x');
    files.push(file);
    insert.run(JSON.stringify({ chatId: 'chat', sessionId: `offline:${i}` }), JSON.stringify({ path: file }), Date.now());
  }
  raw.exec('COMMIT');
  raw.close();
  delivery.protectPendingFiles();
  assert.equal(jobs.listPendingNotifications().filter((j) => j.req.sessionId?.startsWith('offline:')).length, 510);
  assert.equal(temp.isHeld(files[0]), true);
  assert.equal(temp.isHeld(files[509]), true);
  cleanup.sweepBootPartials(process.env.MEDIA_DIR);
  assert.ok(files.every((file) => fs.existsSync(file)), 'cleanup removed a protected result');
});

test('a fresh process protects and recovers a completed download before boot cleanup', () => {
  const dbFile = path.join(TMP, 'restart.sqlite');
  const media = path.join(TMP, 'restart-media');
  fs.mkdirSync(media);
  const file = path.join(media, 'movie_before_restart.mp4');
  fs.writeFileSync(file, 'completed media');
  const raw = new DatabaseSync(dbFile);
  raw.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, req TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)`);
  raw.prepare("INSERT INTO jobs (provider, req, status, result, created_at) VALUES ('generic', ?, 'pending_delivery', ?, ?)")
    .run(JSON.stringify({ chatId: 'chat', sessionId: 'linked:44444444' }), JSON.stringify({ path: file, title: 'Recovered' }), Date.now());
  raw.close();
  const script = `
    const fs = require('fs');
    const delivery = require('./lib/jobDelivery');
    const cleanup = require('./lib/cleanup');
    const sockets = require('./lib/accountSockets');
    const jobs = require('./lib/persistentJobs');
    delivery.protectPendingFiles();
    cleanup.sweepBootPartials(process.env.MEDIA_DIR);
    if (!fs.existsSync(process.env.RECOVERY_FILE)) process.exit(2);
    const messages = [];
    sockets.setOnline('linked:44444444', { sendMessage: async (...args) => messages.push(args) });
    delivery.start();
    setTimeout(() => {
      const result = { status: jobs.get(1).status, count: messages.length, remains: fs.existsSync(process.env.RECOVERY_FILE) };
      console.log('RESULT ' + JSON.stringify(result));
      process.exit(result.status === 'done' && result.count === 1 && !result.remains ? 0 : 3);
    }, 100);
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, JOBS_DB: dbFile, MEDIA_DIR: media, RECOVERY_FILE: file },
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /RESULT .*"status":"done".*"count":1.*"remains":false/);
});

test('offline retry resumes delivery when an existing socket becomes allowed again', () => {
  const dbFile = path.join(TMP, 'reenabled.sqlite');
  const media = path.join(TMP, 'reenabled-media');
  fs.mkdirSync(media);
  const file = path.join(media, 'movie_pending.mp4');
  fs.writeFileSync(file, 'completed media');
  const raw = new DatabaseSync(dbFile);
  raw.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, req TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)`);
  raw.prepare("INSERT INTO jobs (provider, req, status, result, created_at) VALUES ('generic', ?, 'pending_delivery', ?, ?)")
    .run(JSON.stringify({ chatId: 'chat', sessionId: 'linked:55555555' }), JSON.stringify({ path: file, title: 'Pending' }), Date.now());
  raw.close();
  const script = `
    const originalTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 30000 ? 20 : ms, ...args);
    const delivery = require('./lib/jobDelivery');
    const sockets = require('./lib/accountSockets');
    const jobs = require('./lib/persistentJobs');
    let allowed = false, sends = 0;
    sockets.setOnline('linked:55555555', { __canRespond: () => allowed, sendMessage: async () => { sends++; } });
    delivery.start();
    setTimeout(() => { allowed = true; }, 50);
    setTimeout(() => {
      const ok = jobs.get(1).status === 'done' && sends === 1;
      console.log('RESULT ' + JSON.stringify({ status: jobs.get(1).status, sends }));
      process.exit(ok ? 0 : 3);
    }, 250);
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, JOBS_DB: dbFile, MEDIA_DIR: media },
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /RESULT .*"status":"done".*"sends":1/);
});
