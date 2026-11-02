'use strict';

/**
 * .mdiag — test every brick of the standalone media engine on this host.
 *
 *   .mdiag                       run all checks with the default query
 *   .mdiag <search phrase>       use your own query for the search checks
 *
 * Prints one line per brick so a broken host is diagnosable without reading
 * logs. It never downloads a full file: it only checks reachability, client
 * rotation, format selection and the SoundCloud client id.
 */

const config = require('../../config');
const C = require('../../utils/ownMedia/constants');
const http = require('../../utils/ownMedia/http');
const clients = require('../../utils/ownMedia/clients');
const formats = require('../../utils/ownMedia/formats');
const soundcloud = require('../../utils/ownMedia/soundcloud');
const convert = require('../../utils/ownMedia/convert');

const DEFAULT_QUERY = 'namadingo tuli';
const clean = (v) => String(v ?? '').trim();
const short = (v, n = 64) => {
  const s = clean(v).replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

async function check(label, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { label, ok: true, detail: clean(detail), ms: Date.now() - started };
  } catch (err) {
    return {
      label, ok: false, ms: Date.now() - started,
      detail: `${err?.code || 'FAILED'}: ${short(err?.message)}`,
    };
  }
}

module.exports = {
  name: 'mdiag',
  aliases: ['mediadiag', 'ownmedia'],
  category: 'media',
  description: 'Test every brick of the standalone music/media downloader on this host',
  usage: '.mdiag [search phrase]',

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
    const query = clean(args.join(' ')) || DEFAULT_QUERY;
    const lines = [`🔧 *ownMedia diagnostics*\n🔎 query: _${query}_\n`];
    const rows = [];

    const ffmpeg = await check('ffmpeg binary', async () => {
      if (!convert.works()) throw Object.assign(new Error('No runnable ffmpeg'), { code: 'FFMPEG_MISSING' });
      return 'available (@ffmpeg-installer)';
    });
    rows.push(ffmpeg);

    rows.push(await check('HTTPS transport', async () => {
      const res = await http.request('GET', C.YT_ORIGIN, { headers: { Accept: 'text/html' } });
      return `youtube.com → HTTP ${res.status}`;
    }));

    let playerResult = null;
    rows.push(await check('YouTube player (client rotation)', async () => {
      const { result, attempts } = await clients.player('dQw4w9WgXcQ');
      playerResult = result;
      const tried = attempts.map((a) => `${a.client}:${a.ok ? 'OK' : a.status}`).join(', ');
      return `${result.client} / ${result.playabilityStatus} / ${result.formats.length} formats (${tried})`;
    }));

    rows.push(await check('format selection', async () => {
      const result = playerResult || {
        formats: [], hlsManifestUrl: '', dashManifestUrl: '',
      };
      const audio = formats.chooseAudio(result);
      const video = formats.chooseVideo(result, 720);
      if (!audio && !video) throw Object.assign(new Error('No downloadable formats'), { code: 'NO_FORMATS' });
      return `audio: ${audio?.label || 'none'} | video: ${video?.label || 'none'}`;
    }));

    rows.push(await check('YouTube public search', async () => {
      const rowsFound = await clients.search(query, { limit: 5 });
      if (!rowsFound.length) throw Object.assign(new Error('No results parsed'), { code: 'NO_RESULTS' });
      return `${rowsFound.length} results — first: ${short(rowsFound[0].title, 40)}`;
    }));

    rows.push(await check('SoundCloud client id', async () => {
      const id = await soundcloud.getClientId();
      return `client_id ${id.slice(0, 6)}…${id.slice(-4)}`;
    }));

    rows.push(await check('SoundCloud search', async () => {
      const found = await soundcloud.search(query, { limit: 5 });
      if (!found.length) throw Object.assign(new Error('No public tracks'), { code: 'NO_RESULTS' });
      return `${found.length} tracks — first: ${short(found[0].title, 40)}`;
    }));

    for (const row of rows) {
      lines.push(`${row.ok ? '✅' : '❌'} *${row.label}* (${row.ms}ms)\n   ${row.detail || 'ok'}`);
    }
    const failed = rows.filter((r) => !r.ok).length;
    lines.push('', failed
      ? `⚠️ ${failed} brick(s) failed. Music commands route through *ownMedia* only — fix the failing brick, then retry *${config.prefix || '.'}mfind ${query}*.`
      : `✅ All bricks reachable. Try *${config.prefix || '.'}mfind ${query}* now.`);
    return say(lines.join('\n'));
  },
};
