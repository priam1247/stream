'use strict';

const meta = require('./command.json');
const { run } = require('./index');

const CATALOGUE = [
  { name: 'ping', aliases: ['p'], category: 'general', description: 'x', usage: '.ping', role: 'user' },
  { name: 'movie', aliases: [], category: 'media', description: 'y', usage: '.movie <title>', role: 'user' },
  { name: 'ig', aliases: [], category: 'media', description: 'z', usage: '.ig <link>', role: 'user' },
  { name: 'song', aliases: [], category: 'media', description: 'w', usage: '.song <q>', role: 'user' },
];
const STATUSES = {
  ping: { state: 'ok', reason: '', lastOkAt: new Date().toISOString() },
  movie: { state: 'disabled', reason: 'disabled by admin' },
  ig: { state: 'broken', reason: 'snapsave returned 403', lastOkAt: new Date(Date.now() - 7200_000).toISOString() },
  song: { state: 'ok', reason: '' },
};

function makeCtx(text) {
  const sent = [];
  return { sent, ctx: {
    text, args: text ? [text] : [], command: 'status', prefix: '.',
    sender: { number: '265991234567', name: 'check' }, user: null, role: 'admin',
    chat: '265991234567@s.whatsapp.net', isGroup: false, quoted: null, number: '265991234567',
    settings: { accessMode: 'open', maintenance: false, prefix: '.' },
    tmp: require('path').join(require('os').tmpdir(), 'check-status'),
    limits: meta.limits, catalogue: CATALOGUE, statuses: STATUSES,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    reply: async (t) => { sent.push(String(t)); return t; },
    send: { text: async () => null, image: async () => null, video: async () => null, audio: async () => null, document: async () => null },
    react: async () => null, admin: async () => ({ message: 'n/a' }),
  } };
}

async function check() {
  const board = makeCtx('');
  await run(board.ctx);
  const text = board.sent[0];
  for (const expected of ['✅ .ping', '❌ .ig', 'snapsave returned 403', 'last ok:', '⛔ .movie']) {
    if (!text.includes(expected)) throw new Error(`board is missing ${JSON.stringify(expected)}`);
  }
  if (!text.includes('❌ 1')) throw new Error('board did not count the broken command');

  const one = makeCtx('ig');
  await run(one.ctx);
  if (!one.sent[0].includes('snapsave returned 403')) throw new Error('detail view lost the reason');

  return 'board + detail verified';
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`)).catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}
module.exports = { check };
