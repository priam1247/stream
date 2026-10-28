'use strict';
/**
 * Zero-configuration launcher for the Scribd screenshot downloader panel.
 *
 * Discord/Pterodactyl panels run ONE startup command (node index.js) and give
 * the operator no shell and no environment variables. This module makes that
 * single process bring up the Python panel too, with everything hardcoded:
 *
 *   - it runs `downloader/start.sh`, which installs the pip packages and
 *     Chromium on first boot (cached afterwards) and then execs the panel;
 *   - it supervises the child and restarts it if it ever exits;
 *   - it kills the child when the bot stops, so a Restart never leaves orphans.
 *
 * The panel binds 0.0.0.0 on the dashboard's hardcoded 25811 AND on the
 * host's SERVER_PORT/PORT, so it works on either server without configuration.
 * Search + tick work even if Chromium cannot be downloaded.
 *
 * Nothing here can crash the bot: every failure is logged and swallowed.
 * Set SCRIBD_PANEL_AUTOSTART=0 to disable (optional; off by default in tests).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const START = path.join(ROOT, 'downloader', 'start.sh');

const MAX_RESTARTS = 8;
const RESTART_DELAY_MS = 4000;
const HEALTHY_AFTER_MS = 60000;

let child = null;
let restarts = 0;
let stopping = false;
let healthyTimer = null;

function log(msg) { try { console.log(`[scribd] ${msg}`); } catch { /* ignore */ } }
function warn(msg) { try { console.error(`[scribd] ${msg}`); } catch { /* ignore */ } }

function relay(stream, emit) {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) emit(line);
    }
  });
  stream.on('end', () => { if (buffer.trim()) emit(buffer.trim()); });
  stream.on('error', () => { /* ignore */ });
}

function stopChild() {
  stopping = true;
  if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null; }
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

function launch() {
  if (stopping) return;
  let spawned;
  try {
    spawned = spawn('bash', [START], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    warn(`could not start downloader: ${err.message}`);
    return;
  }
  child = spawned;
  relay(spawned.stdout, log);
  relay(spawned.stderr, warn);

  spawned.on('error', (err) => warn(`downloader process error: ${err.message}`));
  spawned.on('exit', (code, signal) => {
    if (child === spawned) child = null;
    if (stopping) return;
    if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null; }
    // A long-lived child resets the restart budget.
    if (restarts >= MAX_RESTARTS) {
      warn('downloader stopped repeatedly; giving up. Check the console above.');
      return;
    }
    restarts += 1;
    warn(`downloader exited (code ${code}, signal ${signal || 'none'}); restarting in ${RESTART_DELAY_MS / 1000}s (${restarts}/${MAX_RESTARTS}).`);
    const timer = setTimeout(launch, RESTART_DELAY_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  // If it stayed up this long, consider the restart budget refreshed.
  healthyTimer = setTimeout(() => { restarts = 0; healthyTimer = null; }, HEALTHY_AFTER_MS);
  if (healthyTimer && typeof healthyTimer.unref === 'function') healthyTimer.unref();
}

function start() {
  // Guard against hot-reload / double require (index.js clears its module cache).
  if (process.__scribdLauncherStarted) return;
  if (process.env.SCRIBD_PANEL_AUTOSTART === '0') return;
  if (/\b(selftest|mocha|jest)\b/.test(path.basename(process.argv[1] || ''))) return;
  if (!fs.existsSync(START)) {
    log('downloader/start.sh not present — panel not started (add the downloader/ folder).');
    return;
  }
  process.__scribdLauncherStarted = true;

  process.once('exit', stopChild);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try { process.once(signal, stopChild); } catch { /* ignore */ }
  }

  log('auto-start enabled · no env vars needed · binding 0.0.0.0:25811 (+ host port)');
  launch();
}

module.exports = { start };
