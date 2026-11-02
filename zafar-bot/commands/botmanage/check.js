'use strict';

const meta = require('./command.json');
const { run } = require('./index');

function makeCtx(text, settings = { accessMode: 'open', maintenance: false, prefix: '.' }) {
  const sent = []; const calls = [];
  return { sent, calls, ctx: {
    text, args: text ? text.split(/\s+/) : [], command: 'botmanage', prefix: '.',
    sender: { number: '265991234567', name: 'check' }, user: null, role: 'owner',
    chat: '265991234567@s.whatsapp.net', isGroup: false, quoted: null, number: '265991234567',
    settings, tmp: require('path').join(require('os').tmpdir(), 'check-botmanage'),
    limits: meta.limits, catalogue: [], statuses: {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    reply: async (t) => { sent.push(String(t)); return t; },
    send: { text: async () => null, image: async () => null, video: async () => null, audio: async () => null, document: async () => null },
    react: async () => null,
    admin: async (req) => { calls.push(req); return { message: `✅ ${req.action} applied` }; },
  } };
}

async function check() {
  const show = makeCtx('show');
  await run(show.ctx);
  if (!show.sent[0].includes('access mode: open')) throw new Error('show did not report the access mode');
  if (!show.sent[0].includes('maintenance: off')) throw new Error('show did not report maintenance');
  if (show.calls.length) throw new Error('show must not write anything');

  const access = makeCtx('access whitelist');
  await run(access.ctx);
  if (access.calls[0]?.action !== 'access' || access.calls[0]?.extra !== 'whitelist') throw new Error('access was parsed wrong');

  const missing = makeCtx('access');
  await run(missing.ctx);
  if (!/Usage/.test(missing.sent[0])) throw new Error('missing argument did not show usage');
  if (missing.calls.length) throw new Error('missing argument still reached the gateway');

  const bogus = makeCtx('nonsense');
  await run(bogus.ctx);
  if (!/Unknown action/.test(bogus.sent[0])) throw new Error('unknown action was not refused');

  return 'show/access/usage/unknown verified';
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`)).catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}
module.exports = { check };
