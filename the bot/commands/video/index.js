'use strict';

// XJX's .video command: yt-search's first result, then the EliteProTech video
// resolver (KnightBot followed by Keithsite) and direct Baileys URL delivery.
const config = require('../../config');
const media = require('../../lib/downloads/xjx');
const log = require('../../lib/logger')('video');

async function execute(sock, msg, args, extra) {
  const chatId = extra?.from || msg?.key?.remoteJid;
  const input = (Array.isArray(args) ? args : []).join(' ').trim();
  const reply = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
  if (!input) return reply('🎬 Please provide a video name or YouTube URL.');

  try {
    return await media.downloadVideoCommand(sock, msg, extra, input);
  } catch (error) {
    log.warn(`request failed (${error?.code || 'FAILED'})`);
    if (error?.userMessage) return reply(`❌ ${error.userMessage}`);
    if (error?.code === 'NOT_FOUND') return reply('❌ No videos found for that search.');
    if (error?.code === 'NO_MEDIA') return reply('❌ Failed to fetch video. Please try again later.');
    return reply('❌ Download failed. Please try again later.');
  }
}

module.exports = {
  name: 'video',
  aliases: ['ytmp4'],
  category: 'media',
  description: 'Download video from YouTube',
  usage: `${config.prefix || '.'}video <video name or URL>`,
  execute,
};
