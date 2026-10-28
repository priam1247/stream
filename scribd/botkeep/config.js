'use strict';
/**
 * Hardcoded settings for the Scribd panel (Botkeep side, Node + Chromium).
 * Nothing here needs an environment variable to be set.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;

// @sparticuz/chromium only inflates the shared libraries these containers are
// missing (and sets LD_LIBRARY_PATH / FONTCONFIG_PATH) when it believes it is
// running on AL2023 Lambda. Set the marker before the package is ever loaded.
process.env.AWS_EXECUTION_ENV = process.env.AWS_EXECUTION_ENV || 'AWS_Lambda_nodejs22.x';

const VERSION = '4.0.0';
const HOST = '0.0.0.0';

// Where the finished PDFs live: the Python box. Botkeep only captures.
const DEFAULT_STORE_URL = 'http://195.123.189.187:25811';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const FIND_URL = 'https://www.scribd.com/search/query';
const FIND_REFERER = 'https://www.scribd.com/search';
const FIND_PER_PAGE = 40;
const FIND_MAX_PAGE = 40;
const DOCUMENT_URL = 'https://www.scribd.com/document/{id}';
const EMBED_URL = 'https://www.scribd.com/embeds/{id}/content';

const VIEWPORT = { width: 1280, height: 1800 };
const DEVICE_SCALE = 1;
const NAV_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MS = 12_000;
const SHOT_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 15_000;
const JPEG_QUALITY = 90;
const MAX_PAGES = 5_000;
const MAX_DOCUMENTS = 100;
const MAX_BODY_BYTES = 1_000_000;
const BLANK_RETRIES = 2;
const MAX_FILES = 40;
const MAX_LOG_LINES = 120;
const PANEL_COOKIE = 'scribd_panel_key';

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--force-color-profile=srgb',
];

// Third-party noise blocked while capturing a page.
const BLOCKED_HOST_PARTS = [
  'osano.com',
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'facebook.net',
  'connect.facebook.net',
  'hotjar.com',
  'newrelic.com',
  'nr-data.net',
  'segment.com',
  'scorecardresearch.com',
];

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
]);

/** Ports to listen on: the host's allocated port, else the panel's 25811. */
function ports() {
  const found = [];
  const push = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && n <= 65535 && !found.includes(n)) found.push(n);
  };
  for (const name of ['SERVER_PORT', 'PORT']) push(process.env[name]);
  if (!found.length) found.push(25811);
  return found;
}

function storeUrl() {
  const raw = (process.env.SCRIBD_STORE_URL || DEFAULT_STORE_URL).trim();
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) return DEFAULT_STORE_URL;
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return DEFAULT_STORE_URL;
  }
}

function panelKey() {
  return (process.env.SCRIBD_PANEL_KEY || process.env.PANEL_KEY || '').trim();
}

function browsersPath() {
  const raw = (process.env.PLAYWRIGHT_BROWSERS_PATH || '').trim();
  if (raw && raw !== '0') return raw;
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

/** Your own Scribd session cookies, if you uploaded a cookies.txt. */
function cookieFile() {
  const override = (
    process.env.COOKIES_FILE ||
    process.env.COOKIE_FILE ||
    process.env.SCRIBD_COOKIES_FILE ||
    ''
  ).trim();
  if (override) return override;
  for (const candidate of [
    path.join(ROOT, 'cookies.txt'),
    '/home/container/cookies.txt',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

/** Parse a Netscape cookies.txt into puppeteer's cookie shape. */
function scribdCookies() {
  const file = cookieFile();
  if (!file) return [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const cookies = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , cookiePath, secure, expires, name, ...rest] = parts;
    const value = rest.join('\t').trim();
    if (!domain || !name) continue;
    const cookie = {
      name: name.trim(),
      value,
      domain: domain.trim(),
      path: cookiePath || '/',
      secure: String(secure).toUpperCase() === 'TRUE',
      httpOnly: false,
    };
    const when = Number(expires);
    if (Number.isFinite(when) && when > 0) cookie.expires = when;
    cookies.push(cookie);
  }
  return cookies;
}

/** Test hook: point the hardcoded Scribd URLs at a local mock server. */
function rebase(url) {
  const base = (process.env.SCRIBD_BASE || '').trim().replace(/\/+$/, '');
  if (!base) return url;
  try {
    const target = new URL(url);
    return base + target.pathname + target.search;
  } catch {
    return url;
  }
}

function cookieReport() {
  const cookies = scribdCookies();
  if (!cookies.length) return 'anonymous (no cookies)';
  return `${cookies.length} Scribd cookie(s)`;
}

module.exports = {
  ROOT, VERSION, HOST,
  USER_AGENT, FIND_URL, FIND_REFERER, FIND_PER_PAGE, FIND_MAX_PAGE,
  DOCUMENT_URL, EMBED_URL, VIEWPORT, DEVICE_SCALE, NAV_TIMEOUT_MS,
  RENDER_TIMEOUT_MS, SHOT_TIMEOUT_MS, SEARCH_TIMEOUT_MS, JPEG_QUALITY,
  MAX_PAGES, MAX_DOCUMENTS, MAX_BODY_BYTES, BLANK_RETRIES, MAX_FILES,
  MAX_LOG_LINES, PANEL_COOKIE, CHROME_ARGS, BLOCKED_HOST_PARTS, STOPWORDS,
  ports, storeUrl, panelKey, browsersPath, cookieFile, scribdCookies, cookieReport, rebase,
};
