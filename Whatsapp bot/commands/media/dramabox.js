'use strict';

// XJX's .dramabox command: resolve a book ID + episode and return its stream URL.
const config = require('../../config');
const dramabox = require('../../utils/xjxDramaBox');
const log = require('../../utils/logger')('dramabox');

const USAGE = (prefix) =>
  `❌ Usage: ${prefix}dramabox <bookId> [episode]\n\nExample: ${prefix}dramabox 41000105764 1`;

async function execute(sock, msg, args, extra) {
  const chatId = extra?.from || msg?.key?.remoteJid;
  const prefix = config.prefix || '.';
  const input = Array.isArray(args) ? args : [];
  const bookId = String(input[0] || '').trim();
  if (!bookId) {
    const text = USAGE(prefix);
    return extra?.reply ? extra.reply(text) : sock.sendMessage(chatId, { text }, { quoted: msg });
  }

  const episodeToken = input[1] === undefined ? 1 : input[1];
  let request;
  try {
    request = dramabox.validateRequest(bookId, episodeToken);
  } catch {
    const text = USAGE(prefix);
    return extra?.reply ? extra.reply(text) : sock.sendMessage(chatId, { text }, { quoted: msg });
  }
  const { bookId: validatedBookId, episode } = request;

  try { await sock.sendMessage(chatId, { react: { text: '🎭', key: msg.key } }); }
  catch { /* best effort; do not block the resolver */ }

  try {
    const result = await dramabox.getDramaBoxStream(validatedBookId, episode);
    let body = [
      '🎭 *DramaBox Stream*',
      '',
      `📚 Book ID: ${bookId}`,
      `📺 Episode: ${episode}`,
    ].join('\n');
    if (result.url) {
      body += `\n\n▶️ *Stream Link:*\n${result.url}`;
      if (result.title) body += `\n\n🎬 ${result.title}`;
      if (result.quality) body += `\n📹 Quality: ${result.quality}`;
    } else {
      body += `\n\n📦 Response:\n${result.responseText}`;
    }
    return sock.sendMessage(chatId, { text: `┏━━━ 🎭 *DramaBox* ━━━\n\n${body}\n\n┗━━━━━━━━━━━━━━━━` }, { quoted: msg });
  } catch (error) {
    log.warn(`request failed (${error?.code || 'FAILED'})`);
    const text = '❌ Could not retrieve this DramaBox episode. Check the book ID and episode, then try again.';
    return extra?.reply ? extra.reply(text) : sock.sendMessage(chatId, { text }, { quoted: msg });
  }
}

module.exports = {
  name: 'dramabox',
  aliases: ['drama', 'dramastream'],
  category: 'media',
  description: 'Get a DramaBox episode stream link',
  usage: `${config.prefix || '.'}dramabox <bookId> [episode]`,
  execute,
};
