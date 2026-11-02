'use strict';

/** commands/paper/redact.js — strip credentials out of a provider error body. */

function redactSecrets(input) {
  let s = String(input ?? '');
  s = s.replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+|/=-]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/\b\d+\|[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]');
  s = s.replace(/([?&](?:api_?key|token|key)=)[^&\s]+/gi, '$1[REDACTED]');
  return s;
}

module.exports = { redactSecrets };
