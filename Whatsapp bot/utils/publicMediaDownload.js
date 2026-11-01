/**
 * Download public media without sending credentials to redirects or allowing
 * provider-controlled URLs to reach the host's private network. Each HTTPS
 * request gets a fresh agent whose DNS result is checked and pinned.
 */
const fs = require('fs');
const dns = require('dns');
const net = require('net');
const https = require('https');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { publicGet, credentialHeaders } = require('./publicHttp');
const ipaddr = require('ipaddr.js');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const fail = (code, message) => Object.assign(new Error(message), { code });

function isPublicAddress(value) {
  try { return ipaddr.process(String(value)).range() === 'unicast'; }
  catch { return false; }
}

/** Reject mixed public/private DNS answers too, then pin the selected answer. */
function publicLookup(resolve = dns.promises.lookup) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const family = typeof options === 'number' ? options : Number(options?.family) || 0;
    Promise.resolve()
      .then(() => resolve(hostname, { all: true, verbatim: true }))
      .then((addresses) => {
        if (!Array.isArray(addresses) || !addresses.length || addresses.some((row) => !isPublicAddress(row?.address))) {
          throw fail('UNSAFE_SOURCE', 'Media host did not resolve to public addresses');
        }
        const usable = family ? addresses.filter((row) => row.family === family) : addresses;
        if (!usable.length) throw fail('UNSAFE_SOURCE', 'Media host has no suitable public address');
        if (options?.all) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      })
      .catch((err) => callback(err?.code === 'UNSAFE_SOURCE' ? err : fail('MEDIA_NETWORK', 'Media host lookup failed')));
  };
}

function safeUrl(value, allowedHosts) {
  let url;
  try { url = new URL(String(value)); } catch { throw fail('UNSAFE_SOURCE', 'Invalid media URL'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const ip = host.replace(/^\[|\]$/g, '');
  if (url.href.length > 8192 || url.protocol !== 'https:' || url.username || url.password || url.port ||
      !host || net.isIP(ip) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      (allowedHosts && !allowedHosts.has(host))) {
    throw fail('UNSAFE_SOURCE', 'Unsafe media URL');
  }
  return url;
}

/**
 * Streams to a newly-created file with bounded redirects, bytes and time.
 * `allowedHosts`, when supplied, restricts every hop to those exact names.
 */
async function downloadPublicFile(initialUrl, dest, {
  maxBytes,
  timeoutMs = 180000,
  allowedHosts,
  maxRedirects = 5,
  request = publicGet,
  resolve = dns.promises.lookup,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 10240 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw fail('BAD_SOURCE', 'Invalid media download limits');
  }
  const hosts = allowedHosts ? new Set(allowedHosts.map((host) => String(host).toLowerCase())) : null;
  const signal = AbortSignal.timeout(Math.min(Math.floor(timeoutMs), 2 ** 31 - 1));
  let current = safeUrl(initialUrl, hosts);
  let ownedFile = false;

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const agent = new https.Agent({ keepAlive: false, lookup: publicLookup(resolve) });
      let response;
      try {
        response = await request(current.href, {
          responseType: 'stream', timeout: 30000, signal, maxRedirects: 0,
          httpsAgent: agent, proxy: false, auth: null, decompress: false,
          headers: { 'User-Agent': 'ZaFarBot/2.2 public media', Accept: '*/*', 'Accept-Encoding': 'identity', ...credentialHeaders },
          validateStatus: () => true,
        });
        if (!response?.data || typeof response.data.destroy !== 'function') {
          throw fail('BAD_SOURCE', 'Media source returned an invalid response');
        }
        const status = Number(response.status);
        if (REDIRECTS.has(status)) {
          response.data.destroy();
          if (hop === maxRedirects || !response.headers?.location) throw fail('BAD_SOURCE', 'Media redirect limit reached');
          let next;
          try { next = new URL(response.headers.location, current); } catch { throw fail('UNSAFE_SOURCE', 'Invalid media redirect'); }
          current = safeUrl(next.href, hosts);
          continue;
        }
        if (status === 403 || status === 404) {
          response.data.destroy();
          throw fail('MEDIA_UNAVAILABLE', 'Media is unavailable or download is not permitted');
        }
        if (status === 429) {
          response.data.destroy();
          throw Object.assign(fail('MEDIA_RATE_LIMIT', 'Media source is rate limiting downloads'), { status: 429 });
        }
        if (status !== 200) {
          response.data.destroy();
          throw Object.assign(fail('MEDIA_NETWORK', 'Media source returned an unexpected status'), {
            status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
          });
        }
        const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
        const lengthText = String(response.headers?.['content-length'] || '');
        const expected = /^\d+$/.test(lengthText) ? Number(lengthText) : 0;
        if (/^(?:text\/|application\/(?:json|xml|xhtml\+xml))/.test(contentType)) {
          response.data.destroy();
          throw fail('BAD_SOURCE', 'Media source returned a page instead of a file');
        }
        if (expected && (!Number.isSafeInteger(expected) || expected > maxBytes)) {
          response.data.destroy();
          throw fail('TOO_BIG', 'Media exceeds the size limit');
        }

        const handle = await fs.promises.open(dest, 'wx');
        ownedFile = true;
        let bytes = 0;
        const meter = new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length;
            if (bytes > maxBytes) return done(fail('TOO_BIG', 'Media exceeds the size limit'));
            return done(null, chunk);
          },
        });
        await pipeline(response.data, meter, handle.createWriteStream(), { signal });
        if (bytes < 10240 || (expected && bytes !== expected)) throw fail('BAD_SOURCE', 'Media file is incomplete');
        return { file: dest, bytes, contentType };
      } finally {
        agent.destroy();
      }
    }
    throw fail('BAD_SOURCE', 'Media redirect limit reached');
  } catch (err) {
    if (ownedFile) await fs.promises.rm(dest, { force: true }).catch(() => {});
    const known = new Set(['UNSAFE_SOURCE', 'MEDIA_UNAVAILABLE', 'MEDIA_NETWORK', 'MEDIA_RATE_LIMIT', 'BAD_SOURCE', 'TOO_BIG', 'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EEXIST', 'EROFS']);
    if (known.has(err?.code)) throw err;
    throw fail('MEDIA_NETWORK', 'Media download failed');
  }
}

module.exports = { isPublicAddress, publicLookup, safeUrl, downloadPublicFile };
