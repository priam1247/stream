'use strict';

const meta = require('./command.json');
const { run } = require('./index');

function makeCtx(text, sessions) {
  const sent = []; const calls = [];
  return { sent, calls, ctx: {
    text, args: text ? text.split(/\s+/) : [], command: 'sessions', prefix: '.',
    sender: { number: '265991234567', name: 'check' }, user: null, role: 'owner',
    chat: '265991234567@s.whatsapp.net', isGroup: false, quoted: null, number: '265991234567',
    settings: { accessMode: 'open', maintenance: false, prefix: '.' },
    tmp: require('path').join(require('os').tmpdir(), 'check-sessions'),
    limits: meta.limits, catalogue: [], statuses: {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    reply: async (t) => { sent.push(String(t)); return t; },
    send: { text: async () => null, image: async () => null, video: async () => null, audio: async () => null, document: async () => null },
    react: async () => null,
    admin: async (req) => {
      calls.push(req);
      if (req.action === 'sessions-status') return { sessions };
      return { message: `🔗 Pairing code for ${req.extra}: ABCD-1234` };
    },
  } };
}

async function check() {
  const two = makeCtx('', [
    { number: '265991234567', state: 'open' },
    { number: '265900000301', state: 'closed', lastError: 'simulated 428' },
  ]);
  await run(two.ctx);
  const text = two.sent[0];
  if (!text.includes('265991234567') || !text.includes('265900000301')) throw new Error('did not list both numbers');
  if (!text.includes('🟢') || !text.includes('🟠')) throw new Error('did not show per-session state');
  if (!text.includes('simulated 428')) throw new Error('did not show the session error');

  const none = makeCtx('', []);
  await run(none.ctx);
  if (!/No sessions/.test(none.sent[0])) throw new Error('empty session list not handled');

  const link = makeCtx('link 265999999999', []);
  await run(link.ctx);
  if (link.calls[0]?.action !== 'sessions-link' || link.calls[0]?.extra !== '265999999999') {
    throw new Error('link was parsed wrong');
  }
  if (!link.sent[0].includes('Pairing code')) throw new Error('pairing code not relayed');

  return 'list/empty/link verified';
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`)).catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}
module.exports = { check };
