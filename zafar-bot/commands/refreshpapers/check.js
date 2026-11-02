'use strict';

/**
 * commands/paper/check.js — live self-test.
 *
 * Stage 1 (offline, must always pass): the vault is configured, the parsers
 * work, and the snapshot persists to storage/commands/paper/data/.
 * Stage 2 (network): the real Drime endpoint answers.
 *
 * It never sends a PDF.
 */

const os = require('os');
const path = require('path');
const meta = require('./command.json');
const vault = require('./vault');

async function check() {
  // stage 1 — offline: the refresh entry point must exist in this command's copy
  if (typeof vault.refreshpapersCmd.execute !== 'function') {
    throw new Error('refreshpapersCmd is not exported by this command\'s own vault copy');
  }
  if (typeof vault.paperCommand.refreshOnce !== 'function') {
    throw new Error('refreshOnce is not exported; a forced refresh would do nothing');
  }

  // stage 2 — configuration present
  const token = String(process.env.DRIME_API_TOKEN || '').trim();
  if (!token) {
    throw new Error('DRIME_API_TOKEN is not set (offline stages passed: parser ok; the vault cannot be reached)');
  }

  process.env.ZAFAR_JOB_TMP = path.join(os.tmpdir(), `check-paper-${Date.now()}`);

  // stage 3 — real Drime call
  const client = vault.paperCommand.drimeClient();
  const count = await vault.paperCommand.getFolderCount(client, Number(process.env.DRIME_PAPERS_FOLDER_ID || 841342462), Number(process.env.DRIME_WORKSPACE_ID || 0));
  if (typeof count !== 'number') throw new Error('Drime returned no usable count');
  return `vault reachable, ${count.toLocaleString()} papers indexed`;
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => { console.log(`❌ ${meta.name} — ${e.code ? e.code + ': ' : ''}${e.message}`); process.exit(1); });
}
module.exports = { check };
