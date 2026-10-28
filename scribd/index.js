'use strict';
/**
 * Scribd panel — Botkeep entry point (Node + Chromium).
 *
 * This is the half that has the browser. It searches Scribd, screenshots each
 * page with the bundled Chromium, builds the PDF, and hands the finished file
 * to the Python storage server on XS Systems.
 *
 * Startup command on this server:  node index.js
 * Nothing to configure: the port comes from the host, cookies from
 * cookies.txt if you uploaded one, and the storage address is hardcoded.
 *
 *   node index.js             serve
 *   node index.js --selftest  offline checks (no browser, no network)
 *   node index.js --health    print health JSON and exit
 */

const path = require('path');

const config = require('./config');

if (process.argv.includes('--selftest')) {
  require('./selftest')
    .run()
    .then((code) => process.exit(code));
} else if (process.argv.includes('--health')) {
  process.stdout.write(
    JSON.stringify({ ok: true, version: config.VERSION, role: 'panel', locked: Boolean(config.panelKey()) }) + '\n',
  );
} else {
  process.env.PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
  console.log(`[panel] Scribd panel v${config.VERSION}`);
  console.log(`[panel] folder: ${path.resolve(__dirname)}`);
  require('./panel').serve();
}
