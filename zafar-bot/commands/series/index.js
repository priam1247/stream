'use strict';

/**
 * commands/series/index.js — .series <title> s01e01
 *
 * Preserved from the old commands/media/series.js: same name, same aliases
 * (tvshow, episode), same usage shape, same 720p default, same 2000 MB ceiling.
 *
 * CHANGED, deliberately and reported in MIGRATION_REPORT.md:
 *   - lane "single": one series job at a time, enforced by the gateway.
 *   - ONE episode per command. The old command could take a batch (up to
 *     MOVIE_BATCH_LIMIT=10); a batch is exactly what let one request fill the
 *     disk. `maxEpisodesPerRun: 1` is a hard limit here, and asking for more is
 *     refused before anything is downloaded.
 *   - the engine's quality fallback is off (engine-bridge.js).
 */

const meta = require('./command.json');
const bridge = require('./engine-bridge');
const { parseQuery, pickBest } = require('./query');

async function run(ctx) {
  const input = String(ctx.text || '').trim();

  // 1. validate
  if (!input) return ctx.reply(`Usage: ${meta.usage}`);
  if (input.length > meta.limits.maxInputChars) {
    return ctx.reply(`❌ That search is too long (max ${meta.limits.maxInputChars} characters).`);
  }

  const { title, season, episode, year } = parseQuery(input);
  if (!title) return ctx.reply(`Usage: ${meta.usage}`);
  if (season === null || episode === null) {
    return ctx.reply(`❌ Include the episode, e.g. *${ctx.prefix}series ${title} s01e01*`);
  }
  // A range or comma list is a batch: refused before any work.
  if (/[,&-]\s*s?\d/.test(input.replace(/^\s*\S.*?(s\d{1,2}\s*e\d{1,3})/i, '$1'))) {
    return ctx.reply(`❌ One episode per command (max ${meta.limits.maxEpisodesPerRun}). Ask again for the next one.`);
  }

  await ctx.react('📺');

  bridge.configure({
    tmp: ctx.tmp,
    maxSendMB: meta.limits.maxSizeMB,
    maxDownloadMB: meta.limits.maxSizeMB,
    quality: 720,
  });

  // 2. find the show
  const hits = await bridge.search(title, { type: 'series', year, limit: 5 });
  const best = pickBest(hits, { title, year });
  if (!best) return ctx.reply(`❌ Not found: *${title}*`);

  // 3. limits before downloading
  const runtime = Number(best.episodeRuntime || best.runtime) || 0;
  if (runtime && runtime > meta.limits.maxDurationMin) {
    return ctx.reply(`❌ Episode runtime is ${runtime} min; the limit is ${meta.limits.maxDurationMin} min.`);
  }

  // 4. resolve one episode. engine.default is the public API.
  const engine = await bridge.load();
  const resolved = await engine.default.resolveEpisode({
    item: best,
    tmdbId: best.tmdbId || best.id,
    title: best.title,
    year: best.year,
    season,
    episode,
    quality: 720,
    exclude: [],
  });
  if (!resolved?.url) {
    throw new Error(
      `no source for ${title} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')} at 720p (quality fallback is disabled)`,
    );
  }

  if (resolved.sizeMB && resolved.sizeMB > meta.limits.maxSizeMB) {
    return ctx.reply(`❌ That episode is ${Math.round(resolved.sizeMB)} MB; the limit is ${meta.limits.maxSizeMB} MB.`);
  }

  // 5. send
  const label = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  await ctx.send.text(`📺 *${best.title}* ${label}\n${resolved.quality || 720}p\n${resolved.url}`);
  return undefined;
}

module.exports = { run };
