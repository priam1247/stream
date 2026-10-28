'use strict';
/**
 * Chromium capture engine — runs on Botkeep, the box that has the browser.
 *
 * Opens Scribd's embed viewer, forces every page to render, measures each page
 * element's boundary, screenshots one page per boundary (never slicing into the
 * next page), rejects blank sheets, and compiles a PDF. XS Systems is not
 * involved: it only stores the finished file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./config');
const scripts = require('./page-scripts');
const { buildPdf, isBlank } = require('./pdf');

class CaptureError extends Error {}

let browserPromise = null;
let browserExecutable = '';

function chromiumPackage() {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const loaded = require('@sparticuz/chromium');
    // The package is ESM: require() wraps the class in `default`.
    const chromium = loaded && loaded.default ? loaded.default : loaded;
    return chromium && typeof chromium.executablePath === 'function' ? chromium : null;
  } catch {
    return null;
  }
}

/** Where the Chromium binary is, for /diag. */
function executablePath() {
  const explicit = (process.env.SCRIBD_CHROME_PATH || process.env.CHROME_PATH || '').trim();
  if (explicit) return explicit;
  if (browserExecutable) return browserExecutable;
  const candidates = [
    path.join(os.tmpdir(), 'chromium'),
    path.join(config.browsersPath(), 'chromium'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

async function launch() {
  const puppeteer = require('puppeteer-core');
  const chromium = chromiumPackage();

  let args = [...config.CHROME_ARGS];
  let executable = executablePath();

  if (chromium) {
    // The bundled package inflates a Chromium plus the shared libraries these
    // containers lack, and sets LD_LIBRARY_PATH / FONTCONFIG_PATH for it.
    try {
      if (typeof chromium.setGraphicsMode === 'function') chromium.setGraphicsMode = false;
      const bundled = await chromium.executablePath();
      if (bundled && fs.existsSync(bundled)) executable = bundled;
      if (Array.isArray(chromium.args)) args = [...new Set([...chromium.args, ...args])];
    } catch (err) {
      if (!executable) {
        throw new CaptureError(`Could not unpack Chromium: ${err.message}`);
      }
    }
  }

  if (!executable) {
    throw new CaptureError(
      'No Chromium on this server. Upload package.json and run npm install, ' +
      'or set SCRIBD_CHROME_PATH to a browser binary.',
    );
  }

  browserExecutable = executable;
  const browser = await puppeteer.launch({
    executablePath: executable,
    args,
    headless: true,
    protocolTimeout: 180_000,
    defaultViewport: { ...config.VIEWPORT, deviceScaleFactor: config.DEVICE_SCALE },
  });
  return browser;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launch().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    /* already gone */
  }
}

/** Turn DOM page boxes into non-overlapping boundary clips. */
function clipsFromBoxes(boxes, docWidth, docHeight) {
  if (!boxes || !boxes.length) throw new CaptureError('Scribd showed no page boundaries.');

  const clean = [];
  for (const box of boxes) {
    const item = {
      number: Number(box.number) || clean.length + 1,
      left: Number(box.left),
      right: Number(box.right),
      top: Number(box.top),
      bottom: Number(box.bottom),
    };
    if (!Number.isFinite(item.left) || !Number.isFinite(item.top)) continue;
    if (item.right <= item.left || item.bottom <= item.top) continue;
    clean.push(item);
  }
  if (!clean.length) throw new CaptureError('Every Scribd page boundary was empty.');

  clean.sort((a, b) => a.top - b.top || a.left - b.left);
  const width = Math.max(1, Number(docWidth) || 1);
  const height = Math.max(1, Number(docHeight) || 1);

  let x0 = Math.max(0, Math.floor(Math.min(...clean.map((b) => b.left)) - 2));
  let x1 = Math.min(width, Math.ceil(Math.max(...clean.map((b) => b.right)) + 2));
  if (x1 <= x0) {
    x0 = 0;
    x1 = width;
  }

  const cuts = [Math.max(0, Math.floor(clean[0].top - 2))];
  for (let index = 1; index < clean.length; index += 1) {
    const previous = clean[index - 1];
    const current = clean[index];
    const midpoint = (previous.bottom + current.top) / 2;
    const cut = Math.max(cuts[cuts.length - 1] + 1, Math.min(Math.floor(current.top), Math.floor(midpoint)));
    cuts.push(cut);
  }
  let last = Math.min(height, Math.ceil(clean[clean.length - 1].bottom + 2));
  if (last <= cuts[cuts.length - 1]) last = Math.min(height, cuts[cuts.length - 1] + 1);
  cuts.push(last);

  const clips = [];
  for (let index = 0; index < clean.length; index += 1) {
    const y0 = cuts[index];
    const y1 = cuts[index + 1];
    if (y1 <= y0) throw new CaptureError(`Page ${index + 1} had no space between boundaries.`);
    clips.push({
      number: Math.trunc(clean[index].number) || index + 1,
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0,
    });
  }
  return clips;
}

/** Run one of the ported in-page functions with its argument. */
function callInPage(page, source, arg) {
  return page.evaluate(
    (src, payload) => {
      // eslint-disable-next-line no-eval
      const fn = eval(`(${src})`);
      return fn(payload);
    },
    source,
    arg,
  );
}

function safeName(title, ident) {
  const raw = String(title || 'document');
  const ascii = raw.normalize('NFKD').replace(/[^\x20-\x7E]/g, '');
  const cleaned = ascii.replace(/[^A-Za-z0-9._ -]+/g, '').replace(/^[ .]+|[ .]+$/g, '');
  const base = (cleaned || 'document').slice(0, 120);
  return `${base}-${ident}.pdf`;
}

async function captureDocument(doc, { progress, log, cancel } = {}) {
  const started = Date.now();
  const url = doc && doc.url ? String(doc.url) : '';
  const ident = (doc && doc.id) || '';
  if (!url || !ident) throw new CaptureError('A Scribd document URL is required.');

  const embed = config.rebase(require('./scribd').embedUrl(url));
  if (!embed) throw new CaptureError('Could not build the Scribd embed URL.');

  let expected = Math.max(0, Math.min(Number(doc.pages) || 0, config.MAX_PAGES));
  const name = safeName(doc.title, ident);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scribd-'));
  const shots = [];

  const browser = await getBrowser();
  let page = null;
  try {
    page = await browser.newPage();
    await page.setUserAgent(config.USER_AGENT);
    await page.setViewport({ ...config.VIEWPORT, deviceScaleFactor: config.DEVICE_SCALE });

    const cookies = config.scribdCookies();
    if (cookies.length) {
      try {
        await page.setCookie(...cookies);
      } catch {
        /* a rejected cookie must not stop the capture */
      }
    }

    await page.evaluateOnNewDocument(scripts.INIT_JS);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const target = request.url().toLowerCase();
      if (config.BLOCKED_HOST_PARTS.some((part) => target.includes(part)) || target.includes('/analytics/')) {
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });

    if (log) log(`opening ${ident} · ${expected || '?'} pages`);

    const response = await page.goto(embed, { waitUntil: 'domcontentloaded', timeout: config.NAV_TIMEOUT_MS });
    if (response && response.status() >= 400) {
      throw new CaptureError(`Scribd refused the embed viewer (HTTP ${response.status()}).`);
    }
    await page.addStyleTag({ content: scripts.CLEAN_CSS });

    let detected = 0;
    try {
      detected = Math.trunc((await callInPage(page, scripts.PAGE_COUNT_JS)) || 0);
    } catch {
      detected = 0;
    }
    if (!expected) expected = detected;
    if (expected) expected = Math.min(expected, config.MAX_PAGES);

    try {
      await callInPage(page, scripts.FORCE_RENDER_JS, { expected });
    } catch (err) {
      throw new CaptureError(`Could not force Scribd pages to render: ${err.message}`);
    }

    let measured = await callInPage(page, scripts.BOUNDARIES_JS, { expected });
    let boxes = (measured && measured.boxes) || [];
    if (expected && boxes.length < expected) {
      await callInPage(page, scripts.FORCE_RENDER_JS, { expected });
      await new Promise((resolve) => setTimeout(resolve, 300));
      measured = await callInPage(page, scripts.BOUNDARIES_JS, { expected });
      boxes = (measured && measured.boxes) || [];
    }
    if (expected && boxes.length < expected) {
      throw new CaptureError(
        `Scribd rendered ${boxes.length} page boundaries for a ${expected}-page document.`,
      );
    }
    if (!expected) expected = boxes.length;
    if (!expected) throw new CaptureError('Scribd showed no pages for this document.');

    boxes = boxes.slice(0, expected);
    await callInPage(page, scripts.CLEAN_JS, null);
    measured = await callInPage(page, scripts.BOUNDARIES_JS, { expected });
    boxes = (measured && measured.boxes) || [];
    if (boxes.length < expected) {
      throw new CaptureError(
        `Scribd showed ${boxes.length} boundaries after cleanup, expected ${expected}.`,
      );
    }
    boxes = boxes.slice(0, expected);

    const clips = clipsFromBoxes(boxes, measured.docWidth, measured.docHeight);
    if (progress) progress(0, expected, 0);

    // Wait until the first pass has real content on every page, then force the
    // ones that are still lazy.
    try {
      await callInPage(page, scripts.FORCE_RENDER_JS, { expected });
    } catch {
      /* keep going */
    }

    for (let index = 1; index <= clips.length; index += 1) {
      if (cancel && cancel.aborted) throw new CaptureError('Job stopped.');
      const clip = clips[index - 1];
      const file = path.join(workDir, `page-${String(index).padStart(4, '0')}.jpg`);

      for (let attempt = 0; attempt <= config.BLANK_RETRIES; attempt += 1) {
        await page.screenshot({
          path: file,
          type: 'jpeg',
          quality: config.JPEG_QUALITY,
          // `clip` is in document coordinates and captureBeyondViewport lets it
          // reach pages below the fold; Puppeteer refuses fullPage + clip.
          captureBeyondViewport: true,
          clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
          animations: 'disabled',
          caret: 'hide',
          timeout: config.SHOT_TIMEOUT_MS,
        });
        if (!isBlank(file)) break;
        if (attempt >= config.BLANK_RETRIES) {
          throw new CaptureError(`Page ${index} stayed blank after forcing Scribd to render.`);
        }
        try {
          await callInPage(page, scripts.FORCE_PAGE_JS, { number: index });
        } catch {
          /* keep going */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      shots.push(file);
      if (progress) progress(index, expected, index);
      if (log && (index === 1 || index === expected || index % 5 === 0)) {
        log(`captured page ${index}/${expected}`);
      }
    }

    if (cancel && cancel.aborted) throw new CaptureError('Job stopped.');

    const output = path.join(workDir, name);
    const bytes = await buildPdf(shots, output, expected);
    if (log) log(`built ${name} · ${expected} pages · ${Math.round(bytes / 1024)} KiB`);
    return {
      path: output,
      name,
      pages: expected,
      bytes,
      seconds: (Date.now() - started) / 1000,
      workDir,
    };
  } catch (err) {
    try {
      for (const file of fs.readdirSync(workDir)) {
        if (file.endsWith('.pdf')) fs.unlinkSync(path.join(workDir, file));
      }
    } catch {
      /* ignore */
    }
    if (err instanceof CaptureError) throw err;
    throw new CaptureError(err && err.message ? err.message : String(err));
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { captureDocument, clipsFromBoxes, getBrowser, closeBrowser, executablePath, CaptureError };
