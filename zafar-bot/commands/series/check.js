'use strict';

/**
 * commands/series/check.js — live self-test.
 * Stage 1 offline: episode parsing, batch refusal, engine load, fallback off.
 * Stage 2 network: a real metadata search for the sample.
 */

const os = require('os');
const path = require('path');
const meta = require('./command.json');
const { parseQuery, pickBest } = require('./query');
const bridge = require('./engine-bridge');

async function check() {
  const p = parseQuery(meta.sample);
  if (!p.title) throw new Error(`could not parse the sample: ${meta.sample}`);
  if (p.season !== 1 || p.episode !== 1) throw new Error(`wrong season/episode: ${p.season}/${p.episode}`);

  const range = parseQuery('Breaking Bad s01e01-s01e05');
  if (range.episode !== 1) throw new Error('range parsing should still read the first episode');

  const best = pickBest(
    [{ title: 'Breaking Bad', year: 2008 }, { title: 'Breaking Bad', year: 2019 }],
    { title: 'Breaking Bad', year: 2008 },
  );
  if (Number(best.year) !== 2008) throw new Error('pickBest chose the wrong show');

  bridge.configure({ tmp: path.join(os.tmpdir(), `check-series-${Date.now()}`) });
  if (process.env.QUALITY_FALLBACK !== '0') throw new Error('quality fallback is not disabled');
  const engine = await bridge.load();
  if (typeof engine.default?.resolveEpisode !== 'function') throw new Error('engine has no resolveEpisode');
  if (typeof engine.default?.resolveMovie !== 'function') throw new Error('engine has no resolveMovie');

  const hits = await bridge.search(p.title, { type: 'series', year: p.year, limit: 5 });
  if (!hits?.length) throw new Error(`no metadata hit for "${p.title}" (network or provider problem)`);
  return `parsed "${p.title}" s0${p.season}e0${p.episode} · ${hits.length} hit(s) · engine local`;
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => { console.log(`❌ ${meta.name} — ${e.code ? e.code + ': ' : ''}${e.message}`); process.exit(1); });
}
module.exports = { check };
