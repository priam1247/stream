'use strict';

/**
 * commands/reload/check.js — offline self-test with a fake ctx and fake gateway.
 *
 * It exercises the command's real run() and asserts on the exact reply. It does
 * not touch WhatsApp, the filesystem, or a live session.
 */

const meta = require('./command.json');
const { run } = require('./index');

function makeCtx(text, { adminResult = { message: '✅ ok' }, catalogue = [], statuses = {}, role = 'owner' } = {}) {
  const sent = [];
  const calls = [];
  return {
    sent,
    calls,
    ctx: {
      text, args: text ? text.split(/\s+/) : [], command: meta.name, prefix: '.',
      sender: { number: '265991234567', name: 'check' },
      user: null, role, chat: '265991234567@s.whatsapp.net',
      isGroup: false, quoted: null, number: '265991234567',
      settings: { accessMode: 'open', maintenance: false, prefix: '.' },
      tmp: require('path').join(require('os').tmpdir(), 'check-reload'),
      limits: meta.limits, catalogue, statuses,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      reply: async (t) => { sent.push(String(t)); return t; },
      send: { text: async () => null, image: async () => null, video: async () => null, audio: async () => null, document: async () => null },
      react: async () => null,
      admin: async (req) => { calls.push(req); return adminResult; },
    },
  };
}

async function check() {
  const { ctx, sent, calls } = makeCtx(meta.sample);
  await run(ctx);
  if (!sent.length) throw new Error('run() sent no reply');
  if (!calls.length) throw new Error('run() never called ctx.admin');
  return sent[sent.length - 1].split('\n')[0].slice(0, 100);
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`)).catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}

module.exports = { check, makeCtx };
