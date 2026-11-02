'use strict';

const meta = require('./command.json');
const { run } = require('./index');
const { formatList } = require('./render');

function makeCtx(text, result) {
  const sent = [];
  const calls = [];
  return {
    sent, calls,
    ctx: {
      text,
      args: text ? text.split(/\s+/).filter(Boolean) : [],
      command: 'users', prefix: '.',
      sender: { number: '265991234567', name: 'check' },
      user: null, role: 'owner', chat: '265991234567@s.whatsapp.net',
      isGroup: false, quoted: null, number: '265991234567',
      settings: { accessMode: 'open', maintenance: false, prefix: '.' },
      tmp: require('path').join(require('os').tmpdir(), 'check-users'),
      limits: meta.limits, catalogue: [], statuses: {},
      log: { debug() {}, info() {}, warn() {}, error() {} },
      reply: async (t) => { sent.push(String(t)); return t; },
      send: { text: async () => null, image: async () => null, video: async () => null, audio: async () => null, document: async () => null },
      react: async () => null,
      admin: async (req) => { calls.push(req); return result; },
    },
  };
}

async function check() {
  // list
  const list = makeCtx('list', { users: [{ number: '265991234567', role: 'owner', blockedCommands: [] }] });
  await run(list.ctx);
  if (!list.sent[0].includes('265991234567')) throw new Error('list did not render the user');
  if (list.calls[0].action !== 'list') throw new Error('list did not reach the gateway');

  // add
  const add = makeCtx('add 265900000113', { message: '✅ Added' });
  await run(add.ctx);
  if (add.calls[0].target !== '265900000113') throw new Error('add parsed the wrong number');
  if (add.calls[0].extra !== '') throw new Error('add picked up a stray argument');

  // block keeps its second argument
  const block = makeCtx('block 265900000113 movie', { message: '✅ Blocked' });
  await run(block.ctx);
  if (block.calls[0].extra !== 'movie') throw new Error('block lost the command name');

  // empty input -> usage
  const empty = makeCtx('', {});
  await run(empty.ctx);
  if (!/\.users list/.test(empty.sent[0])) throw new Error('empty input did not show usage');
  if (empty.calls.length) throw new Error('empty input still called the gateway');

  return 'list/add/block/usage verified';
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`)).catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}

module.exports = { check };
