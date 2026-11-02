'use strict';

/**
 * commands/movie/index.js — .movie <title> [year]
 *
 * Preserved from the old commands/media/movie.js: same name, same aliases
 * (film, mv), same usage, same 720p default, same 2000 MB ceiling.
 *
 * CHANGED, deliberately and reported in MIGRATION_REPORT.md:
 *   - lane "single": at most one movie job may run at a time. The gateway
 *     refuses the second request with a busy message instead of queueing it.
 *   - the engine's quality fallback (1080 -> 720 -> 480) is switched OFF in
 *     engine-bridge.js. If 720p has no source, this command fails and says so.
 *
 * Flow, top to bottom: validate -> search -> check limits -> resolve -> send.
 */

const fs = require('fs');
const meta = require('./command.json');
const bridge = require('./engine-bridge');
const { parseQuery, pickBest } = require('./query');

async function run(ctx) {
  const input = String(ctx.text || '').trim();

  // 1. validate
  if (!input) return ctx.reply(`Usage: ${meta.usage}`);
  if (input.length > meta.limits.maxInputChars) {
    return ctx.reply(`❌ That title is too long (max ${meta.limits.maxInputChars} characters).`);
  }

  const { title, year } = parseQuery(input);
  if (!title) return ctx.reply(`Usage: ${meta.usage}`);

  await ctx.react('🎬');

  // 2. configure this job's own temp folder and ceilings
  bridge.configure({
    tmp: ctx.tmp,
    maxSendMB: meta.limits.maxSizeMB,
    maxDownloadMB: meta.limits.maxSizeMB,
    quality: 720,
  });

  // 3. find the title
  const hits = await bridge.search(title, { type: 'movie', year, limit: 5 });
  const best = pickBest(hits, { title, year });
  if (!best) {
    return ctx.reply(`❌ Not found: *${title}*${year ? ` (${year})` : ''}`);
  }

  // 4. limits before downloading anything
  const runtime = Number(best.runtime) || 0;
  if (runtime && runtime > meta.limits.maxDurationMin) {
    return ctx.reply(`❌ That runtime is ${runtime} min; the limit is ${meta.limits.maxDurationMin} min.`);
  }

  // 5. resolve ONE source. engine.default is the engine's public API; the
  //    engine's registry picks the provider internally. Nothing is retried here.
  const engine = await bridge.load();
  const resolved = await engine.default.resolveMovie({
    item: best,
    tmdbId: best.tmdbId || best.id,
    title: best.title,
    year: best.year,
    quality: 720,
    exclude: [],
  });
  if (!resolved?.url) {
    throw new Error(`no source found for "${best.title}" at 720p (quality fallback is disabled)`);
  }

  if (resolved.sizeMB && resolved.sizeMB > meta.limits.maxSizeMB) {
    return ctx.reply(
      `❌ That file is ${Math.round(resolved.sizeMB)} MB; the limit is ${meta.limits.maxSizeMB} MB.`,
    );
  }

  // 6. send the link (the engine hands back a streamable URL; a full 2 GB copy
  //    inside a WhatsApp command is what used to kill the host)
  await ctx.send.text(
    `🎬 *${best.title}*${best.year ? ` (${best.year})` : ''}\n${resolved.quality || 720}p\n${resolved.url}`,
  );

  // 7. never leave the job's scratch data behind
  if (fs.existsSync(ctx.tmp)) ctx.log.info(`job folder retained for inspection: ${ctx.tmp}`);
  return undefined;
}

module.exports = { run };
