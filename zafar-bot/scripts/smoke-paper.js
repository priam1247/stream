#!/usr/bin/env node
'use strict';

/**
 * scripts/smoke-paper.js — drive .paper through the REAL gateway with the fake
 * socket. No network: the vault is unreachable here, so this proves the command
 * is wired correctly (registry → router → runner → child → adapter → reply), not
 * that Drime answers.
 *
 * Usage: node scripts/smoke-paper.js
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const registry = require(path.join(ROOT, 'gateway/registry'));
const router = require(path.join(ROOT, 'gateway/router'));
const { buildMessage, createFakeSocket } = require(path.join(ROOT, 'gateway/fakesock'));
const store = require(path.join(ROOT, 'gateway/users/store'));

const NUMBER = '265991234567';

(async () => {
  store.writeOwner(NUMBER);
  const loaded = registry.load({ markStatus: false });
  console.log(`REGISTRY loaded ${loaded.loaded} failed ${loaded.failed}`);

  store.ensureNumber(NUMBER);
  const sock = createFakeSocket();
  const message = buildMessage({
    body: '.paper',
    sender: NUMBER,
    chat: `${NUMBER}@s.whatsapp.net`,
  });

  const out = await router.handle({ number: NUMBER, sock, message });
  console.log('PAPER (no args) ->', JSON.stringify(out));

  const replies = sock.__sent.map((m) => m.content?.text).filter(Boolean);
  console.log('reply:', JSON.stringify(replies));

  const expected = '📚 *Usage:* .paper <code> [module] [year]\n.paper browse [code] [page]';
  if (!replies.includes(expected)) {
    console.error('❌ usage text does not match the old bot');
    process.exit(1);
  }
  if (loaded.failed !== 0) {
    console.error(`❌ ${loaded.failed} command(s) failed to load`);
    process.exit(1);
  }
  console.log('✅ .paper usage wording matches the old bot; all commands loaded');
})();
