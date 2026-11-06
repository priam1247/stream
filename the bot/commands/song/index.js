'use strict';

// XJX's .song command: yt-search's first result, followed by the same
// external audio resolver sequence and Baileys URL delivery.
const config = require('../../config');
const media = require('../../lib/downloads/xjx');
const log = require('../../lib/logger')('song');

async function execute(sock, msg, args, extra) {
  const chatId = extra?.from || msg?.key?.remoteJid;
  const input = (Array.isArray(args) ? args : []).join(' ').trim();
  const reply = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
  if (!input) return reply('🎵 Please provide a song name or YouTube URL.');

  try {
    return await media.downloadSongCommand(sock, msg, extra, input);
  } catch (error) {
    log.warn(`request failed (${error?.code || 'FAILED'})`);
    if (error?.userMessage) return reply(`❌ ${error.userMessage}`);
    if (error?.code === 'NOT_FOUND') return reply('❌ No songs found for that search.');
    if (error?.code === 'NO_MEDIA') return reply('❌ Failed to fetch audio. Please try again later.');
    return reply('❌ Download failed. Please try again later.');
  }
}

module.exports = {
  name: 'song',
  aliases: ['play', 'yta'],
  category: 'media',
  description: 'Download audio from YouTube',
  usage: `${config.prefix || '.'}song <song name or URL>`,
  execute,
};
