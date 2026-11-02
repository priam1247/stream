'use strict';

/**
 * commands/fb/urls.js — validate a Facebook link.
 *
 * Own copy for .fb. Accepts the same hosts the old socialMedia.js accepted:
 * facebook.com, fb.watch, fb.com, m.facebook.com, plus fb.com subdomains.
 */

const ALLOWED = ['facebook.com', 'fb.watch', 'fb.com'];

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalize(input) {
  const text = String(input || '').trim();
  if (!text || text.length > 4096) throw fail('BAD_LINK', 'unsupported link');

  let url;
  try {
    url = new URL(text);
  } catch {
    throw fail('BAD_LINK', 'unsupported link');
  }

  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw fail('BAD_LINK', 'unsupported link');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const matches = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (!ALLOWED.some(matches)) throw fail('BAD_LINK', 'unsupported Facebook link');
  return url;
}

module.exports = { normalize, ALLOWED, fail };
