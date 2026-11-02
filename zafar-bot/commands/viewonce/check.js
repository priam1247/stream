'use strict';

/**
 * commands/viewonce/check.js — offline. The envelope shapes are the only logic
 * here, and they are exactly what break when WhatsApp changes them.
 */

const meta = require('./command.json');
const { innerOf, kindOf } = require('./index');

async function check() {
  const cases = [
    ['viewOnceMessageV2', { viewOnceMessageV2: { message: { imageMessage: { viewOnce: true, fileLength: 1000 } } } }, 'image'],
    ['viewOnceMessageV2Extension', { viewOnceMessageV2Extension: { message: { videoMessage: { viewOnce: true } } } }, 'video'],
    ['viewOnceMessage', { viewOnceMessage: { message: { audioMessage: { viewOnce: true } } } }, 'audio'],
    ['plain image with viewOnce flag', { imageMessage: { viewOnce: true } }, 'image'],
  ];

  for (const [label, quoted, expected] of cases) {
    const inner = innerOf(quoted);
    if (!inner) throw new Error(`envelope not unwrapped: ${label}`);
    const kind = kindOf(inner);
    if (!kind) throw new Error(`media kind not detected: ${label}`);
    if (kind.kind !== expected) throw new Error(`${label}: expected ${expected}, got ${kind.kind}`);
  }

  if (innerOf({ imageMessage: {} })) throw new Error('a normal image was treated as view-once');
  if (innerOf(null)) throw new Error('null quoted message was not handled');

  return `${cases.length} envelope shapes + 2 negatives verified`;
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}
module.exports = { check };
