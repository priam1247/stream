'use strict';

/**
 * commands/viewonce/index.js — reveal a view-once message.
 *
 * Preserved from the old commands/general/viewonce.js: same aliases (readvo,
 * read, vv, readviewonce), same reply when there is nothing to reveal, same
 * handling of all four view-once envelope shapes.
 *
 * Structural change: media bytes come from ctx.download (the gateway owns the
 * socket); the file lands in this job's folder and is deleted by the gateway
 * after the send.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const meta = require('./command.json');

const ENVELOPES = ['viewOnceMessageV2', 'viewOnceMessageV2Extension', 'viewOnceMessage', 'viewOnce'];

function innerOf(quoted) {
  for (const envelope of ENVELOPES) {
    if (quoted?.[envelope]?.message) return quoted[envelope].message;
  }
  const direct = ['imageMessage', 'videoMessage', 'audioMessage'].find((k) => quoted?.[k]?.viewOnce);
  if (direct) return { [direct]: quoted[direct] };
  return null;
}

function kindOf(inner) {
  if (!inner) return null;
  if (inner.imageMessage) return { kind: 'image', ext: 'jpg', raw: inner.imageMessage };
  if (inner.videoMessage) return { kind: 'video', ext: 'mp4', raw: inner.videoMessage };
  if (inner.audioMessage) return { kind: 'audio', ext: 'ogg', raw: inner.audioMessage };
  return null;
}

async function run(ctx) {
  // 1. validate
  if (!ctx.quoted) {
    return ctx.reply('Reply to a view-once message.');
  }

  const inner = innerOf(ctx.quoted.raw);
  if (!inner) {
    return ctx.reply('That message is not a view-once message.');
  }

  const media = kindOf(inner);
  if (!media) {
    return ctx.reply('That view-once message has no media to reveal.');
  }

  const declared = Number(media.raw.fileLength || 0);
  const maxBytes = meta.limits.maxSizeMB * 1024 * 1024;
  if (declared && declared > maxBytes) {
    return ctx.reply(`❌ That media is ${(declared / 1048576).toFixed(1)}MB; the limit is ${meta.limits.maxSizeMB}MB.`);
  }

  // 2. fetch the bytes through the gateway
  const dest = path.join(ctx.tmp, `viewonce-${crypto.randomBytes(4).toString('hex')}.${media.ext}`);
  await ctx.download(dest);
  if (!fs.existsSync(dest) || !fs.statSync(dest).size) {
    throw new Error('the view-once media downloaded as an empty file');
  }

  // 3. resend as a normal message
  if (media.kind === 'image') await ctx.send.image(dest);
  else if (media.kind === 'video') await ctx.send.video(dest);
  else await ctx.send.audio(dest);

  await ctx.react('👁️');
  return undefined;
}

module.exports = { run, innerOf, kindOf };
