'use strict';

const meta = require('./command.json');
const { run } = require('./index');

const CATALOGUE = [
  { name: 'ping', aliases: ['p'], category: 'general', description: 'Check response time', usage: '.ping', role: 'user' },
  { name: 'status', aliases: [], category: 'admin', description: 'Health board', usage: '.status', role: 'owner' },
];

function make(text, role) {
  const sent = [];
  return {
    sent,
    ctx: {
      text, args: text ? text.split(' ') : [], command: 'menu', prefix: '.',
      sender: { number: '000000000', name: 'check' },
      user: null, role, chat: '000000000@s.whatsapp.net',
      isGroup: false, quoted: null,
      settings: { accessMode: 'open', maintenance: false, prefix: '.' },
      tmp: require('path').join(require('os').tmpdir(), 'check-menu'),
      limits: meta.limits, catalogue: CATALOGUE, statuses: {},
      log: { debug() {}, info() {}, warn() {}, error() {} },
      reply: async (t) => { sent.push(t); return t; },
      send: { text: async () => null, image: async () => null, video: async () => null, audio: async () => null, document: async () => null },
      react: async () => null,
    },
  };
}

async function check() {
  const { ctx, sent } = make('', 'user');
  await run(ctx);
  const text = String(sent[0] || '');
  if (!text.includes('.ping')) throw new Error('menu did not list .ping');
  if (text.includes('.status')) throw new Error('menu leaked an owner-only command to a plain user');

  const admin = make('', 'owner');
  await admin.run ? null : null;
  const { ctx: actx, sent: asent } = make('', 'owner');
  await run(actx);
  if (!String(asent[0] || '').includes('.status')) throw new Error('owner could not see .status');

  const single = make('general', 'user');
  await run(single.ctx);
  if (!String(single.sent[0] || '').includes('.ping')) throw new Error('section filter lost .ping');

  return `${text.split('\n')[0]} (owner rows filtered for users)`;
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`)).catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}

module.exports = { check };
