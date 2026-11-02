'use strict';

const meta = require('./command.json');
const urls = require('./urls');
const scraper = require('./scraper');
const log = { debug() {}, info() {}, warn() {}, error() {} };

async function check() {
  let rejected = false;
  try { urls.normalize('https://example.com/not-facebook'); } catch (err) {
    if (err.code !== 'BAD_LINK') throw new Error(`wrong code for a bad link: ${err.code}`);
    rejected = true;
  }
  if (!rejected) throw new Error('a non-Facebook link was not rejected');

  const normalized = urls.normalize(meta.sample);
  const item = await scraper.resolve(normalized.href, { log });
  if (!item?.url) throw new Error('resolver returned no media');
  return `${item.kind} · ${new URL(item.url).hostname}`;
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => { console.log(`❌ ${meta.name} — ${e.code ? e.code + ': ' : ''}${e.message}`); process.exit(1); });
}
module.exports = { check };
