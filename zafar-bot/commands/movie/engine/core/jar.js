// In-memory cookie jar for provider requests. Use an RFC-aware implementation:
// host-only, Domain, Path, Secure and expiry attributes must all be respected.
import { CookieJar } from 'tough-cookie';

function asUrl(origin) {
  try {
    const raw = String(origin || '');
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}/`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

export default class Jar {
  constructor() { this.jar = new CookieJar(); }

  // The full response URL is preferred so default cookie paths and Secure
  // behavior are correct. A bare host remains accepted for compatibility.
  set(origin, setCookie) {
    const url = asUrl(origin);
    if (!url || !setCookie) return;
    for (const cookie of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      try { this.jar.setCookieSync(String(cookie), url, { ignoreError: true }); }
      catch { /* malformed or invalid-domain cookie */ }
    }
  }

  header(host) { return this.headerFor(asUrl(host)); }

  headerFor(url) {
    const target = asUrl(url);
    if (!target) return null;
    try { return this.jar.getCookieStringSync(target) || null; }
    catch { return null; }
  }
}
