'use strict';
/**
 * Scribd search + download panel — standalone entry point.
 *
 * This folder (`scribd/`) is ONE deployable app for the Python server
 * (XS Systems, 195.123.189.187:25811). It does not import anything from the
 * WhatsApp bot, so it can be uploaded on its own.
 *
 * Startup command on the panel:  node index.js
 *
 * What it does, with no configuration and no shell commands:
 *   1. inflates the bundled Chromium (@sparticuz/chromium) into /tmp,
 *   2. installs the pinned Python dependencies on first boot,
 *   3. runs the screenshot panel, which binds 0.0.0.0:25811 and the host's
 *      SERVER_PORT/PORT at once,
 *   4. restarts it if it exits, and stops it when this process stops.
 *
 * The browser and the Python panel are one process group: press Restart and
 * everything comes back up.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const APP = path.join(HERE, 'downloader', 'app.py');
const LAUNCHER = path.join(HERE, 'utils', 'scribdLauncher.js');

process.env.SCRIBD_PANEL_PORT = process.env.SCRIBD_PANEL_PORT || '25811';

function pythonBin() {
  const explicit = (process.env.PYTHON_BIN || '').trim();
  if (explicit) return explicit;
  return process.platform === 'win32' ? 'python' : 'python3';
}

// `node index.js --selftest` runs the panel's offline checks (no browser, no
// network) and exits with its status. Handy for verifying an upload.
if (process.argv.includes('--selftest')) {
  const child = spawn(pythonBin(), ['-m', 'downloader.app', '--selftest'], {
    cwd: HERE,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
  child.on('error', (err) => {
    console.error(`[scribd] could not run python: ${err.message}`);
    process.exit(1);
  });
  return;
}

if (!fs.existsSync(APP)) {
  console.error('[scribd] downloader/app.py is missing — upload the whole scribd/ folder.');
  process.exit(1);
}
if (!fs.existsSync(LAUNCHER)) {
  console.error('[scribd] utils/scribdLauncher.js is missing — upload the whole scribd/ folder.');
  process.exit(1);
}

console.log('[scribd] Scribd search + download panel starting…');
console.log(`[scribd] folder: ${HERE}`);
console.log('[scribd] Chromium, Python deps and ports are configured automatically.');

require(LAUNCHER).start();

// The launcher owns the child, but keep this process alive even if the child's
// pipes close, so the panel is never orphaned by an early exit.
const keepAlive = setInterval(() => {}, 1 << 30);
process.on('exit', () => clearInterval(keepAlive));
