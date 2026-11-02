'use strict';

/**
 * Shared delivery helper for the music commands.
 *
 * Resolves a link or a search phrase, offers the existing scoped numbered
 * picker for collections/searches, finds a public upload and hands it to the
 * bot's normal media pipeline (yt-dlp → Innertube → remote providers → verify
 * → tag → send). Audio and music video use the same source; only `kind`
 * changes, so both work without any account or key.
 */

const config = require('../../config');
const C = require('./constants');
const sources = require('./index');
const mediaPipeline = require('../mediaPipeline');
const selections = require('../selections');

const PREFIX = () => config.prefix || '.';
const clean = (value) => String(value ?? '').trim();

function mmss(ms) {
  const seconds = Math.round((Number(ms) || 0) / 1000);
  if (!seconds) return '';
  return ` (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')})`;
}

function friendly(err) {
  switch (err?.code) {
    case 'LAYOUT_CHANGED': return 'Spotify changed its embed page. Try a direct YouTube link.';
    case 'NOT_FOUND': return 'That link has no playable tracks.';
    case 'BAD_URL': return 'That does not look like a supported music link.';
    case 'NO_CLIENT_ID': return 'SoundCloud metadata is unavailable; try a YouTube link or search by name.';
    case 'UNSAFE_URL': return 'That link points at an unsupported host.';
    default: return 'Could not resolve that music link.';
  }
}

/**
 * @param {object} sock Baileys socket
 * @param {object} msg original message (for quoting / reactions)
 * @param {object} extra handler extras
 * @param {{input:string, kind?:'audio'|'video', height?:number, sendAs?:string,
 *          firstHit?:boolean, maxResults?:number, picker?:boolean}} opts
 */
async function deliverMusic(sock, msg, extra, opts = {}) {
  const {
    input, kind = 'audio', height = 720, sendAs = '', firstHit = false,
    maxResults = 5, picker = true,
  } = opts;
  const text = clean(input);
  const say = async (s, m, body) => s.sendMessage(extra?.from || m.key.remoteJid, { text: body }, { quoted: m }).catch(() => {});
  const react = (s, m, emoji) => s.sendMessage(extra?.from || m.key.remoteJid, {
    react: { text: emoji, key: m.key },
  }).catch(() => {});

  if (!text) return say(sock, msg, 'Usage: .mfind <name or music link> [audio|video]');

  const send = (s, m, e, url, meta = {}) => mediaPipeline.downloadAndSend(s, m, e, {
    url,
    kind,
    height,
    sendAs,
    lane: kind === 'audio' ? 'light' : 'heavy',
    attempts: [],
    title: meta.title || '',
    author: meta.author || '',
    album: meta.album || '',
    lyrics: meta.lyrics || '',
    cover: meta.cover || null,
  });

  const deliverTrack = async (track, s, m, e) => {
    if (!track?.title) return say(s, m, '❌ That result has no track information.');
    const found = await sources.findUpload(track, { video: kind === 'video' });
    if (!found) return say(s, m, '❌ Could not find a public upload for that track.');
    await react(s, m, '📥');

    let lyricsText = '';
    let cover = null;
    if (kind === 'audio') {
      const [foundLyrics, foundCover] = await Promise.all([
        sources.getLyrics(track).catch(() => null),
        sources.fetchCover(track.cover).catch(() => null),
      ]);
      lyricsText = foundLyrics?.plain || '';
      cover = foundCover;
    }
    return send(s, m, e, found.url, {
      title: track.title,
      author: (track.artists || []).join(', '),
      album: track.album || '',
      lyrics: lyricsText,
      cover,
    });
  };

  const deliverCollection = (collection, s, m, e) => {
    const tracks = collection?.tracks || [];
    if (!tracks.length) return say(s, m, '❌ No playable tracks in that link.');
    if (tracks.length === 1 || firstHit || !picker) return deliverTrack(tracks[0], s, m, e);

    const items = tracks.slice(0, C.MAX_PICKER_ITEMS);
    const lines = [
      `🎵 *${clean(collection.name) || 'Collection'}*${collection.owner ? `\n👤 ${collection.owner}` : ''}`,
      '',
      ...items.map((track, i) => `*${i + 1}.* ${track.title} — ${(track.artists || []).join(', ')}${mmss(track.durationMs)}`),
      '',
      `Reply *${PREFIX()}1*–*${PREFIX()}${items.length}* or *${PREFIX()}cancel*.`,
    ];
    return selections.sendTextPrompt(s, m, e, {
      text: lines.join('\n'),
      image: collection.cover || items[0]?.cover || null,
      items,
      label: 'music',
      ttlMs: 5 * 60 * 1000,
      run: (s2, m2, e2, item) => deliverTrack(item, s2, m2, e2),
    });
  };

  const deliverResult = async (item, s, m, e) => {
    const resolved = await sources.resolveSearchItem(item).catch(() => null);
    if (!resolved) return say(s, m, '❌ Could not open that result.');
    if (resolved.type === 'direct') {
      const track = resolved.track || sources.resultToTrack(item);
      return send(s, m, e, resolved.url, {
        title: track.title, author: (track.artists || []).join(', '),
      });
    }
    if (resolved.type === 'collection') return deliverCollection(resolved.collection, s, m, e);
    return deliverTrack(resolved.track || sources.resultToTrack(item), s, m, e);
  };

  const deliverSearch = async (query, s, m, e) => {
    const results = await sources.searchAll(query, { limit: Math.max(5, maxResults) });
    if (!results.length) return say(s, m, '❌ No results found.');
    if (results.length === 1 || firstHit || !picker) return deliverResult(results[0], s, m, e);
    const items = results.slice(0, Math.max(1, maxResults));
    const lines = [
      `🔎 *${query}*`,
      '',
      ...items.map((row, i) => `*${i + 1}.* ${row.name}${row.subtitle ? ` — ${row.subtitle}` : ''}${mmss(row.durationMs)} *[${row.source}]*`),
      '',
      `Reply *${PREFIX()}1*–*${PREFIX()}${items.length}* or *${PREFIX()}cancel*.`,
    ];
    return selections.sendTextPrompt(s, m, e, {
      text: lines.join('\n'),
      image: items[0]?.cover || null,
      items,
      label: 'music',
      ttlMs: 5 * 60 * 1000,
      run: (s2, m2, e2, item) => deliverResult(item, s2, m2, e2),
    });
  };

  // 1. A normal YouTube / SoundCloud / YouTube Music upload goes straight to
  //    the existing pipeline; no catalog lookup is needed.
  const direct = sources.normalizeDirectUrl(text);
  if (direct) return send(sock, msg, extra, direct);

  // 2. A music-service link resolves to metadata, then to a public upload.
  if (sources.isMusicLink(text)) {
    let resolved;
    try { resolved = await sources.resolveUrl(text); }
    catch (err) {
      await react(sock, msg, '❌');
      return say(sock, msg, `❌ ${friendly(err)}`);
    }
    if (!resolved) return say(sock, msg, '❌ Unsupported music link.');
    if (resolved.type === 'direct') return send(sock, msg, extra, resolved.url);
    return deliverCollection(resolved.collection, sock, msg, extra);
  }

  // 3. A plain phrase fans out to every keyless catalog.
  return deliverSearch(text, sock, msg, extra);
}

module.exports = { deliverMusic, isMusicInput: sources.isMusicLink, friendly, mmss };
