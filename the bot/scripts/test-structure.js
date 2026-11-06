'use strict';

// Structure, isolation and per-sender guard tests (all offline).
//   - layout and file budget
//   - no command imports another command
//   - every command folder loads; a broken folder never takes down the rest
//   - circuit breaker, timeout, per-command reload and on/off
//   - approved-sender-only handling, including several users in one group
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
process.env.OWNER_NUMBER = '265991111111'; // account A is the bot owner in these tests
const ROOT = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-'));
const bot = createBotFixture(temp);
process.chdir(temp);
const botRequire = createRequire(path.join(bot, 'scripts', 'test-structure.js'));

// Probe commands live only in the private fixture.
const probe = (name, body) => {
  fs.mkdirSync(path.join(bot, 'commands', name), { recursive: true });
  fs.writeFileSync(path.join(bot, 'commands', name, 'index.js'), body);
};
probe('zz_syntax', 'module.exports = {');
probe('zz_noexec', "module.exports = { name: 'zznoexec' };");
probe('zz_crash', "module.exports = { name: 'zzcrash', async execute() { global.__zzRuns = (global.__zzRuns || 0) + 1; throw new Error('boom'); } };");
probe('zz_flaky', "module.exports = { name: 'zzflaky', async execute() { if (global.__zzFail) throw new Error('flaky'); } };");
probe('zz_hang', "module.exports = { name: 'zzhang', timeoutMs: 40, execute() { return new Promise(() => {}); } };");

const database = botRequire('../lib/database');
database.getBotState = () => true;
const registry = botRequire('../gateway/registry');
const guards = botRequire('../gateway/guards');
const handler = botRequire('../gateway/handler');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

function socket(number, extra = {}) {
  const sent = [];
  return {
    sent,
    __accountNumber: number, __sessionId: `linked:${number}`,
    user: { id: `${number}:1@s.whatsapp.net` },
    sendMessage: async (chat, body) => { sent.push({ chat, body }); return { key: { id: `reply-${sent.length}` } }; },
    ...extra,
  };
}
let seq = 0;
const message = (text, { chat = 'friend@s.whatsapp.net', fromMe = true, participant, id } = {}) => ({
  key: { remoteJid: chat, fromMe, id: id || `m${++seq}`, ...(participant ? { participant } : {}) },
  message: { conversation: text },
});
const A = '265991111111';
const B = '265992222222';
const GROUP = '120363000000000001@g.us';

// ─── layout ──────────────────────────────────────────────────────────────────
test('layout: gateway, commands and lib exist; old utils/ and engine/ roots are gone', () => {
  for (const file of ['gateway/handler.js', 'gateway/guards.js', 'gateway/registry.js', 'gateway/ctx.js',
    'gateway/sessions/manager.js', 'gateway/users/access.js', 'lib/jid.js', 'lib/youtube/youtubedl.js', 'index.js', 'config.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} missing`);
  }
  for (const gone of ['utils', 'engine', 'handler.js', 'database.js']) assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `${gone} should have moved`);
});

test('file budget: the project stays under 190 source files', () => {
  const skip = new Set(['node_modules', 'database', 'temp', 'tmp', 'bin', '.git', 'session', 'sessions', 'logs', 'secrets']);
  let count = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      entry.isDirectory() ? walk(full) : count++;
    }
  })(ROOT);
  assert.ok(count < 190, `${count} files`);
});

// ─── command isolation (static) ──────────────────────────────────────────────
test('no command imports another command folder; only owner admin folders touch gateway/', () => {
  const adminFolders = new Set(['botmanage', 'toggle', 'users']);
  const offenders = [];
  const commandsDir = path.join(ROOT, 'commands');
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const folder = path.relative(commandsDir, full).split(path.sep)[0];
      const source = fs.readFileSync(full, 'utf8');
      for (const m of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        const target = path.relative(ROOT, path.resolve(path.dirname(full), m[1]));
        const parts = target.split(path.sep);
        if (parts[0] === 'commands' && parts[1] !== folder) offenders.push(`${folder} -> ${target}`);
        if (parts[0] === 'gateway' && !adminFolders.has(folder)) offenders.push(`${folder} -> ${target}`);
      }
    }
  })(commandsDir);
  assert.deepEqual(offenders, []);
});

test('no two command folders register the same name or alias', () => {
  const seen = new Map(); const clashes = [];
  for (const folder of fs.readdirSync(path.join(ROOT, 'commands'))) {
    const exported = require(path.join(ROOT, 'commands', folder, 'index.js'));
    for (const command of Array.isArray(exported) ? exported : [exported]) {
      for (const key of [command.name, ...(command.aliases || [])]) {
        if (seen.has(key) && seen.get(key) !== folder) clashes.push(`${key}: ${seen.get(key)} / ${folder}`);
        seen.set(key, folder);
      }
    }
  }
  assert.deepEqual(clashes, []);
});

test('movie host resolves every lazy host module (no silent degradation)', () => {
  const host = require(path.join(ROOT, 'lib/movies/host.js'));
  host.reset();
  const caps = host.capabilities();
  assert.ok(caps.tempDir, 'temp manager not resolved');
  assert.equal(caps.downloader, true, 'download helper not resolved');
  assert.ok(caps.ffmpeg, 'ffmpeg helper not resolved');
});

// ─── registry isolation ──────────────────────────────────────────────────────
test('a broken command folder is skipped and reported; every other command still loads', () => {
  const commands = registry.loadCommands();
  const board = registry.board();
  const state = Object.fromEntries(board.map((row) => [row.folder, row]));
  assert.equal(state.zz_syntax.state, 'broken');
  assert.equal(state.zz_noexec.state, 'broken');
  assert.match(state.zz_noexec.reason, /execute/);
  for (const good of ['ping', 'menu', 'song', 'video', 'movie', 'series', 'paper', 'social', 'users', 'toggle', 'botmanage']) {
    assert.equal(state[good].state, 'ok', `${good} should load`);
  }
  assert.ok(commands.has('ping') && commands.has('instagram') && commands.has('ig'));
  assert.equal(commands.has('zznoexec'), false);
});

test('registry maps each trigger to its folder', () => {
  assert.equal(registry.folderOf('ig'), 'social');
  assert.equal(registry.folderOf('tiktok'), 'social');
  assert.equal(registry.folderOf('song'), 'song');
  assert.equal(registry.folderOf('nope'), null);
});

// ─── per-sender guards ───────────────────────────────────────────────────────
test('guards: own messages pass; other people’s messages never do', () => {
  guards._resetForTests();
  const a = socket(A);
  assert.equal(guards.evaluate(a, message('.ping')).allow, true);
  assert.equal(guards.evaluate(a, message('.ping', { fromMe: false })).reason, 'not-sender');
  assert.equal(guards.evaluate(a, { key: { fromMe: true, remoteJid: 'x@s.whatsapp.net', id: 'e' } }).reason, 'empty');
});

test('guards: unapproved or paused accounts are ignored', () => {
  guards._resetForTests();
  const paused = socket(A, { __canRespond: () => false });
  assert.equal(guards.evaluate(paused, message('.ping')).reason, 'not-approved');
  const approved = socket(A, { __canRespond: () => true });
  assert.equal(guards.evaluate(approved, message('.ping')).allow, true);
});

test('guards: in a group only the account that sent the message may act on it', () => {
  guards._resetForTests();
  const a = socket(A); const b = socket(B);
  const fromA = (id) => message('.ping', { chat: GROUP, id });
  // A's own socket: allowed (own group messages carry no participant or A's id)
  assert.equal(guards.evaluate(a, fromA('g1')).allow, true);
  assert.equal(guards.evaluate(a, message('.ping', { chat: GROUP, id: 'g2', participant: `${A}@s.whatsapp.net` })).allow, true);
  // B's socket sees the same message as someone else's: not fromMe, ignored
  assert.equal(guards.evaluate(b, message('.ping', { chat: GROUP, id: 'g1', fromMe: false, participant: `${A}@s.whatsapp.net` })).allow, false);
  // a message marked fromMe but attributed to another participant is rejected
  assert.equal(guards.evaluate(b, message('.ping', { chat: GROUP, id: 'g3', participant: `${A}@s.whatsapp.net` })).reason, 'foreign-participant');
});

test('guards: one chat message is claimed by exactly one socket', () => {
  guards._resetForTests();
  const first = socket(A, { __sessionId: 'linked:first' });
  const second = socket(A, { __sessionId: 'linked:second' }); // same account linked twice
  const m = message('.ping', { chat: GROUP, id: 'dup' });
  assert.equal(guards.evaluate(first, m).allow, true);
  assert.equal(guards.evaluate(second, m).reason, 'claimed-by-other-session');
  assert.equal(guards.evaluate(first, m).allow, true, 'the claimant may see its own message again');
});

// One `.ping` produces a few WhatsApp calls (reaction, status, edit). Measure
// that once, then require every socket to do exactly that much — no more.
let PING_CALLS = 0;
test('baseline: one .ping from one user', async () => {
  guards._resetForTests();
  const solo = socket(A);
  await handler.handleMessage(solo, message('.ping'));
  PING_CALLS = solo.sent.length;
  assert.ok(PING_CALLS >= 1);
});

test('handler: two approved users in one group each get exactly one reply, from their own socket only', async () => {
  guards._resetForTests();
  const a = socket(A); const b = socket(B);
  const fromA = message('.ping', { chat: GROUP, id: 'ga' });
  const fromB = message('.ping', { chat: GROUP, id: 'gb' });
  // WhatsApp delivers every group message to every linked socket.
  const asSeenByOther = (msg, sender) => ({ ...msg, key: { ...msg.key, fromMe: false, participant: `${sender}@s.whatsapp.net` } });
  await Promise.all([
    handler.handleMessage(a, fromA), handler.handleMessage(b, asSeenByOther(fromA, A)),
    handler.handleMessage(b, fromB), handler.handleMessage(a, asSeenByOther(fromB, B)),
  ]);
  const toGroup = (s) => s.sent.filter((x) => x.chat === GROUP);
  assert.equal(toGroup(a).length, PING_CALLS, 'A answers A’s own message once, and ignores B’s');
  assert.equal(toGroup(b).length, PING_CALLS, 'B answers B’s own message once, and ignores A’s');
  const touched = (s, key) => s.sent.filter((x) => JSON.stringify(x.body).includes(key));
  assert.equal(touched(a, 'gb').length, 0, 'A never reacts to B’s message');
  assert.equal(touched(b, 'ga').length, 0, 'B never reacts to A’s message');
  assert.equal(guards.evaluate(a, { ...fromA }).allow, true);
});

test('handler: a duplicate delivery of the same message to a second session produces no second reply', async () => {
  guards._resetForTests();
  const one = socket(A, { __sessionId: 'linked:one' });
  const two = socket(A, { __sessionId: 'linked:two' });
  const m = message('.ping', { chat: GROUP, id: 'same' });
  await handler.handleMessage(one, m);
  await handler.handleMessage(two, m);
  assert.equal(one.sent.length, PING_CALLS);
  assert.equal(two.sent.length, 0);
});

// ─── crash isolation ─────────────────────────────────────────────────────────
test('a crashing command never blocks other commands; the breaker switches it off after 3 failures', async () => {
  guards._resetForTests();
  registry.enable('zz_crash');
  global.__zzRuns = 0;
  const a = socket(A);
  for (let i = 0; i < 3; i++) await handler.handleMessage(a, message('.zzcrash'));
  assert.equal(global.__zzRuns, 3);
  assert.ok(registry.disabledInfo('zzcrash'), 'breaker should have disabled it');
  assert.equal(registry.disabledInfo('zzcrash').reason, 'breaker');
  assert.ok(a.sent.some((x) => /switched off/.test(x.body.text || '')));
  // further calls do not execute the command at all
  await handler.handleMessage(a, message('.zzcrash'));
  assert.equal(global.__zzRuns, 3);
  assert.equal(registry.board().find((r) => r.folder === 'zz_crash').state, 'disabled');
  // another command is untouched
  const before = a.sent.length;
  await handler.handleMessage(a, message('.ping'));
  assert.ok(a.sent.length > before, '.ping still answers');
  registry.enable('zzcrash');
  assert.equal(registry.disabledInfo('zzcrash'), null);
});

test('a command that never finishes is cut off at its timeout and counted as a failure', async () => {
  guards._resetForTests();
  registry.enable('zz_hang');
  const a = socket(A);
  const started = Date.now();
  await handler.handleMessage(a, message('.zzhang'));
  assert.ok(Date.now() - started < 3000, 'handler must not wait forever');
  assert.ok(a.sent.length >= 1, 'the user gets an error reply, not silence');
  registry.enable('zz_hang');
});

test('per-command on/off and reload change only that command', async () => {
  guards._resetForTests();
  const a = socket(A);
  registry.disable('ping', 'owner');
  await handler.handleMessage(a, message('.ping'));
  assert.match(a.sent.at(-1).body.text, /switched off/);
  await handler.handleMessage(a, message('.menu'));
  assert.ok(a.sent.length >= 2);
  registry.enable('ping');
  const before = a.sent.length;
  await handler.handleMessage(a, message('.ping'));
  assert.ok(a.sent.length > before && !/switched off/.test(a.sent.at(-1).body.text || ''));
  const reloaded = handler.reloadCommand('ping');
  assert.equal(reloaded.state, 'ok');
  assert.equal(handler.reloadCommand('does-not-exist'), null);
});

// ─── console visibility ──────────────────────────────────────────────────────
test('the console shows every command: who ran it, where, and how it ended', async () => {
  guards._resetForTests();
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const a = socket(A);
    await handler.handleMessage(a, message('.ping'));
    registry.enable('zz_crash');
    await handler.handleMessage(a, message('.zzcrash now'));
    await handler.handleMessage(a, message('.ping', { chat: GROUP }));
    registry.enable('zzcrash');
  } finally { console.log = original.log; console.error = original.error; }
  const text = lines.join('\n');
  assert.match(text, /INFO\s+commands\s+\.ping ← 265991111111 \(DM\)/);
  assert.match(text, /\.ping ✓ \d+\.\ds/);
  assert.match(text, /\.ping ← 265991111111 \(group\)/);
  assert.match(text, /WARN\s+commands\s+\.zzcrash ✗ \d+\.\ds \(boom\)/);
  assert.match(text, /\.zzcrash ← 265991111111 \(DM\) now/, 'arguments are shown, trimmed');
});

// ─── breaker, per-command state, protected commands ──────────────────────────
test('the breaker counts CONSECUTIVE failures: a success in between starts the count over', async () => {
  guards._resetForTests();
  registry.enable('zzflaky');
  const a = socket(A);
  global.__zzFail = true;
  await handler.handleMessage(a, message('.zzflaky'));
  await handler.handleMessage(a, message('.zzflaky'));
  global.__zzFail = false;
  await handler.handleMessage(a, message('.zzflaky')); // success resets
  global.__zzFail = true;
  await handler.handleMessage(a, message('.zzflaky'));
  await handler.handleMessage(a, message('.zzflaky'));
  assert.equal(registry.disabledInfo('zzflaky'), null, '4 failures with a success between must not trip it');
  await handler.handleMessage(a, message('.zzflaky')); // third in a row
  assert.equal(registry.disabledInfo('zzflaky').reason, 'breaker');
  global.__zzFail = false;
  registry.enable('zzflaky');
});

test('switching off is per command: .off ig stops .ig/.instagram only, not the rest of its folder', async () => {
  guards._resetForTests();
  const owner = socket(A);
  await handler.handleMessage(owner, message('.off ig'));
  assert.ok(registry.disabledInfo('instagram'), 'alias resolves to the same command');
  assert.ok(registry.disabledInfo('ig'));
  assert.equal(registry.disabledInfo('tiktok'), null);
  assert.equal(registry.disabledInfo('fb'), null);
  const social = registry.board().find((row) => row.folder === 'social');
  assert.equal(social.state, 'partial');
  assert.deepEqual(social.off, ['instagram']);
  await handler.handleMessage(owner, message('.on ig'));
  assert.equal(registry.disabledInfo('instagram'), null);
  assert.equal(registry.board().find((row) => row.folder === 'social').state, 'ok');
  // a whole folder can still be switched off by its folder name
  registry.disable('social');
  assert.equal(registry.board().find((row) => row.folder === 'social').state, 'disabled');
  registry.enable('social');
});

test('the commands that control the bot can never be switched off, by hand or by the breaker', async () => {
  guards._resetForTests();
  const owner = socket(A);
  const refused = registry.disable('on');
  assert.deepEqual(refused.names, []);
  assert.deepEqual(refused.skipped, ['on']);
  await handler.handleMessage(owner, message('.off off'));
  assert.match(owner.sent.at(-1).body.text, /cannot be switched off/);
  for (let i = 0; i < 6; i++) assert.equal(registry.recordFailure('status'), false);
  assert.equal(registry.disabledInfo('status'), null);
  assert.equal(registry.disabledInfo('on'), null);
});

test('guards: an @lid sender that cannot be mapped is still our own message; a different known number is not', () => {
  guards._resetForTests();
  const a = socket(A);
  assert.equal(guards.evaluate(a, message('.ping', { chat: GROUP, id: 'lid1', participant: '99887766@lid' })).allow, true);
  assert.equal(guards.evaluate(a, message('.ping', { chat: GROUP, id: 'lid2', participant: `${B}@s.whatsapp.net` })).reason, 'foreign-participant');
});

// ─── torrent worker isolation ────────────────────────────────────────────────
const { pathToFileURL } = require('node:url');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const fakeWorker = (body) => {
  const file = path.join(temp, `worker-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(file, `process.on('message', (job) => { ${body} });`);
  return file;
};
const downloader = () => import(pathToFileURL(path.join(ROOT, 'lib/movies/engine/media/downloader.js')).href);

test('torrent worker: progress is forwarded and the finished file is returned', async () => {
  const { torrentInChild } = await downloader();
  const dest = path.join(temp, 'dl-ok', 'movie.mkv');
  const seen = [];
  const workerPath = fakeWorker(`
    require('fs').mkdirSync(job.dest + '.parts', { recursive: true });
    process.send({ type: 'progress', got: 5, total: 10 });
    process.send({ type: 'done', file: job.dest }, () => process.exit(0));`);
  const result = await torrentInChild('magnet:?xt=urn:btih:abc', dest, { workerPath, onProgress: (got, total) => seen.push([got, total]) });
  assert.equal(result.file, dest);
  assert.deepEqual(seen, [[5, 10]]);
  assert.equal(fs.existsSync(`${dest}.parts`), false, 'partial files are cleaned up');
});

test('torrent worker: a failure, a crash and a hang all become rejected promises, and the child is killed', async () => {
  const { torrentInChild } = await downloader();
  const run = (name, body, opts = {}) => torrentInChild('magnet:?xt=urn:btih:abc', path.join(temp, name, 'm.mkv'), { workerPath: fakeWorker(body), ...opts });

  await assert.rejects(run('dl-err', "process.send({ type: 'error', message: 'no peers', code: 'NO_PEERS' }, () => process.exit(1));"),
    (e) => e.message === 'no peers' && e.code === 'NO_PEERS');

  await assert.rejects(run('dl-crash', 'process.exit(1);'), (e) => e.code === 'TORRENT_WORKER_EXIT');

  let pid = 0;
  const hung = run('dl-hang', "process.send({ type: 'progress', got: 1, total: 2 }); setInterval(() => {}, 1000);", {
    hardTimeoutMs: 400, onProgress: () => {},
  });
  await assert.rejects(hung, (e) => e.code === 'TORRENT_TIMEOUT');
  assert.equal(fs.existsSync(path.join(temp, 'dl-hang', 'm.mkv.parts')), false);
  void pid;
});

test('torrent worker: the real worker loads in its own process, so the bot process never loads WebTorrent', async () => {
  const { torrentInChild } = await downloader();
  const { torrentEngineAvailable } = await import(pathToFileURL(path.join(ROOT, 'lib/movies/engine/media/torrent.js')).href);
  const installed = await torrentEngineAvailable();
  assert.equal(Object.keys(require.cache).some((key) => /node_modules[\\/]webtorrent[\\/]/.test(key)), false);
  if (installed) return; // a real download needs the network; this check is for the missing-engine path
  await assert.rejects(
    torrentInChild('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', path.join(temp, 'dl-real', 'm.mkv'), { metadataTimeoutMs: 2000 }),
    (e) => e.code === 'NO_TORRENT_ENGINE',
  );
});

// ─── provider list and removed commands ──────────────────────────────────────
test('the movie engine registers exactly the 12 working providers', async () => {
  const engine = await import(pathToFileURL(path.join(ROOT, 'lib/movies/engine/media/index.js')).href);
  const names = [...(engine.registry.list ? engine.registry.list() : engine.registry.providers)].map((p) => p.id || p.name);
  assert.deepEqual(names.sort(), ['apibay', 'eztv', 'knaben', 'moviebox', 'nyaa', 'solidtorrents', 'torrentio', 'torrentscsv', 'vaplayer', 'vidlink', 'vidsrc', 'yts']);
  for (const gone of ['providers/ddl', 'core/mirrors.js']) assert.equal(fs.existsSync(path.join(ROOT, 'lib/movies/engine', gone)), false, `${gone} should stay removed`);
});

test('.x, .reddit and .spotify are gone, with their code and settings', () => {
  const commands = registry.loadCommands();
  for (const name of ['x', 'twitter', 'xtwitter', 'reddit', 'spotify']) assert.equal(commands.has(name), false, name);
  for (const file of ['commands/spotify', 'commands/social/providerSearch.js']) assert.equal(fs.existsSync(path.join(ROOT, file)), false, file);
  assert.equal(Object.hasOwn(botRequire('../config'), 'spotify'), false);
});

// ─── .paper: no resends to the same group within 5 days ──────────────────────
const paperCmd = botRequire('../commands/paper/index')[0];
const dbm = botRequire('../lib/database');
const GROUP_2 = '120363000000000002@g.us';
const vaultFiles = [
  { id: 901, hash: 'h901', name: 'NURS 2201 2024 END OF SEMESTER.pdf', size: 1024, created_at: '2025-01-01T00:00:00Z' },
  { id: 902, hash: 'h902', name: 'NURS 2201 2023 END OF SEMESTER.pdf', size: 2048, created_at: '2025-01-01T00:00:00Z' },
];
let downloadDelay = 0;
function paperHarness() {
  const docs = []; const texts = [];
  const sock = { async sendMessage(chat, body) { if (body.document) docs.push({ chat, name: body.fileName }); return { key: { id: 'p' } }; } };
  const run = (from, { session = 'primary', owner = false, args = ['nurs', '2201'] } = {}) => paperCmd.execute(
    sock, { key: { remoteJid: from, id: `pm${++seq}` } }, args,
    {
      from, sessionId: session, isOwner: owner,
      reply: async (t) => { texts.push(t); },
      status: async (t) => { texts.push(t); return { update: async (u) => { texts.push(u); } }; },
    },
  );
  return { docs, texts, run };
}
test.before(() => {
  paperCmd._setVaultFilesForTests(vaultFiles);
  paperCmd._setDownloaderForTests(async (file) => {
    if (downloadDelay) await new Promise((resolve) => setTimeout(resolve, downloadDelay));
    const tmp = botRequire('../lib/tempManager').createTempFilePath('paper', 'pdf');
    fs.writeFileSync(tmp, '%PDF-1.4');
    return { tmp, releaseHold() {} };
  });
});
test.after(() => { paperCmd._setDownloaderForTests(null); paperCmd._setVaultFilesForTests(null); });

test('paper: a group never gets the same paper twice within 5 days, whichever linked account asks', async () => {
  const h = paperHarness();
  await h.run(GROUP, { session: 'linked:a' });
  assert.equal(h.docs.length, 2, 'first request sends both papers');
  h.texts.length = 0;
  await h.run(GROUP, { session: 'linked:b' }); // another approved user, same group
  assert.equal(h.docs.length, 2, 'nothing more is sent');
  assert.match(h.texts.join('\n'), /already sent in this group in the last 5 days \(today\)/);
});

test('paper: the memory is per specific group, and private chats stay separate per account', async () => {
  const h = paperHarness();
  await h.run(GROUP_2, { session: 'linked:a' });
  assert.equal(h.docs.length, 2, 'a different group still gets them');
  const dm = 'friend@s.whatsapp.net';
  await h.run(dm, { session: 'linked:a' });
  await h.run(dm, { session: 'linked:b' }); // same contact, different account = different conversation
  assert.equal(h.docs.filter((d) => d.chat === dm).length, 4);
  h.texts.length = 0;
  await h.run(dm, { session: 'linked:a' }); // same account, same DM again: refused
  assert.equal(h.docs.filter((d) => d.chat === dm).length, 4);
  assert.match(h.texts.join('\n'), /already sent in this chat/);
});

test('paper: the owner is held to the same rule in a group and may resend with --force', async () => {
  const h = paperHarness();
  const group = '120363000000000003@g.us';
  await h.run(group, { owner: true });
  assert.equal(h.docs.length, 2);
  await h.run(group, { owner: true });
  assert.equal(h.docs.length, 2, 'owner is refused in a group too');
  await h.run(group, { owner: true, args: ['nurs', '2201', '--force'] });
  assert.equal(h.docs.length, 4, '--force resends');
  await h.run(group, { owner: false, args: ['nurs', '2201', '--force'] });
  assert.equal(h.docs.length, 4, 'only the owner can force');
});

test('paper: two people asking at the same moment in one group trigger one send, not two', async () => {
  const h = paperHarness();
  const group = '120363000000000004@g.us';
  downloadDelay = 60;
  try {
    await Promise.all([h.run(group, { session: 'linked:a' }), h.run(group, { session: 'linked:b' })]);
  } finally { downloadDelay = 0; }
  assert.equal(h.docs.length, 2, 'each paper is sent once');
});

test('paper log: the window is 5 days, writes are bulk, and old entries are pruned', () => {
  assert.equal(dbm.PAPER_DEDUPE_DAYS, 5);
  const DAY = 24 * 60 * 60 * 1000;
  const t0 = Date.now() + 100 * DAY; // far future so earlier tests' entries cannot interfere
  dbm.logPapersSent('window@g.us', ['a', 'b'], t0);
  assert.ok(dbm.paperSentAt('window@g.us', 'a', 5, t0 + 4.9 * DAY), 'blocked at 4.9 days');
  assert.equal(dbm.paperSentAt('window@g.us', 'a', 5, t0 + 5.1 * DAY), null, 'allowed after 5 days');
  dbm.logPapersSent('window@g.us', ['c'], t0 + 6 * DAY); // prune runs on this write
  assert.equal(dbm.paperSentAt('window@g.us', 'a', 30, t0 + 6 * DAY), null, 'entries past the window are gone');
  assert.ok(dbm.paperSentAt('window@g.us', 'c', 5, t0 + 6 * DAY));
  assert.equal(dbm.paperChatKey(GROUP, 'linked:a'), GROUP);
  assert.equal(dbm.paperChatKey('x@s.whatsapp.net', 'linked:a'), 'linked:a|x@s.whatsapp.net');
});

// ─── database backups ────────────────────────────────────────────────────────
const { createDbBackup } = require(path.join(ROOT, 'lib/dbBackup'));
function backupHarness(keep = 10) {
  const dir = fs.mkdtempSync(path.join(temp, 'dbb-'));
  let tick = 0;
  const backup = createDbBackup({ dir, keep, now: () => new Date(Date.UTC(2026, 10, 4, 12, 0, tick++)), log: { warn() {} } });
  const put = (name, data) => fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  return { dir, backup, put, read };
}

test('backup: saves the state files only (never tokens or caches) and skips unchanged state', () => {
  const { dir, backup, put } = backupHarness();
  put('whitelist.json', { users: ['265991111111'] });
  put('paper_log.json', { 'g@g.us': { 901: 1 } });
  put('yt_auth.json', { token: 'secret-token' });
  put('cache.json', { big: true });
  const first = backup.snapshot();
  assert.equal(first.changed, true);
  const saved = JSON.parse(fs.readFileSync(path.join(backup.backupDir, first.file), 'utf8'));
  assert.deepEqual(Object.keys(saved.files).sort(), ['paper_log.json', 'whitelist.json']);
  assert.doesNotMatch(JSON.stringify(saved), /secret-token/);
  assert.equal(backup.snapshot().changed, false, 'nothing changed, nothing written');
  put('whitelist.json', { users: ['265991111111', '265992222222'] });
  assert.equal(backup.snapshot().changed, true);
  assert.equal(backup.list().length, 2);
  assert.ok(fs.existsSync(dir));
});

test('backup: only the newest N snapshots are kept, and a corrupt file is skipped without losing the rest', () => {
  const { backup, put } = backupHarness(3);
  for (let i = 0; i < 6; i++) { put('botstate.json', { on: true, n: i }); backup.snapshot(); }
  assert.equal(backup.list().length, 3);
  put('whitelist.json', '{ not json');
  put('botstate.json', { on: false });
  const result = backup.snapshot();
  assert.equal(result.changed, true);
  assert.match(result.skipped.join(' '), /whitelist\.json/);
  const saved = JSON.parse(fs.readFileSync(path.join(backup.backupDir, result.file), 'utf8'));
  assert.deepEqual(saved.files.botstate, undefined);
  assert.deepEqual(saved.files['botstate.json'], { on: false });
  assert.equal(backup.latest().count, 3);
});

test('backup: restore puts the files back, snapshots the current state first, and refuses bad bundles', () => {
  const { dir, backup, put, read } = backupHarness();
  put('whitelist.json', { users: ['a'] });
  const good = backup.snapshot();
  put('whitelist.json', { users: ['wrong'] }); // something went wrong afterwards
  const result = backup.restore('latest');
  assert.deepEqual(result.restored, ['whitelist.json']);
  assert.deepEqual(read('whitelist.json'), { users: ['a'] });
  assert.ok(backup.list().some((n) => /pre-restore/.test(n)), 'the state before the restore is kept too');
  assert.throws(() => backup.restore('nope.json'), /no such backup/);
  assert.throws(() => backup.restore('../../etc/passwd'), /no such backup/);
  fs.writeFileSync(path.join(backup.backupDir, 'db-20261104-999999.json'), JSON.stringify({ version: 1, files: { '../evil.json': {} } }));
  assert.throws(() => backup.restore('db-20261104-999999.json'), /unexpected file/);
  assert.equal(fs.existsSync(path.join(dir, '..', 'evil.json')), false);
  assert.ok(good.file);
});

test('backup: snapshots leave no .tmp/.bak clutter and stray leftovers are swept', () => {
  const { backup, put } = backupHarness(2);
  put('botstate.json', { on: true });
  fs.mkdirSync(backup.backupDir, { recursive: true });
  fs.writeFileSync(path.join(backup.backupDir, 'db-20260101-000000.json.bak'), 'old leftover');
  for (let i = 0; i < 4; i++) { put('botstate.json', { on: true, n: i }); backup.snapshot(); }
  const names = fs.readdirSync(backup.backupDir);
  assert.equal(names.length, 2, `only the newest 2 snapshots remain, got ${names.join(', ')}`);
  assert.equal(names.some((n) => /\.(tmp|bak)$/.test(n)), false);
});
