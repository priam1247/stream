'use strict';

/**
 * commands/movie/check.js — live self-test.
 *
 * Stage 1 is offline and must always pass: query parsing, the 720p fallback-free
 * configuration, and the engine loading from its own folder.
 * Stage 2 needs network: a real metadata search for the sample title.
 */

const meta = require('./command.json');
const { parseQuery, pickBest } = require('./query');
const bridge = require('./engine-bridge');
const os = require('os');
const path = require('path');

const log = { debug() {}, info() {}, warn() {}, error() {} };

async function check() {
  // stage 1a — parsing
  const p = parseQuery(meta.sample);
  if (!p.title) throw new Error(`could not parse the sample: ${meta.sample}`);
  if (/2010$/.test(p.title)) throw new Error('year was not stripped from the title');

  const best = pickBest(
    [{ title: 'Inception', year: 2010 }, { title: 'Inception', year: 2020 }],
    { title: 'Inception', year: 2010 },
  );
  if (Number(best.year) !== 2010) throw new Error('pickBest chose the wrong year');

  // stage 1b — engine loads from its own folder, fallback disabled
  bridge.configure({ tmp: path.join(os.tmpdir(), `check-movie-${Date.now()}`) });
  if (process.env.QUALITY_FALLBACK !== '0') throw new Error('quality fallback is not disabled');
  await bridge.load();

  // stage 2 — real metadata search
  const hits = await bridge.search(p.title, { type: 'movie', year: p.year, limit: 5 });
  if (!hits?.length) throw new Error(`no metadata hit for "${p.title}" (network or provider problem)`);
  return `parsed "${p.title}" (${p.year}) · ${hits.length} hit(s) · engine local`;
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => { console.log(`❌ ${meta.name} — ${e.code ? e.code + ': ' : ''}${e.message}`); process.exit(1); });
}
module.exports = { check };
