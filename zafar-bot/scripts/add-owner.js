'use strict';

/**
 * scripts/add-owner.js — set the owner once.
 *
 *   npm run add-owner -- 265991234567
 *
 * The owner is global: the same person on every linked number. It is stored in
 * storage/core/owner.json and read by gateway/users/store.js.
 *
 * There is no default owner and no fallback to a hardcoded number. If nothing is
 * set, the bot starts and refuses every command; this script is the only way in.
 */

const path = require('path');

const store = require('../gateway/users/store');
const jid = require('../lib/jid');

function usage() {
  console.error('Usage: npm run add-owner -- <number with country code, digits only>');
  console.error('Example: npm run add-owner -- 265991234567');
}

function main() {
  const raw = process.argv.slice(2).join('').replace(/\D/g, '');

  if (!raw) {
    usage();
    process.exit(1);
  }
  if (!jid.isNumber(raw)) {
    console.error(`❌ "${raw}" is not a usable international number (7-15 digits, country code first).`);
    process.exit(1);
  }

  const previous = store.readOwner();
  const number = store.writeOwner(raw);

  console.log(`✅ Owner set to ${number}`);
  if (previous && previous !== number) console.log(`   (was ${previous})`);
  console.log('');
  console.log('The owner passes every guard on every linked number:');
  console.log('  - role checks, access mode, maintenance');
  console.log('  - per-command blocks');
  console.log('');
  console.log('Next: set DRIME_API_TOKEN / XJX_* keys in .env, then `npm start`.');
  console.log(`Owner file: ${path.relative(path.resolve(__dirname, '..'), store.OWNER_FILE)}`);
}

main();
