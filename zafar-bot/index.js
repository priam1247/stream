#!/usr/bin/env node
'use strict';

/**
 * index.js — the entry point.
 *
 *   npm start          → node --expose-gc index.js
 *   node index.js      → same
 *   node .             → same (package.json "main")
 *   pm2 start ecosystem.config.js
 *
 * This exists so the project is an ordinary Node project: a panel, pm2, systemd
 * or a bare `node .` can all find it without knowing the gateway/ layout.
 *
 * It CALLS start() rather than just requiring the gateway. Requiring alone was
 * the bug that took the bot down: gateway/index.js only ran its boot under
 * `require.main === module`, so when this wrapper required it, boot never ran,
 * nothing held the event loop, and the process exited 0 — which a panel reports
 * as a crash and refuses to restart.
 */

const { start } = require('./gateway/index.js');

start();
