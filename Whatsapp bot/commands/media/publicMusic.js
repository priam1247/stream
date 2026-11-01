/** Title-only searches for creator-permitted Audius and Wikimedia Commons media. */
const config = require('../../config');
const settings = require('../../utils/mediaSettings');
const selections = require('../../utils/selections');
const queue = require('../../utils/jobQueue');
const audius = require('../../utils/audius');
const commons = require('../../utils/commonsMedia');
const delivery = require('../../utils/publicMediaDelivery');

function parse(args, isCommons) {
  const words = [];
  let first = false;
  let kind = 'audio';
  let sendAs = String(settings.get('songSendAs', config.song?.sendAs || 'document')).toLowerCase();
  for (const value of Array.isArray(args) ? args : []) {
    const word = String(value || '');
    if (/^--?first$/i.test(word)) first = true;
    else if (isCommons && /^--(?:audio|video)$/i.test(word)) kind = word.slice(2).toLowerCase();
    else if (/^--as-audio$/i.test(word)) sendAs = 'audio';
    else if (/^--as-document$/i.test(word)) sendAs = 'document';
    else words.push(word);
  }
  return { query: words.join(' ').trim(), first, kind, sendAs };
}

function containsUrl(input) {
  return /(?:https?:\/\/|(?:^|\s)(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?\/\S*)/i.test(input);
}

function makeCommand(isCommons) {
  const name = isCommons ? 'commons' : 'audius';
  const label = isCommons ? 'Wikimedia Commons' : 'Audius';
  return {
    name, aliases: [], category: 'media',
    description: isCommons ? 'Search public-domain and Creative Commons audio or music videos' : 'Search Audius tracks that allow public downloads',
    usage: isCommons ? '.commons <title> [--audio|--video]' : '.audius <title>',
    async execute(sock, msg, args, extra) {
      const chat = extra?.from || msg.key.remoteJid;
      const say = (text) => sock.sendMessage(chat, { text }, { quoted: msg });
      const prefix = config.prefix || '.';
      const options = parse(args, isCommons);
      const context = msg?.message?.extendedTextMessage?.contextInfo
        || msg?.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo;
      const quoted = context?.quotedMessage;
      const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || quoted?.imageMessage?.caption || quoted?.videoMessage?.caption || '';
      if (containsUrl(options.query) || (!options.query && containsUrl(quotedText))) {
        return say(`This shortcut searches titles only. To download a link, use ${prefix}dl <link>.`);
      }
      if (!options.query) return say(`Usage: ${prefix}${isCommons ? 'commons <title> [--audio|--video]' : 'audius <title>'}`);
      if (options.query.length > 200) return say('Search titles must be 200 characters or fewer.');

      const client = isCommons ? commons.createClient() : audius.createClient();
      await say(`Searching ${label}...`);
      let results;
      try {
        results = await queue.runInLane('search', () => client.search(options.query, {
          limit: Number(config.search?.maxResults) || 5, ...(isCommons ? { kind: options.kind } : {}),
        }));
      } catch { return say(`${label} search is unavailable right now. Please try again later.`); }
      if (!results.length) return say(isCommons
        ? `No ${options.kind} files with usable license information found on Commons. Try a different title.`
        : 'No Audius tracks allowing public downloads found. Try a different title.');

      const send = (socket, message, context, item) => delivery.sendPublicMedia(socket, message, context, {
        kind: options.kind, label, sendAs: options.sendAs,
        ...(isCommons ? { attribution: commons.attributionFor } : {}),
        download: (dest, limits) => isCommons
          ? client.downloadItem(item.id, dest, { ...limits, kind: options.kind })
          : client.downloadTrack(item.id, dest, limits),
      });
      if (options.first) return send(sock, msg, extra, results[0]);

      const lines = results.map((item, index) => {
        const seconds = Math.round(item.duration);
        const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        return `*${index + 1}.* ${item.title} — ${item.artist} (${time})${isCommons ? ` · ${item.license}` : ''}`;
      });
      return selections.sendTextPrompt(sock, msg, extra, {
        text: `*${label} results*\n${lines.join('\n')}\n\nReply ${prefix}1–${prefix}${results.length} or ${prefix}cancel.`,
        items: results, label: name,
        ttlMs: Math.max(1, Number(config.search?.ttlMinutes) || 5) * 60000,
        run: (socket, message, context, item) => send(socket, message, context, item),
      });
    },
  };
}

module.exports = [makeCommand(false), makeCommand(true)];
