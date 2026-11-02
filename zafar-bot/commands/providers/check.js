'use strict';

const meta = require('./command.json');
const { run, PROVIDERS } = require('./index');

async function check() {
  const sent = [];
  await run({ reply: async (t) => { sent.push(String(t)); return t; }, log: { info() {} } });
  if (!sent[0].includes('moviebox')) throw new Error('provider list is empty');
  if (PROVIDERS.length < 10) throw new Error('the old bot listed 12 providers');
  return `${PROVIDERS.length} providers listed`;
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => { console.log(`❌ ${meta.name} — ${e.message}`); process.exit(1); });
}
module.exports = { check };
