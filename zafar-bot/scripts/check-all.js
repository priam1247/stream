'use strict';

/**
 * scripts/check-all.js — run every command's check.js and print the board.
 *
 * Each check runs in its own child process with a timeout, so a check that hangs
 * or crashes cannot take the board down. Exit code is non-zero if anything fails.
 *
 *   npm run check-all
 *   npm run check-all -- --json
 *   npm run check-all -- song paper     # only these
 *
 * The board is written to storage/core/status.json as well, so `.status` in
 * WhatsApp shows what this run learned.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMMANDS = path.join(ROOT, 'commands');
const STATUS_FILE = path.join(ROOT, 'storage', 'core', 'status.json');
const CHECK_TIMEOUT_MS = 180_000;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const only = args.filter((a) => !a.startsWith('--'));

function discover() {
  return fs.readdirSync(COMMANDS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !name.startsWith('_'))
    .filter((name) => only.length === 0 || only.includes(name))
    .filter((name) => fs.existsSync(path.join(COMMANDS, name, 'check.js')))
    .sort();
}

function runOne(name) {
  return new Promise((resolve) => {
    const file = path.join(COMMANDS, name, 'check.js');
    const started = Date.now();
    const child = spawn(process.execPath, [file], {
      cwd: path.join(COMMANDS, name),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ name, ok: false, detail: `check timed out after ${CHECK_TIMEOUT_MS / 1000}s`, ms: Date.now() - started });
    }, CHECK_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timer);
      const text = (stdout || stderr).trim().split('\n').filter(Boolean);
      const last = text[text.length - 1] || '';
      const ok = code === 0 && last.startsWith('✅');
      const detail = last.replace(/^[✅❌]\s*\S+\s*—\s*/, '') || (code === 0 ? 'passed' : `exit ${code}`);
      resolve({ name, ok, detail, ms: Date.now() - started });
    });
  });
}

function writeStatus(results) {
  let current = { commands: {} };
  try {
    current = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    // No previous status: start a fresh one.
  }

  for (const r of results) {
    const previous = current.commands[r.name] || {};
    if (r.ok) {
      current.commands[r.name] = {
        state: 'ok',
        reason: '',
        lastOkAt: new Date().toISOString(),
        lastErrorAt: previous.lastErrorAt || null,
        source: 'check',
      };
    } else if (previous.state === 'disabled') {
      // A disabled command stays disabled; the check result does not re-enable it.
      continue;
    } else {
      current.commands[r.name] = {
        state: 'broken',
        reason: r.detail,
        lastOkAt: previous.lastOkAt || null,
        lastErrorAt: new Date().toISOString(),
        source: 'check',
      };
    }
  }

  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...current, savedAt: new Date().toISOString() }, null, 2));
}

function icon(result, disabled) {
  if (disabled) return '⛔';
  return result.ok ? '✅' : '❌';
}

function readDisabled() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage', 'core', 'disabled.json'), 'utf8'));
    return new Set(Object.keys(data.commands || {}));
  } catch {
    return new Set();
  }
}

async function main() {
  const names = discover();
  if (!names.length) {
    console.error('❌ no commands found to check');
    process.exit(1);
  }

  const disabled = readDisabled();
  const results = [];
  for (const name of names) {
    // Sequential on purpose: parallel heavy checks would fight over the network
    // and make a real failure look like a flake.
    results.push(await runOne(name));
  }

  writeStatus(results);

  if (asJson) {
    console.log(JSON.stringify({ results, at: new Date().toISOString() }, null, 2));
  } else {
    const width = Math.max(...results.map((r) => r.name.length)) + 2;
    for (const r of results) {
      const state = icon(r, disabled.has(r.name));
      const suffix = r.ok ? '' : ` → ${r.detail}`;
      console.log(`${state} ${r.name.padEnd(width)}${suffix}`);
    }
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log('');
    console.log(`${passed} passed · ${failed} failed · ${results.length} checked`);
  }

  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(`❌ check-all crashed: ${err.stack || err.message}`);
  process.exit(1);
});
