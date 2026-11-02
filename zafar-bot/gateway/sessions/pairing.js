'use strict';

/**
 * gateway/sessions/pairing.js — pairing-code flow.
 *
 * The old bot wired this into utils/sessionManager.js and the dashboard sync.
 * Here it is a thin, explicit helper: ask the session for a code, print it, or
 * return it to the caller. No hidden retries, no fallbacks.
 */

const jid = require('../../lib/jid');
const { gatewayLog } = require('../log');

/**
 * @param {import('./manager').SessionManager} manager
 * @param {string} number  digits, country code first
 * @returns {Promise<{number:string, code:string}>}
 */
async function requestCode(manager, number) {
  const digits = jid.digits(number);
  if (!jid.isNumber(digits)) {
    throw new Error(`not a usable number: ${JSON.stringify(number)}`);
  }

  let session = manager.get(digits);
  if (!session) session = await manager.start(digits);
  if (!session) throw new Error(`could not start a session for ${digits}`);

  // requestPairingCode needs a live socket registration attempt.
  const code = await session.requestPairingCode(digits);
  gatewayLog.info('pairing code issued', { number: digits });
  return { number: digits, code };
}

function instructions(code) {
  return [
    'WhatsApp → Linked devices → Link a device',
    '→ "Link with phone number instead"',
    `Pairing code: ${code}`,
  ].join('\n');
}

module.exports = { requestCode, instructions };
