#!/usr/bin/env node
'use strict';

/**
 * Live self-check (needs the network, and GRONKA_API_KEY for the download part).
 * Prints one line per source, so you can see what works before users find out:
 *
 *   node scripts/check-live.js
 *   CHECK_YT_URL=... CHECK_FB_URL=... CHECK_IG_URL=... node scripts/check-live.js
 *
 * The three CHECK_* links are optional sample links; each is sent to Gronka the
 * same way .song/.video/.fb/.instagram do (a real request counts toward the key's
 * quota of 50 per 10 minutes). Exit code is 1 when anything fails.
 */

try { require('dotenv').config({ quiet: true }); } catch { /* dotenv is optional here */ }
process.chdir(require('path').join(__dirname, '..'));

const gronka = require('../lib/downloads/gronka');

const samples = [
  ['.song (YouTube audio)', process.env.CHECK_YT_URL, { mode: 'audio' }],
  ['.video (YouTube video)', process.env.CHECK_YT_URL, { mode: 'auto' }],
  ['.fb (Facebook)', process.env.CHECK_FB_URL, { mode: 'auto' }],
  ['.instagram', process.env.CHECK_IG_URL, { mode: 'auto' }],
];

(async () => {
  let failed = 0;
  const health = await gronka.health();
  if (health.state === 'ok') console.log(`✅ Gronka reachable (${health.ms}ms)`);
  else { failed++; console.log(`${health.state === 'not-set' ? '⚠️' : '❌'} Gronka: ${health.reason}`); }

  for (const [label, url, options] of samples) {
    if (!url) { console.log(`➖ ${label}: no CHECK_* link given`); continue; }
    if (!gronka.enabled) { failed++; console.log(`❌ ${label}: GRONKA_API_KEY is not set`); continue; }
    const started = Date.now();
    try {
      const result = await gronka.download(url, options);
      console.log(`✅ ${label}: ${result.files.length} file(s) via ${result.lane || 'gronka'} in ${Date.now() - started}ms`);
    } catch (error) {
      failed++;
      console.log(`❌ ${label}: ${error.code} — ${error.userMessage || error.message}`);
    }
  }
  console.log('\nMovie/series sources: send .providers in WhatsApp for the live status of the 12 engine providers.');
  process.exit(failed ? 1 : 0);
})();
