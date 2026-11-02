/**
 * Command menu
 *
 * One clean, aligned card. Grouped by what the user is trying to do, honouring
 * configured `config.prefix`, and hiding admin-only
 * commands from regular users.
 *
 *   .menu          everything permitted for the caller
 *   .menu media    only the media section
 */

const config = require('../../config');
const { safeErrorMessage } = require('../../utils/userErrors');

function buildGroups(prefix = '.', { isOwner = false } = {}) {
  const p = prefix || '.';
  const groups = [
    {
      key: 'media',
      title: 'MEDIA',
      rows: [
        [`${p}movie <title> [year]`, 'movie'],
        [`${p}series <title> s01e01`, 'series'],
        [`${p}dramabox <bookId> [episode]`, 'DramaBox stream link'],
        [`${p}song <name|url>`, 'MP3'],
        [`${p}mfind <name|link>`, 'music search'],
        [`${p}embed <link>`, 'resolve an embed link'],
        [`${p}mdiag`, 'test media sources'],
        [`${p}video <name|url>`, 'MP4'],
        [`${p}tiktok ${p}x`, 'social'],
        [`${p}instagram ${p}fb`, 'social'],
        [`${p}reddit <title>`, 'title search'],
        [`${p}spotify <url|title>`, 'Spotify MP3'],
        [`${p}sticker ${p}viewonce`, 'reply tools'],
      ],
    },
    {
      key: 'papers',
      title: 'PAPERS',
      rows: [
        [`${p}paper <code> [mod] [yr]`, 'past papers'],
        [`${p}paper browse [code]`, 'browse'],
        [`${p}countpapers`, 'vault count'],
        ...(isOwner ? [[`${p}refreshpapers`, 'sync vault']] : []),
      ],
    },
    {
      key: 'engine',
      title: 'ENGINE',
      rows: [
        [`${p}providers`, 'providers'],
        [`${p}moviestatus`, 'engine stats'],
        [`${p}info <title>`, 'metadata'],
      ],
    },
  ];

  if (isOwner) {
    groups.push({
      key: 'admin',
      title: 'ADMIN',
      rows: [
        [`${p}allow ${p}disallow ${p}listusers`, 'whitelist'],
        [`${p}on ${p}off`, 'enable/disable the service globally'],
        [`${p}restart ${p}status`, 'server'],
      ],
    });
  }

  groups.push({
    key: 'general',
    title: 'GENERAL',
    rows: [
      [`${p}ping`, 'latency'],
      [`${p}menu`, 'commands'],
    ],
  });

  return groups;
}

const SECTION_ALIASES = {
  movie: 'media', movies: 'media', song: 'media', video: 'media', reddit: 'media',
  paper: 'papers', papers: 'papers',
  engine: 'engine', sources: 'engine', status: 'engine',
  admin: 'admin', all: null, help: null,
};

function buildCard(groups) {
  const out = ['*COMMANDS*'];
  for (const group of groups) {
    out.push('', `*${group.title}*`);
    for (const [command] of group.rows) out.push(command);
  }
  return out.join('\n');
}

module.exports = {
  name: 'menu',
  aliases: ['help', 'commands'],
  category: 'general',
  description: 'Show all commands',
  usage: '.menu [section]',

  async execute(sock, msg, args, extra) {
    try {
      const isOwner = Boolean(extra?.isOwner);
      const prefix = config.prefix || '.';

      const wanted = String(args[0] || '').toLowerCase();
      const section = wanted in SECTION_ALIASES ? SECTION_ALIASES[wanted] : null;
      if (section === 'admin' && !isOwner) {
        return extra.reply(config.messages?.ownerOnly || '❌ This section is restricted.');
      }

      const allGroups = buildGroups(prefix, { isOwner });
      const groups = section ? allGroups.filter((g) => g.key === section) : allGroups;

      await sock.sendMessage(extra.from, {
        text: buildCard(groups.length ? groups : allGroups, null, { prefix }),
      }, { quoted: msg });
    } catch (err) {
      console.error('[menu] error:', err.message);
      await extra.reply(safeErrorMessage(err, { isOwner: Boolean(extra?.isOwner) }));
    }
  },

  _buildCard: buildCard,
  _buildGroups: buildGroups,
};
