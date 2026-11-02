'use strict';

/**
 * commands/_template/check.js — live self-test.
 *
 * Runs the command's REAL code path with a fake ctx. Prints one line:
 *   ✅ template — Echo: hello
 *   ❌ template — <exact reason>
 *
 * Exit code 0 only when it passes, so scripts/check-all.js can use the board.
 * This never touches WhatsApp and never touches a live service.
 */

const meta = require('./command.json');

function fakeCtx(text) {
  const sent = [];
  return {
    sent,
    ctx: {
      args: text.split(/\s+/).filter(Boolean),
      text,
      command: meta.name,
      prefix: '.',
      sender: { number: '000000000', name: 'check' },
      user: null,
      role: 'owner',
      chat: '000000000@s.whatsapp.net',
      isGroup: false,
      quoted: null,
      settings: { accessMode: 'open', maintenance: false, prefix: '.' },
      tmp: require('path').join(require('os').tmpdir(), `check-${meta.name}`),
      limits: meta.limits,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      reply: async (t) => { sent.push(t); return t; },
      send: {
        text: async (t) => { sent.push(t); return t; },
        image: async () => null, video: async () => null,
        audio: async () => null, document: async () => null,
      },
      react: async () => null,
    },
  };
}

async function check() {
  const { run } = require('./index');
  const { ctx, sent } = fakeCtx(meta.sample);

  await run(ctx);

  if (!sent.length) throw new Error('run() sent nothing for the sample input');

  const last = String(sent[sent.length - 1]);
  if (!last.includes(meta.sample)) {
    throw new Error(`reply did not contain the sample (${JSON.stringify(meta.sample)}): ${JSON.stringify(last)}`);
  }
  return last.split('\n')[0].slice(0, 120);
}

if (require.main === module) {
  check()
    .then((detail) => {
      console.log(`✅ ${meta.name} — ${detail}`);
      process.exit(0);
    })
    .catch((err) => {
      console.log(`❌ ${meta.name} — ${err.message}`);
      process.exit(1);
    });
}

module.exports = { check, fakeCtx };
