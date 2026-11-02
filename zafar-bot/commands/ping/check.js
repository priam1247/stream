'use strict';

/**
 * commands/ping/check.js — live self-test. No network, no WhatsApp.
 */

const meta = require('./command.json');
const { run } = require('./index');

function ctx() {
  const sent = [];
  return {
    sent,
    ctx: {
      text: '', args: [], command: 'ping', prefix: '.',
      sender: { number: '000000000', name: 'check' },
      user: null, role: 'owner', chat: '000000000@s.whatsapp.net',
      isGroup: false, quoted: null,
      settings: { accessMode: 'open', maintenance: false, prefix: '.' },
      tmp: require('path').join(require('os').tmpdir(), 'check-ping'),
      limits: meta.limits,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      reply: async (t) => { sent.push(t); return t; },
      send: { text: async () => null, image: async () => null, video: async () => null, audio: async () => null, document: async () => null },
      react: async () => null,
    },
  };
}

async function check() {
  const { ctx: c, sent } = ctx();
  await run(c);
  const last = String(sent[sent.length - 1] || '');
  if (!/^🏓 \*Pong!\* · \d+ms$/.test(last)) {
    throw new Error(`expected the Pong line, got ${JSON.stringify(sent)}`);
  }
  return last;
}

if (require.main === module) {
  check().then((d) => { console.log(`✅ ${meta.name} — ${d}`); }).catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}

module.exports = { check };
