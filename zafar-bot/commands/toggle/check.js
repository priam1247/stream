'use strict';

const meta = require('./command.json');
const { run } = require('./index');

const CATALOGUE = [{ name: 'ping', aliases: ['p'], category: 'general', description: 'x', usage: '.ping', role: 'user' }];

function makeCtx(text, catalogue = CATALOGUE) {
  const sent = []; const calls = [];
  return {
    sent, calls,
    ctx: {
      text, args: text ? text.split(/\s+/) : [], command: 'toggle', prefix: '.',
      sender: { number: '265991234567', name: 'check' },
      user: null, role: 'admin', chat: '265991234567@s.whatsapp.net',
      isGroup: false, quoted: null, number: '265991234567',
      settings: { accessMode: 'open', maintenance: false, prefix: '.' },
      tmp: require('path').join(require('os').tmpdir(), 'check-toggle'),
      limits: meta.limits, catalogue, statuses: {},
      log: { debug() {}, info() {}, warn() {}, error() {} },
      reply: async (t) => { sent.push(String(t)); return t; },
      send: { text: async () => null, image: async () => null, video: async () => null, audio: async () => null, document: async () => null },
      react: async () => null,
      admin: async (req) => { calls.push(req); return { message: '⛔ .ping disabled.' }; },
    },
  };
}

async function check() {
  const ok = makeCtx(meta.sample);
  await run(ok.ctx);
  if (ok.calls[0]?.extra !== 'ping') throw new Error('did not ask the gateway to toggle ping');
  if (!ok.sent[0].includes('disabled')) throw new Error('did not relay the gateway result');

  const empty = makeCtx('');
  await run(empty.ctx);
  if (!/Usage/.test(empty.sent[0])) throw new Error('empty input did not show usage');
  if (empty.calls.length) throw new Error('empty input still reached the gateway');

  const unknown = makeCtx('nosuchcommand');
  await run(unknown.ctx);
  if (!/No command named/.test(unknown.sent[0])) throw new Error('unknown command was not refused locally');
  if (unknown.calls.length) throw new Error('unknown command still reached the gateway');

  return 'toggle/usage/unknown verified';
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`)).catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}
module.exports = { check };
