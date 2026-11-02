'use strict';

/**
 * test/imports.test.js — the static proofs from Phase 4D and 4F.
 *
 * These read the source tree and assert the architecture's rules directly. If a
 * future edit breaks rule 1, 2 or 4, this fails before anything ships.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMMANDS = path.join(ROOT, 'commands');

function commandFolders() {
  return fs.readdirSync(COMMANDS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name);
}

function jsFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Every literal require()/import target in a file. */
function requires(file) {
  const source = fs.readFileSync(file, 'utf8');
  const found = [];
  const re = /(?:require\s*\(|from\s+|import\s*\(|import\s+)\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(source))) found.push(match[1]);
  return found;
}

/* ── rule 1: a command imports only its own folder, lib/, and node_modules ─ */

test('no command imports another command', () => {
  const offenders = [];
  for (const name of commandFolders()) {
    for (const file of jsFiles(path.join(COMMANDS, name))) {
      for (const target of requires(file)) {
        if (!target.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), target);
        const rel = path.relative(COMMANDS, resolved);
        const segment = rel.split(path.sep)[0];
        if (segment && segment !== name && segment !== '..') {
          offenders.push(`${path.relative(ROOT, file)} -> ${target}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `commands importing other commands:\n${offenders.join('\n')}`);
});

test('no command imports gateway internals', () => {
  const offenders = [];
  for (const name of commandFolders()) {
    for (const file of jsFiles(path.join(COMMANDS, name))) {
      const source = fs.readFileSync(file, 'utf8');
      if (/require\s*\(\s*['"][^'"]*gateway\//.test(source) || /from\s+['"][^'"]*gateway\//.test(source)) {
        offenders.push(path.relative(ROOT, file));
      }
      for (const target of requires(file)) {
        if (!target.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), target);
        if (resolved.includes(`${path.sep}gateway${path.sep}`)) {
          offenders.push(`${path.relative(ROOT, file)} -> ${target}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `commands reaching into gateway/:\n${offenders.join('\n')}`);
});

test('no command imports the old bot tree', () => {
  const offenders = [];
  for (const name of commandFolders()) {
    for (const file of jsFiles(path.join(COMMANDS, name))) {
      for (const target of requires(file)) {
        if (target.includes('Whatsapp bot') || target.includes('utils/') && !target.startsWith('.')) {
          offenders.push(`${path.relative(ROOT, file)} -> ${target}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

/* ── rule 4: no command touches the socket or users.json ─────────────────── */

test('no command reaches a Baileys socket or writes user data', () => {
  const offenders = [];
  // The paper family drives the original vault code through adapter.js, which
  // defines a *fake* object with a sendMessage method that forwards to ctx. That
  // is a shim, not a socket: it is the only place the token is allowed.
  const ADAPTER_ALLOWED = new Set([
    'commands/paper/adapter.js',
    'commands/countpapers/adapter.js',
    'commands/refreshpapers/adapter.js',
  ]);

  for (const name of commandFolders()) {
    for (const file of jsFiles(path.join(COMMANDS, name))) {
      const rel = path.relative(ROOT, file);
      const source = fs.readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      if (/\buseMultiFileAuthState\b|\bmakeWASocket\b|@whiskeysockets\/baileys/.test(code)) {
        offenders.push(`${rel}: imports or constructs Baileys`);
      }
      if (/\bdownloadMediaMessage\b|\bdownloadContentFromMessage\b/.test(code)) {
        offenders.push(`${rel}: downloads media itself (the gateway owns the socket)`);
      }
      if (/\bsendMessage\s*\(/.test(code) && !ADAPTER_ALLOWED.has(rel)) {
        offenders.push(`${rel}: sendMessage()`);
      }
      // users.json may be discussed in a comment; only an actual path or a store
      // write in code counts.
      if (/users\.json/.test(code)) offenders.push(`${rel}: users.json`);
      if (/\bwriteUsers\b|store\.(addUser|banUser|setRole|blockCommand)\b/.test(code)) {
        offenders.push(`${rel}: store write`);
      }
    }
  }
  assert.deepEqual(offenders, [], `commands touching the socket or user data:\n${offenders.join('\n')}`);
});

test('the paper adapter forwards to ctx and never to a real socket', () => {
  for (const name of ['paper', 'countpapers', 'refreshpapers']) {
    const source = fs.readFileSync(path.join(COMMANDS, name, 'adapter.js'), 'utf8');
    assert.match(source, /ctx\.reply/, `${name}/adapter.js must forward replies to ctx`);
    assert.match(source, /ctx\.react/, `${name}/adapter.js must forward reactions to ctx`);
    assert.ok(!/require\(['"]@whiskeysockets/.test(source), `${name}/adapter.js must not require Baileys`);
  }
});

test('gateway/users/store.js is the only writer of users.json', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'storage', 'sessions', 'logs', 'test'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, full);
      if (rel === path.join('gateway', 'users', 'store.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/writeJsonAtomic\s*\(\s*usersFile|writeFileSync\s*\(\s*usersFile/.test(source)) offenders.push(rel);
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

/* ── every catch must keep the cause ─────────────────────────────────────── */

test('no empty catch blocks anywhere, engine included', () => {
  // The brief: every catch logs the cause or rethrows. The ported engine/ used to
  // be an exception (31 swallows); they now log at the right level, so the rule
  // applies to the whole tree with no carve-outs.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'storage', 'sessions', 'logs'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, full);
      if (rel.startsWith('test')) continue;
      const source = fs.readFileSync(full, 'utf8');
      // catch {} and catch (_) {} and catch (e) { } with no body.
      const empty = source.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g);
      if (empty) offenders.push(`${rel} (${empty.length})`);
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], `empty catch blocks:\n${offenders.join('\n')}`);
});

/* ── rule 5: per-command folders ─────────────────────────────────────────── */

test('every command folder has command.json, index.js and check.js', () => {
  const missing = [];
  for (const name of commandFolders()) {
    for (const file of ['command.json', 'index.js', 'check.js']) {
      if (!fs.existsSync(path.join(COMMANDS, name, file))) missing.push(`${name}/${file}`);
    }
  }
  assert.deepEqual(missing, [], `missing required files:\n${missing.join('\n')}`);
});

test('every index.js exports run(ctx) and nothing else is required of it', () => {
  const bad = [];
  for (const name of commandFolders()) {
    const source = fs.readFileSync(path.join(COMMANDS, name, 'index.js'), 'utf8');
    if (!/module\.exports\s*=\s*\{[^}]*\brun\b/.test(source) && !/exports\.run\s*=/.test(source)) {
      bad.push(name);
    }
  }
  assert.deepEqual(bad, [], `commands without a run export:\n${bad.join('\n')}`);
});

/* ── rule 9: Baileys pinned exactly ──────────────────────────────────────── */

test('Baileys is pinned to an exact version, with no ^ or ~', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.dependencies['@whiskeysockets/baileys'];
  assert.ok(version, 'Baileys must be a dependency');
  assert.match(version, /^\d+\.\d+\.\d+/, `Baileys is not pinned exactly: ${version}`);
  assert.ok(!version.startsWith('^') && !version.startsWith('~'), `Baileys has a range operator: ${version}`);
});

test('every command.json declares the full contract', () => {
  const required = ['name', 'aliases', 'category', 'description', 'usage', 'role', 'cooldownSec', 'timeoutSec', 'lane', 'limits', 'sample'];
  const problems = [];
  for (const name of commandFolders()) {
    const meta = JSON.parse(fs.readFileSync(path.join(COMMANDS, name, 'command.json'), 'utf8'));
    for (const key of required) {
      if (meta[key] === undefined) problems.push(`${name}: missing ${key}`);
    }
    if (meta.name !== name) problems.push(`${name}: name is "${meta.name}"`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('no duplicate command names or aliases across the whole tree', () => {
  const seen = new Map();
  const duplicates = [];
  for (const name of commandFolders()) {
    const meta = JSON.parse(fs.readFileSync(path.join(COMMANDS, name, 'command.json'), 'utf8'));
    for (const trigger of [meta.name, ...(meta.aliases || [])]) {
      if (seen.has(trigger) && seen.get(trigger) !== meta.name) {
        duplicates.push(`"${trigger}": ${seen.get(trigger)} and ${meta.name}`);
      }
      seen.set(trigger, meta.name);
    }
  }
  assert.deepEqual(duplicates, [], duplicates.join('\n'));
});

/* ── rule 12: no secrets in the tree ─────────────────────────────────────── */

test('no hardcoded credentials anywhere in the source tree', () => {
  const patterns = [
    /(?:api[_-]?key|apikey|secret|password|passwd)\s*[:=]\s*['"][A-Za-z0-9_\-.]{16,}['"]/i,
    /\bBearer\s+[A-Za-z0-9._-]{20,}/,
    /\b\d{6,}\|[A-Za-z0-9]{24,}\b/,
  ];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'storage', 'sessions', 'logs', 'test'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|json|md)$/.test(entry.name)) continue;
      if (entry.name === 'package-lock.json') continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const pattern of patterns) {
        if (pattern.test(source)) {
          offenders.push(`${path.relative(ROOT, full)} matched ${pattern}`);
          break;
        }
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], `possible secrets:\n${offenders.join('\n')}`);
});

test('the old hardcoded owner/admin numbers are gone', () => {
  const legacy = ['265894016453', '265997564836', '265986741036', '265894016451'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'storage', 'sessions', 'logs', 'test'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|json|md)$/.test(entry.name) || entry.name === 'package-lock.json') continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const number of legacy) {
        if (source.includes(number)) offenders.push(`${path.relative(ROOT, full)} contains ${number}`);
      }
      // Test fixtures may use the old numbers only as *test input*; they must
      // never be assigned as a privileged identity. Guard against a real one.
      if (/(ownerNumber|OWNER_NUMBER|adminNumbers)\s*[:=]\s*['"`]\d{9,}/.test(source)) {
        offenders.push(`${path.relative(ROOT, full)} hardcodes a privileged number`);
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('.gitignore covers sessions, storage and logs', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const line of ['sessions/', 'storage/', 'logs/']) {
    assert.ok(ignore.includes(line), `.gitignore does not exclude ${line}`);
  }
  assert.ok(ignore.includes('.env'), '.gitignore does not exclude .env');
});

test('limits live only in command.json — no env override for a cap', () => {
  // A cap that can be set in two places is the hidden-path problem: the
  // documented limit and the enforced limit drift apart. Env is for secrets.
  const BANNED = [
    'PAPER_MAX_PER_QUERY', 'PAPER_MAX_SEND_MB',
    'MOVIE_QUALITY', 'MOVIE_MAX_MB', 'MOVIE_MAX_DOWNLOAD_MB',
    'XJX_SONG_AUDIO_FORMAT',
  ];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'storage', 'sessions', 'logs', 'test'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const name of BANNED) {
        if (source.includes(`process.env.${name}`) || source.includes(`env.${name}`)) {
          offenders.push(`${path.relative(ROOT, full)} reads ${name}`);
        }
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], `limit overrides still readable from env:\n${offenders.join('\n')}`);
});

test('every command.json limit is a number', () => {
  const problems = [];
  for (const name of commandFolders()) {
    const meta = JSON.parse(fs.readFileSync(path.join(COMMANDS, name, 'command.json'), 'utf8'));
    for (const [key, value] of Object.entries(meta.limits || {})) {
      if (key === 'singleSlot') {
        if (typeof value !== 'boolean') problems.push(`${name}.${key} must be boolean`);
      } else if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`${name}.${key} must be a number, got ${typeof value}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('.env.example documents every variable the code reads', () => {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const expected = [
    'BOT_NAME', 'PREFIX', 'PAIR_NUMBER', 'MAX_LINKED_ACCOUNTS',
    'DASHBOARD_URL', 'BOT_SYNC_TOKEN', 'DASHBOARD_SYNC_INTERVAL_MS',
    'XJX_APISSUPREME_API_KEY', 'XJX_KNIGHTBOT_API_KEY', 'XJX_MEDIA_TIMEOUT_MS',
    'DRIME_API_TOKEN', 'DRIME_BASE_URL', 'DRIME_PAPERS_FOLDER_ID',
    'DRIME_PAPERS_FOLDER_HASH', 'DRIME_WORKSPACE_ID',
    'TMDB_API_KEY', 'TORRENT_DIRECT', 'LOG_LEVEL',
  ];
  const missing = expected.filter((name) => !example.includes(name));
  assert.deepEqual(missing, [], `.env.example is missing: ${missing.join(', ')}`);
});
