'use strict';

/**
 * commands/providers/index.js — the movie provider list.
 *
 * The old commands/general/providers.js queried a live engine registry that
 * reported per-provider health. That registry lived in the shared engine, which
 * now belongs to .movie and .series individually; the gateway must not reach
 * into another command's folder.
 *
 * This version reports the provider identities that .movie and .series ship
 * with, without claiming a live health state it cannot observe.
 */

const PROVIDERS = [
  ['moviebox', 'stream'],
  ['vidlink', 'stream'],
  ['vidsrc', 'stream'],
  ['vaplayer', 'stream'],
  ['yts', 'torrent'],
  ['torrentio', 'torrent'],
  ['eztv', 'torrent'],
  ['nyaa', 'torrent'],
  ['knaben', 'torrent'],
  ['solidtorrents', 'torrent'],
  ['torrentscsv', 'torrent'],
  ['apibay', 'torrent'],
];

async function run(ctx) {
  const lines = ['*Movie providers*', ''];
  for (const [name, kind] of PROVIDERS) {
    lines.push(`• ${name} · ${kind}`);
  }
  lines.push('', 'Health is reported by .movie / .series when they run, not here.');
  return ctx.reply(lines.join('\n'));
}

module.exports = { run, PROVIDERS };
