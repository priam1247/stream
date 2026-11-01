// Temporary, opt-in real-network movie-source audit. Blender Foundation films
// Big Buck Bunny and Sintel are CC BY 3.0. Do not print returned URLs/tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
process.env.LOG_LEVEL = 'error';
process.env.MOVIE_HLS_ENGINE = 'ffmpeg';
process.env.NM3U8DL_DISABLE_AUTOINSTALL = '1';
process.env.TORRENT_METADATA_TIMEOUT_MS = '45000';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movie-audit-'));
process.env.TEMP_DIR = dir;
process.env.JOB_DIR = dir;
process.env.DATA_DIR = dir;
process.env.CACHE_FILE = path.join(dir, 'cache.json');
const { registry, metadata } = await import('../engine/media/index.js');
const { resolveCandidate } = await import('../engine/core/resolver.js');
const { download } = await import('../engine/media/downloader.js');
const ffmpeg = (await import('../utils/ffmpeg.js')).default;
const samples = [
  { type: 'movie', title: 'Big Buck Bunny', year: '2008', imdbId: 'tt1254207', tmdbId: 10378, runtime: '10 min' },
  { type: 'movie', title: 'Sintel', year: '2010', imdbId: 'tt1727587', tmdbId: 45745, runtime: '15 min' },
];
const timers = new Set();
const bounded = (promise, ms) => Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), ms); timers.add(t); })]);
const opts = (s) => ({ quality: 480, want: 480, year: s.year, query: `${s.title} ${s.year}`, anime: false, old: true, maxMB: 300 });
const start = Date.now();
const found = [];
await Promise.all(registry.providers.map(async (p) => {
  if (!p.supports.includes('movie')) {
    // Only search an ordinary series to confirm this series-only endpoint's
    // implementation responds; do not download copyrighted content.
    const s = { type: 'series', title: 'Breaking Bad', year: '2008', imdbId: 'tt0903747', tmdbId: 1396 };
    try {
      const c = await bounded(p.search(s, { ...opts(s), season: 1, episode: 1, query: 'Breaking Bad S01E01' }), 35000);
      console.log(`AUDIT ${p.id}: series-search=${c.length ? 'candidates' : 'empty'} count=${c.length}`);
    } catch(e) { console.log(`AUDIT ${p.id}: series-search=failed ${e.code || e.status || e.name}`); }
    return;
  }
  let errors = [];
  for (const sample of samples) {
    try {
      const candidates = await bounded(p.search(sample, opts(sample)), 35000);
      const safe = candidates.filter(c => c && (c.url || c.magnet));
      console.log(`AUDIT ${p.id}: ${sample.title} search=${safe.length ? 'candidates' : 'empty'} count=${safe.length}`);
      if (safe.length) { found.push({ p, sample, candidates: safe }); break; }
    } catch(e) { errors.push(e.code || e.status || e.name); console.log(`AUDIT ${p.id}: ${sample.title} search=failed ${e.code || e.status || e.name}`); }
  }
}));
for (const sample of samples) {
  try {
    const hits = await bounded(metadata.cinemeta.search(sample.title, 'movie'), 12000);
    const match = hits.find(x => x.imdbId === sample.imdbId);
    const detail = match && await bounded(metadata.cinemeta.details(match), 12000);
    console.log(`AUDIT cinemeta ${sample.title}: search=${hits.length} imdb=${Boolean(match)} tmdb=${Boolean(detail?.tmdbId || match?.tmdbId)}`);
  } catch(e) { console.log(`AUDIT cinemeta ${sample.title}: failed ${e.code || e.name}`); }
}
await Promise.all(found.map(async ({ p, sample, candidates }) => {
  // Only try exact licensed titles, and do not log CDN URLs or magnet hashes.
  const suitable = candidates.filter(c => c.kind !== 'torrent' || (/big[. _-]*buck[. _-]*bunny|sintel/i.test(c.title || '') && c.seeds >= 1 && (!c.sizeMB || c.sizeMB < 300)));
  const candidate = suitable.sort((a, b) => Math.abs((a.quality || 480) - 480) - Math.abs((b.quality || 480) - 480))[0];
  if (!candidate) { console.log(`AUDIT ${p.id}: complete=not-attempted (no suitable candidate)`); return; }
  try {
    let resolved;
    try { resolved = await bounded(resolveCandidate(candidate, opts(sample)), 20000); }
    catch(e) {
      console.log(`AUDIT ${p.id}: verification=failed ${e.code || e.name}`);
      if (candidate.kind === 'torrent') throw e;
      resolved = { ...candidate, quality: candidate.quality || 480 };
    }
    const dest = path.join(dir, `${p.id}.mp4`);
    const result = await bounded(download(resolved, dest), 180000);
    const file = result.file || dest;
    const size = fs.statSync(file).size;
    execFileSync(ffmpeg(), ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 120000, stdio: 'ignore' });
    console.log(`AUDIT ${p.id}: complete=decoded bytes=${size}`);
  } catch(e) { console.log(`AUDIT ${p.id}: complete=failed ${e.code || e.status || e.name}`); }
}));
console.log(`AUDIT elapsed=${Date.now() - start}ms`);
for (const t of timers) clearTimeout(t);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
