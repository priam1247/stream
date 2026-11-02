'use strict';

const meta = require('./command.json');
const { run } = require('./index');

async function check() {
  const sent = [];
  await run({
    text: '', args: [], reply: async (t) => { sent.push(String(t)); return t; },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const expected = 'Movie downloads use keyless sources and direct torrents; debrid services are no longer used.';
  if (sent[0] !== expected) throw new Error(`reply wording changed: ${JSON.stringify(sent[0])}`);
  return 'static reply matches the old bot';
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}
module.exports = { check };
