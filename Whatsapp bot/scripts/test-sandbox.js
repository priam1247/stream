'use strict';

// Offline tests must never write to the installed bot's live database, session,
// cookies, downloaded binaries, or .env. Copy only source code into a private
// temporary fixture and share the installed (read-only) dependencies.
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['commands', 'engine', 'utils', 'scripts'];
const SOURCE_FILES = ['index.js', 'handler.js', 'config.js', 'database.js', 'package.json', 'package-lock.json', 'Procfile'];
const SKIP_DIRS = new Set(['node_modules', 'database', 'session', 'temp', 'tmp', 'data', 'bin', 'secrets', 'cookies']);

function sourceOnly(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return false;
  if (stat.isDirectory()) return !SKIP_DIRS.has(path.basename(file));
  const name = path.basename(file);
  return name === 'package.json' || /\.(?:js|cjs|mjs|sh|py)$/.test(name);
}

function createBotFixture(parent, source = SOURCE_ROOT) {
  const root = path.join(parent, 'bot-source');
  fs.mkdirSync(root, { recursive: true });
  for (const name of SOURCE_DIRS) {
    const from = path.join(source, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(root, name), { recursive: true, filter: sourceOnly });
  }
  for (const name of SOURCE_FILES) {
    const from = path.join(source, name);
    if (fs.existsSync(from) && !fs.lstatSync(from).isSymbolicLink()) fs.copyFileSync(from, path.join(root, name));
  }
  const modules = path.join(source, 'node_modules');
  if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(root, 'node_modules'), 'dir');
  return root;
}

// Tests deliberately use synthetic config; inherited host secrets and absolute
// runtime paths could otherwise point fixture code at the real installation.
function clearHostConfig() {
  const keep = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'GITHUB_ACTIONS', 'CI', 'NO_COLOR', 'FORCE_COLOR']);
  for (const name of Object.keys(process.env)) {
    const upper = name.toUpperCase();
    // node:test uses these internally to report individual cases to its parent.
    if (!keep.has(upper) && !upper.startsWith('NODE_TEST_')) delete process.env[name];
  }
}

module.exports = { createBotFixture, clearHostConfig };
