'use strict';

/**
 * commands/ig/urls.js — validate an Instagram link and classify the media.
 *
 * A private copy for .ig. .fb has its own. Sharing this was how the old bot's
 * socialMedia.js made fixing one break the other.
 */

const ALLOWED = ['instagram.com', 'instagr.am', 'ddinstagram.com'];

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * @returns {URL}
 * @throws {Error} code BAD_LINK
 */
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

  if (!ALLOWED.some(matches)) {
    throw fail('BAD_LINK', 'unsupported Instagram link');
  }
  if (matches('ddinstagram.com')) url.hostname = 'www.instagram.com';
  return url;
}

function kindOf(item, url, sourceUrl) {
  const type = String(item?.type || item?.mimeType || item?.mime_type || '').toLowerCase();
  if (/video|mp4|reel/.test(type)) return 'video';
  if (/image|photo|jpeg|png/.test(type)) return 'image';
  return /\.(?:mp4|mov|avi|mkv|webm)(?:[?#]|$)/i.test(url) || /\/(?:reel|tv)\//i.test(sourceUrl)
    ? 'video'
    : 'image';
}

module.exports = { normalize, kindOf, ALLOWED, fail };
