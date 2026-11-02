'use strict';

/**
 * commands/ig/check.js — live self-test.
 *
 * Two stages so the failure is unambiguous:
 *   1. URL validation must reject a non-Instagram link (offline, always testable)
 *   2. the ruhend resolver must return media for the sample (needs network)
 */

const meta = require('./command.json');
const urls = require('./urls');
const scraper = require('./scraper');
const log = { debug() {}, info() {}, warn() {}, error() {} };

async function check() {
  // stage 1 — validation
  let rejected = false;
  try { urls.normalize('https://example.com/not-instagram'); } catch (err) {
    if (err.code !== 'BAD_LINK') throw new Error(`wrong error code for a bad link: ${err.code}`);
    rejected = true;
  }
  if (!rejected) throw new Error('a non-Instagram link was not rejected');

  // stage 2 — provider
  const normalized = urls.normalize(meta.sample);
  const items = await scraper.resolve(normalized.href, { log, maxItems: meta.limits.maxItems });
  if (!items.length) throw new Error('resolver returned no items');
  return `${items.length} item(s), first is ${items[0].kind}`;
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => { console.log(`❌ ${meta.name} — ${e.code ? e.code + ': ' : ''}${e.message}`); process.exit(1); });
}
module.exports = { check };
