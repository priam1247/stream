'use strict';
/**
 * Scribd search + download panel — entry point for BOTH servers.
 *
 * The panel is split across two machines that work hand in hand:
 *
 *   Botkeep  (JS, this folder)  ──HTTP──►  XS Systems (Python, 25811)
 *   no Python, no downloader/              does the Chromium screenshots
 *
 * Startup command on either server is the same: `node index.js`. It picks a
 * mode from what is actually on disk, so one folder can be uploaded to either
 * box without configuration:
 *
 *   • `downloader/` present  → this box IS the Python panel. Prepare the
 *     bundled Chromium, install the pinned Python deps, run the screenshot
 *     panel on 0.0.0.0:25811 + the host's assigned port. (XS Systems)
 *
 *   • `downloader/` absent   → this box is the JS front door. Serve the panel
 *     (search UI, JSON routes, PDF downloads) by forwarding to the Python
 *     panel at SCRIBD_PANEL_URL, hardcoded to http://195.123.189.187:25811.
 *     No Python needed. (Botkeep)
 *
 * `node index.js --selftest` checks whichever mode applies and exits with the
 * result. Nothing here needs an environment variable.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const APP = path.join(HERE, 'downloader', 'app.py');
const LAUNCHER = path.join(HERE, 'scribdLauncher.js');
const wantsSelftest = process.argv.includes('--selftest');
const hasPythonPanel = fs.existsSync(APP);

function pythonBin() {
  const explicit = (process.env.PYTHON_BIN || '').trim();
  if (explicit) return explicit;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** XS Systems mode: this box runs the Python screenshot panel. */
function runPythonPanel() {
  if (!fs.existsSync(LAUNCHER)) {
    console.error('[scribd] downloader/ is here but scribdLauncher.js is missing — upload the whole folder.');
    process.exit(1);
  }
  console.log('[scribd] Python panel mode (this box does the screenshots)');
  console.log(`[scribd] folder: ${HERE}`);
  console.log('[scribd] Chromium, Python deps and ports are configured automatically.');
  require(LAUNCHER).start();

  // Keep this process alive even if the child's pipes close, so the panel can
  // never be orphaned by an early exit.
  process.on('exit', () => {});
  setInterval(() => {}, 1 << 30);
}

/** Botkeep mode: JS front door that forwards to the Python panel. */
function runFrontDoor() {
  console.log('[scribd] JS front-door mode (screenshots run on the Python server)');
  console.log(`[scribd] folder: ${HERE}`);
  require('./proxy').serve();
}

if (wantsSelftest) {
  if (hasPythonPanel) {
    const child = spawn(pythonBin(), ['-m', 'downloader.app', '--selftest'], {
      cwd: HERE,
      stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code === null ? 1 : code));
    child.on('error', (err) => {
      console.error(`[scribd] could not run python: ${err.message}`);
      console.error('[scribd] this box has downloader/ but no Python — upload the JS-only folder to the JS server.');
      process.exit(1);
    });
  } else {
    require('./proxy')
      .selftest()
      .then((code) => process.exit(code));
  }
} else if (hasPythonPanel) {
  runPythonPanel();
} else {
  runFrontDoor();
}
