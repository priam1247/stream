'use strict';

/**
 * commands/sticker/index.js — reply to an image/video with .sticker
 *
 * Preserved from the old commands/general/sticker.js: same aliases (s, stiker,
 * stc), same 50 MB input cap, same ~1 MB animated-sticker cap, same ffmpeg
 * arguments, same pack metadata.
 *
 * Structural change: the old command imported the shared `utils/ffmpeg.js`
 * (which fell back from a system binary to a packaged one) and the shared
 * `tempManager`. This command owns both: `ffmpeg.js` here picks exactly one
 * binary and throws if it is missing, and every temp file lands in ctx.tmp.
 *
 * Media bytes are fetched by the gateway (ctx.download) because only the
 * gateway holds the Baileys socket. The command receives a file path.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webp = require('node-webpmux');
const meta = require('./command.json');
const { ffmpegPath, runFfmpeg } = require('./ffmpeg');

const SCALE = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000';

async function run(ctx) {
  // 1. validate: there must be a quoted media message
  const quoted = ctx.quoted;
  if (!quoted) {
    return ctx.reply('📎 Reply to an image or video with .sticker');
  }
  const mediaType = quoted.type;
  if (!['imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].includes(mediaType)) {
    return ctx.reply('📎 Reply to an image or video with .sticker');
  }

  const maxBytes = meta.limits.maxSizeMB * 1024 * 1024;
  const declared = Number(quoted.raw?.[mediaType]?.fileLength || 0);
  if (declared && declared > maxBytes) {
    return ctx.reply(`❌ File too large: ${(declared / 1048576).toFixed(2)}MB (max: ${meta.limits.maxSizeMB}MB)`);
  }

  // 2. ask the gateway for the bytes, straight into this job's folder
  const input = path.join(ctx.tmp, `sticker_${crypto.randomBytes(4).toString('hex')}_in`);
  await ctx.download(input);

  const size = fs.existsSync(input) ? fs.statSync(input).size : 0;
  if (!size) {
    return ctx.reply('❌ Failed to download media. Please try again.');
  }
  if (size > maxBytes) {
    return ctx.reply(`❌ File too large: ${(size / 1048576).toFixed(2)}MB (max: ${meta.limits.maxSizeMB}MB)`);
  }

  // 3. convert
  const isAnimated = /gif|video/.test(String(quoted.raw?.[mediaType]?.mimetype || ''))
    || Number(quoted.raw?.[mediaType]?.seconds || 0) > 0;

  const out = path.join(ctx.tmp, 'sticker.webp');
  const args = isAnimated
    ? ['-i', input, '-vf', `${SCALE},fps=15`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '75', '-compression_level', '6', out]
    : ['-i', input, '-vf', `${SCALE},format=rgba`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '75', '-compression_level', '6', out];

  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', ...args], ctx.log);

  let bytes = fs.readFileSync(out);

  // Same compression attempt as the old bot for animated stickers over ~1 MB.
  if (isAnimated && bytes.length > meta.limits.maxAnimatedKB * 1024) {
    const smaller = path.join(ctx.tmp, 'sticker-small.webp');
    const large = size / 1024 > 5000;
    const retry = large
      ? ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-t', '2', '-vf', `${SCALE},fps=8`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '30', '-compression_level', '6', '-b:v', '100k', smaller]
      : ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-t', '3', '-vf', `${SCALE},fps=12`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '45', '-compression_level', '6', '-b:v', '150k', smaller];
    await runFfmpeg(retry, ctx.log);
    if (fs.existsSync(smaller) && fs.statSync(smaller).size > 0) bytes = fs.readFileSync(smaller);
  }

  // 4. pack metadata, exactly as the old bot
  const img = new webp.Image();
  await img.load(bytes);
  const json = {
    'sticker-pack-id': 'zafar-bot',
    'sticker-pack-name': process.env.PACK_NAME || 'Stickers',
    'sticker-pack-publisher': process.env.BOT_NAME || 'WhatsApp',
    emojis: ['🎨'],
  };
  const exif = Buffer.concat([
    Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]),
    Buffer.from(JSON.stringify(json), 'utf8'),
  ]);
  exif.writeUIntLE(Buffer.from(JSON.stringify(json), 'utf8').length, 14, 4);
  img.exif = exif;

  const final = path.join(ctx.tmp, 'sticker-final.webp');
  fs.writeFileSync(final, await img.save(null));

  // 5. send
  await ctx.send.document(final, '', 'sticker.webp');
  return undefined;
}

module.exports = { run, ffmpegPath };
