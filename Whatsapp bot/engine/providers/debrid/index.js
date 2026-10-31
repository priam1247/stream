// src/providers/debrid/index.js — debrid link resolver (RealDebrid, AllDebrid).
// TorBox was removed in 3.3: its API requires a paid Pro plan, so it cannot
// ever work out of the box. The remaining debrids plug into the cascade:
// candidates from the torrent/ddl tiers are resolved through the first
// configured debrid that succeeds, with per-link caching in front.
//
// Note: the old TorBox-only "debridcache" tier 0 is gone with it —
// RealDebrid/AllDebrid links come out of the normal resolve path below,
// which is near-instant for cached torrents anyway.
import { createHash } from 'node:crypto';
import config from '../../config.js';
import cache from '../../core/cache.js';
import { metrics } from '../../core/metrics.js';
import realdebrid from './realdebrid.js';
import alldebrid from './alldebrid.js';

const ORDER = [
  ['realdebrid', () => config.realDebridKey, realdebrid],
  ['alldebrid', () => config.allDebridKey, alldebrid]
];

export const active = () => ORDER.filter(([, has]) => has());

/**
 * Verify the configured keys against the providers themselves.
 * Used by `.debrid` — a token that is present but rejected is worse than none.
 * @returns {Promise<Array<{provider:string, ok:boolean, error?:string}>>}
 */
export async function probe() {
  const configured = active();
  if (!configured.length) return [];
  return Promise.all(configured.map(async ([name, , mod]) => {
    try {
      const info = await mod.account();
      return { ...info, ok: true };
    } catch (e) {
      return { provider: name, ok: false, error: e.code ? `${e.code}: ${e.message}` : e.message };
    }
  }));
}

// ── resolve a candidate through the first debrid that succeeds ─────────────
export async function resolve(cand, opts = {}) {
  if (opts.signal?.aborted) throw opts.signal.reason || new Error('aborted');
  // A provider can return many magnets without a separate hash. Caching by
  // provider alone would hand a previous film's link to a different request.
  const identity = cand.hash ? `hash:${String(cand.hash).toLowerCase()}`
    : cand.magnet ? `magnet:${createHash('sha256').update(String(cand.magnet)).digest('hex')}` : null;
  const lk = identity && `link:${identity}:${cand.fileIdx ?? 0}:${opts.season ?? ''}:${opts.episode ?? ''}`;
  const cached = lk && cache.lget(lk);
  if (cached) {
    metrics.bump('cache.link');
    return { ...(typeof cached === 'string' ? { url: cached } : cached), cached: true };
  }

  let lastErr;
  for (const [, , mod] of active()) {
    try {
      const r = await mod.resolve(cand, opts);
      if (!r.url) throw new Error('no url');
      if (lk) cache.lset(lk, r);
      return r;
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason || e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('no debrid key configured (set REALDEBRID_API_KEY or ALLDEBRID_API_KEY)');
}

export default { resolve, active, probe };
