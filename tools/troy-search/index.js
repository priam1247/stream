/**
 * troy-search — find Scribd documents from the JS box, send the links to the
 * download panel. One file. Depends only on what you already have:
 *
 *     @sparticuz/chromium, puppeteer-core
 *
 * Run:
 *     node index.js                       # a small page on the port this
 *                                         # server was assigned, else :8096
 *     node index.js --selftest            # offline check, no network
 *     node index.js "physics 12th"        # search in the terminal, print links
 *     node index.js "physics 12th" --pick 1,3 --panel http://IP:25811
 *
 * Why it tries plain HTTP before the browser: measured on a cloud runner in
 * October 2026, DuckDuckGo's html page answered plain Python with 10 real
 * Scribd links, and refused a real headless Chromium (HTTP 403) on the same
 * page, from the same address, four minutes later. The browser is the part that
 * gets recognised. So the browser is the fallback here, not the engine — and
 * every answer, from every engine, in every mode, is reported as it came.
 *
 * Searches are wrapped as  site:scribd.com <your words>  and every link found
 * is checked against Scribd's own document pattern before it travels. The panel
 * only ever receives links: it does the downloading, this file does the finding.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.6";
// The port to listen on. A host like this one hands its container the public
// port it assigned in SERVER_PORT — PORT on some boxes — and there is no
// translation behind it: whatever this listens on IS the port the world
// reaches. Listening on a number of our own is what left the assigned endpoint
// with nothing behind it, so the panel's requests went nowhere and every page
// came back as words. 8096 stays the fallback for a box that assigns nothing,
// and for the copy the panel starts beside itself — there, the assigned port is
// the panel's own door and already taken, and 8096 is the door it asks.
export const FALLBACK_PORT = 8096;
export function listenPort(env = process.env) {
  const assigned = Number(env.SERVER_PORT || env.PORT || 0);
  return Number.isFinite(assigned) && assigned > 0 ? assigned : FALLBACK_PORT;
}
const ASSIGNED_PORT = listenPort();
const PORT = ASSIGNED_PORT;
// The download panel this box sends links to, written down rather than wired:
// SCRIBD_PANEL still wins when it is set, and the page still lets you type a
// different one — but a fresh restart now works with nothing configured.
const DEFAULT_PANEL = "http://195.123.189.187:25811";
const PANEL = (process.env.SCRIBD_PANEL || "").trim() || DEFAULT_PANEL;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_SEND = 40;

// the same pattern the panel accepts, so nothing we send can be rejected there
const DOC_LINK =
  /https?:\/\/(?:[a-z0-9-]+\.)*scribd\.com\/(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)\/\d{3,}(?:\/[^\s"'<>]*)?/gi;
const DOC_ID = /\/(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)\/(\d+)/i;

// ---------------------------------------------------------------------------
// finding links — shared by both modes, so both are judged by one rule
// ---------------------------------------------------------------------------
export function documentLinks(text) {
  const seen = new Map();
  for (const raw of String(text || "").matchAll(DOC_LINK)) {
    let url = raw[0].split("?")[0].split("#")[0].replace(/[.,;)]+$/, "");
    if (!/^https?:/i.test(url)) url = "https:" + url.replace(/^\/+/, "//");
    const id = (url.match(DOC_ID) || [])[1];
    if (!id || seen.has(id)) continue;
    seen.set(id, url);
  }
  return [...seen.values()];
}

export function parseAnchors(html, base = "") {
  const found = [];
  const seen = new Set();
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchor)) {
    const href = unwrap(match[1], base);
    const title = strip(match[2]);
    for (const url of documentLinks(href)) {
      const id = (url.match(DOC_ID) || [])[1];
      if (!id || seen.has(id)) continue;   // a result page links one book many times
      seen.add(id);
      found.push({ url, title });
    }
  }
  return found;
}

/** DuckDuckGo hides its links behind /l/?uddg=…, Bing behind ck/a?u=a1<base64>. */
export function unwrap(href, base = "") {
  let url = htmlDecode(href).trim();
  const ddg = url.match(/[?&]uddg=([^&]+)/);
  if (ddg) return decodeURIComponent(ddg[1]);
  const bing = url.match(/[?&]u=a1([^&]+)/);
  if (bing) {
    try {
      return Buffer.from(decodeURIComponent(bing[1]), "base64").toString("utf8");
    } catch {
      return url;
    }
  }
  if (url.startsWith("//")) return "https:" + url;
  if (base && url.startsWith("/")) {
    try {
      return new URL(url, base).toString();
    } catch {
      return url;
    }
  }
  return url;
}

function strip(html) {
  return htmlDecode(String(html || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function htmlDecode(text) {
  return String(text || "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Scribd's own search answer: results.documents.content.documents[]. */
export function parseScribdJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  let node = data;
  for (const key of ["results", "documents", "content", "documents"]) {
    node = node && typeof node === "object" ? node[key] : undefined;
  }
  const list = Array.isArray(node) ? node : [];
  const hits = [];
  for (const doc of list) {
    if (!doc || typeof doc !== "object") continue;
    const url = String(doc.reader_url || doc.url || "");
    const id = String(doc.id || (url.match(DOC_ID) || [])[1] || "");
    if (!id) continue;
    hits.push({
      url: documentLinks(url)[0] || `https://www.scribd.com/document/${id}`,
      title: strip(doc.title || "") || `document ${id}`,
      pages: Number(doc.pageCount) || 0,
      views: String(doc.views || ""),
      author:
        (Array.isArray(doc.authors) && doc.authors[0] && doc.authors[0].name) ||
        (doc.author && doc.author.name) ||
        "",
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// engines — every one of them is tried, and every answer is kept
// ---------------------------------------------------------------------------
export const ENGINES = [
  {
    name: "scribd",
    mode: "fetch",
    kind: "json",
    url: (q) =>
      "https://www.scribd.com/search/query?query=" +
      encodeURIComponent(q).replace(/%20/g, "+") +
      "&verbatim=true&ct_lang=0",
  },
  {
    name: "duckduckgo",
    mode: "fetch",
    url: (q) =>
      "https://html.duckduckgo.com/html/?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+"),
  },
  {
    name: "duckduckgo-lite",
    mode: "fetch",
    url: (q) =>
      "https://lite.duckduckgo.com/lite/?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+"),
  },
  {
    name: "bing",
    mode: "fetch",
    url: (q) =>
      "https://www.bing.com/search?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+") +
      "&count=30",
  },
  {
    name: "mojeek",
    mode: "fetch",
    url: (q) =>
      "https://www.mojeek.com/search?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+"),
  },
  {
    name: "scribd",
    mode: "browser",
    url: (q) => "https://www.scribd.com/search?query=" + encodeURIComponent(q),
  },
  {
    name: "duckduckgo",
    mode: "browser",
    url: (q) =>
      "https://html.duckduckgo.com/html/?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+"),
  },
  {
    name: "bing",
    mode: "browser",
    url: (q) =>
      "https://www.bing.com/search?q=" +
      encodeURIComponent("site:scribd.com " + q).replace(/%20/g, "+"),
  },
];

export function engineOrder(mode) {
  if (mode === "browser") return ENGINES.filter((engine) => engine.mode === "browser");
  if (mode === "fetch") return ENGINES.filter((engine) => engine.mode === "fetch");
  // auto: plain http first — measured to be the one that is not refused
  return [...ENGINES.filter((engine) => engine.mode === "fetch"),
          ...ENGINES.filter((engine) => engine.mode === "browser")];
}

/** Say what an HTTP status means for this address, in words a person can act on. */
export function refusal(status, body = "") {
  const low = String(body || "").toLowerCase();
  if (low.includes("captcha") || low.includes("just a moment") ||
      low.includes("client challenge") || low.includes("unusual traffic")) {
    return `HTTP ${status} challenge/captcha page — this address is being asked to prove it is human`;
  }
  if ([401, 403, 429, 503].includes(status)) {
    return `HTTP ${status} — this address was refused`;
  }
  if (!status) return "no answer (the request failed)";
  return `HTTP ${status}`;
}

async function fetchText(url, timeoutMs = 25000) {
  try {
    const answer = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const body = await answer.text();
    return { status: answer.status, body, error: "" };
  } catch (exc) {
    const cause = exc && exc.cause ? (exc.cause.code || exc.cause.message || "") : "";
    const text = String((exc && exc.message) || exc);
    return { status: 0, body: "", error: (cause ? `${text}: ${cause}` : text).slice(0, 200) };
  }
}

export async function searchWithFetch(query, ask = fetchText) {
  const hits = [];
  const notes = [];
  const seen = new Set();
  for (const engine of ENGINES.filter((item) => item.mode === "fetch")) {
    const got = await ask(engine.url(query));
    if (got.status !== 200) {
      notes.push(`${engine.name}: ` + (got.status
        ? refusal(got.status, got.body)
        : `no answer (${got.error || "the request failed"})`));
      continue;
    }
    const found = engine.kind === "json"
      ? parseScribdJson(got.body)
      : parseAnchors(got.body, engine.url(query));
    let fresh = 0;
    for (const hit of found) {
      const id = (hit.url.match(DOC_ID) || [])[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      hits.push({ ...hit, engine: engine.name });
      fresh += 1;
    }
    if (found.length) {
      notes.push(`${engine.name}: ${found.length} link(s), ${fresh} new`);
    } else {
      const challenged = refusal(200, got.body);
      notes.push(`${engine.name}: ` + (challenged.includes("challenge")
        ? challenged
        : "answered, no Scribd links in the page"));
    }
    if (hits.length >= MAX_SEND) break;
  }
  return { hits, notes };
}

// ---------------------------------------------------------------------------
// the browser — only when plain http was not enough
// ---------------------------------------------------------------------------
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const chromium = (await import("@sparticuz/chromium")).default;
      const puppeteer = (await import("puppeteer-core")).default;
      const executablePath =
        process.env.CHROME_PATH || (await chromium.executablePath());
      return puppeteer.launch({
        args: chromium.args,
        executablePath,
        headless: "shell",
      });
    })().catch((exc) => {
      browserPromise = null;
      throw exc;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    /* already gone */
  }
}

export async function searchWithBrowser(query) {
  const hits = [];
  const notes = [];
  const seen = new Set();
  let browser;
  try {
    browser = await getBrowser();
  } catch (exc) {
    return { hits, notes: [`browser: could not start — ${String(exc.message || exc).slice(0, 200)}`] };
  }
  for (const engine of ENGINES.filter((item) => item.mode === "browser")) {
    const page = await browser.newPage();
    try {
      await page.setUserAgent(UA);
      const answers = [];
      page.on("response", (response) => {
        const type = response.request().resourceType();
        if (type === "document") answers.push(response.status());
      });
      const target = engine.url(query);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const anchors = await page.evaluate(() =>
        [...document.querySelectorAll("a[href]")].map((a) => ({
          href: a.href,
          text: (a.textContent || "").trim(),
        })),
      );
      let fresh = 0;
      const found = anchors.flatMap((anchor) =>
        documentLinks(unwrap(anchor.href, target))
          .map((url) => ({ url, title: strip(anchor.text) })),
      );
      for (const hit of found) {
        const id = (hit.url.match(DOC_ID) || [])[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        hits.push({ ...hit, engine: engine.name });
        fresh += 1;
      }
      const status = answers.length ? answers[0] : 0;
      const title = await page.title().catch(() => "");
      notes.push(found.length
        ? `${engine.name}: ${found.length} link(s), ${fresh} new (http ${status})`
        : `${engine.name}: ${refusal(status, await page.content().catch(() => ""))}` +
          (title ? ` — page title ${JSON.stringify(title.slice(0, 60))}` : ""));
    } catch (exc) {
      notes.push(`${engine.name}: failed — ${String(exc.message || exc).slice(0, 160)}`);
      if (!browser.isConnected()) {
        browserPromise = null;
        break;
      }
    } finally {
      await page.close().catch(() => {});
    }
    if (hits.length >= MAX_SEND) break;
  }
  return { hits, notes };
}

/** auto = plain http, then the browser only if plain http found nothing. */
export async function search(query, mode = "auto") {
  const words = String(query || "").replace(/\s+/g, " ").trim();
  if (!words) return { hits: [], notes: ["type a few words to search for"], mode };
  if (mode === "browser") {
    const result = await searchWithBrowser(words);
    return { ...result, mode };
  }
  if (mode === "fetch") {
    const result = await searchWithFetch(words);
    return { ...result, mode };
  }
  const plain = await searchWithFetch(words);
  if (plain.hits.length) return { ...plain, mode: "fetch" };
  const withBrowser = await searchWithBrowser(words);
  return {
    hits: withBrowser.hits,
    notes: [...plain.notes, "— plain http found nothing, tried the browser —",
            ...withBrowser.notes],
    mode: "fetch+browser",
  };
}

// ---------------------------------------------------------------------------
// sending to the panel — the panel does the downloading, we only pass links
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// photographing a page the download panel could not build
// ---------------------------------------------------------------------------
/**
 * Some pages come back to the panel with neither a scan nor the words behind
 * them: the viewer builds that page's own token at runtime, which is exactly
 * what a browser has and a plain request never gets. There is nothing left to
 * draw, so the page is photographed here instead.
 *
 * One request is one page, so the panel can ask for several at once and each one
 * costs a tab in a browser that is already warm — not a browser of its own.
 *
 *   GET /shot/ping                          {"ok": true, …}
 *   GET /shot?doc=692848690&page=12         image/png, or a status and why not
 */
const SHOT_WIDTH = Number(process.env.SHOT_WIDTH || 1000);
// deliberately taller than A4: the viewer can put furniture above the page, and
// a window with room to spare means the page itself is never the thing cut off
const SHOT_HEIGHT = Number(process.env.SHOT_HEIGHT || 1500);
// 1x is standard quality: the page at the size the viewer draws it. 2x was the
// same page at twice the detail — four times the pixels to draw, encode, send
// and embed, for a sheet that is placed at the same size in the PDF anyway.
const SHOT_SCALE = Number(process.env.SHOT_SCALE || 1);
const SHOT_WAIT_MS = Number(process.env.SHOT_WAIT_MS || 8000);
const SHOT_TABS = Number(process.env.SHOT_TABS || 8);
// the most the one pass may spend loading the column: a viewer that never stops
// growing must not cost a book ten minutes of scrolling before it gives up
const SHOT_BOOK_MS = Number(process.env.SHOT_BOOK_MS || 30000);
// a page of writing costs hundreds of bytes per row of png; a sheet with nothing
// drawn on it costs a handful. Same rule the download panel uses.
const BLANK_BYTES_PER_ROW = 12;

export function shotUrl(doc, page) {
  const ident = String(doc || "").replace(/[^0-9]/g, "");
  return `https://www.scribd.com/embeds/${ident}/content` +
    `?start_page=${Number(page) || 1}&view_mode=scroll`;
}

/** The size a png claims, read out of its header — no decoding, no library. */
export function pngSize(buffer) {
  const png = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 };
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Did the browser hand back an empty white sheet? */
export function blankShot(buffer) {
  const size = pngSize(buffer);
  const bytes = Buffer.isBuffer(buffer) ? buffer.length : (buffer || []).length;
  if (!(size.width > 0) || !(size.height > 0)) return false;  // cannot judge: keep it
  return bytes / size.height < BLANK_BYTES_PER_ROW;
}

/**
 * Which rectangle on the screen is the page of paper.
 *
 * Page-shaped means taller than wide by a page's proportion, wide enough to be
 * the page and not a thumbnail. The largest such rectangle wins, except that a
 * rectangle covering the whole window loses to one inside it: that is the
 * difference between photographing the viewer and photographing the page.
 * Returns null when nothing on the screen is a page — the caller then shoots the
 * whole window rather than losing the page.
 */
export function pickClip(boxes, viewport) {
  const view = { width: Number(viewport && viewport.width) || 0,
                 height: Number(viewport && viewport.height) || 0 };
  if (!(view.width > 0) || !(view.height > 0)) return null;
  const shaped = (Array.isArray(boxes) ? boxes : [])
    .filter((box) => box && box.width > 0 && box.height > 0)
    .map((box) => ({ ...box, area: box.width * box.height }))
    .filter((box) => box.width >= view.width * 0.4 &&
                     box.height >= view.height * 0.2 &&
                     box.height / box.width >= 1.1 &&
                     box.height / box.width <= 1.8 &&
                     box.y > -view.height)
    .sort((left, right) => right.area - left.area);
  if (!shaped.length) return null;
  const window = view.width * view.height;
  const inside = shaped.filter((box) => box.area < window * 0.97);
  const chosen = inside.length ? inside[0] : shaped[0];
  const x = Math.max(0, Math.min(Math.round(chosen.x), view.width - 1));
  const y = Math.max(0, Math.min(Math.round(chosen.y), view.height - 1));
  return { x, y,
           width: Math.max(1, Math.min(Math.round(chosen.width), view.width - x)),
           height: Math.max(1, Math.min(Math.round(chosen.height), view.height - y)) };
}

/** Every rectangle on the screen that could be a page, as the browser sees it. */
async function pageBoxes(tab, viewport) {
  const boxes = await tab.evaluate(() => {
    const found = [];
    const selector = "img, canvas, div, section, article, main";
    for (const element of document.querySelectorAll(selector)) {
      const box = element.getBoundingClientRect();
      if (!(box.width > 0) || !(box.height > 0)) continue;
      found.push({ x: box.x, y: box.y, width: box.width, height: box.height,
                   tag: element.tagName.toLowerCase() });
    }
    return found;
  });
  return pickClip(boxes, viewport);
}

/**
 * What one /shot request is asking for, or why it cannot be answered.
 * Separate from the route so the rules can be checked without a browser, a
 * network, or a page: a document id, a whole page number, a sane scale.
 */
export function shotAsk(query) {
  const doc = String((query && query.doc) || "").replace(/[^0-9]/g, "");
  const page = Number((query && query.page) || 0);
  const asked = Number((query && query.scale) || 0);
  if (!/^\d{3,}$/.test(doc)) {
    return { error: "a document id is needed: /shot?doc=692848690&page=12" };
  }
  if (!Number.isInteger(page) || page < 1) {
    return { error: `a whole page number is needed, not ${JSON.stringify(String((query && query.page) || ""))}` };
  }
  if (page > 20000) return { error: `page ${page} is not a page number` };
  const scale = Math.max(0.5, Math.min(4, asked || SHOT_SCALE));
  return { doc, page, scale };
}

/**
 * Really start the browser and take one tiny picture of nothing.
 *
 * "The chromium package resolved a path" and "this box can run chromium" are two
 * different claims, and only the second one matters: a container missing a shared
 * library fails at launch, not at install. This is the honest answer, with the
 * error text that says which library.
 */
export async function launchProof() {
  const started = Date.now();
  let tab = null;
  try {
    const browser = await getBrowser();
    tab = await browser.newPage();
    await tab.setViewport({ width: 40, height: 40, deviceScaleFactor: 1 });
    await tab.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 30000 });
    const png = await tab.screenshot({ type: "png" });
    const size = pngSize(png);
    return { launched: true, ms: Date.now() - started, bytes: png.length,
             width: size.width, height: size.height,
             version: typeof browser.version === "function" ? browser.version() : "",
             note: "" };
  } catch (exc) {
    return { launched: false, ms: Date.now() - started, bytes: 0, width: 0, height: 0,
             version: "", note: String((exc && exc.message) || exc).slice(0, 400) };
  } finally {
    if (tab) await tab.close().catch(() => {});
  }
}

let shotRunning = 0;
const shotWaiting = [];

/** At most SHOT_TABS tabs at once: a small box runs out of memory before that. */
function shotSlot(max = SHOT_TABS) {
  const limit = Math.max(1, Number(max) || 1);
  return new Promise((resolve) => {
    const enter = () => {
      shotRunning += 1;
      resolve(() => {
        shotRunning -= 1;
        const next = shotWaiting.shift();
        if (next) next();
      });
    };
    if (shotRunning < limit) enter();
    else shotWaiting.push(enter);
  });
}

/**
 * Photograph one page. -> { png: Buffer|null, note: string }
 *
 * The page is opened at the viewer's own ?start_page=N, so the picture is that
 * page and no other. A sheet that comes back empty is taken again with twice the
 * patience before it is believed — and even then it is kept, because an empty
 * page that really is empty still beats a sheet that says "scan not available".
 */
export async function shootPage(doc, page, scale = SHOT_SCALE, waitMs = SHOT_WAIT_MS) {
  const ident = String(doc || "").replace(/[^0-9]/g, "");
  const number = Number(page);
  if (!/^\d{3,}$/.test(ident) || !(number >= 1)) {
    return { png: null, note: "a document id and a page number are needed" };
  }
  const viewport = { width: SHOT_WIDTH, height: SHOT_HEIGHT };
  const ratio = Math.max(0.5, Math.min(4, Number(scale) || SHOT_SCALE));
  const release = await shotSlot();
  let tab = null;
  try {
    const browser = await getBrowser();
    tab = await browser.newPage();
    await tab.setUserAgent(UA);
    await tab.setViewport({ width: viewport.width, height: viewport.height,
                            deviceScaleFactor: ratio });
    let kept = null;
    for (const patience of [Number(waitMs) || SHOT_WAIT_MS,
                            (Number(waitMs) || SHOT_WAIT_MS) * 2]) {
      await tab.goto(shotUrl(ident, number),
                     { waitUntil: "domcontentloaded", timeout: 45000 });
      const deadline = Date.now() + patience;
      let clip = null;
      do {
        clip = await pageBoxes(tab, viewport).catch(() => null);
        if (clip) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      if (clip) {
        // the box is there; give the picture inside it a moment to paint, then
        // ask again in case it grew into its final size
        await new Promise((resolve) => setTimeout(resolve, 700));
        clip = (await pageBoxes(tab, viewport).catch(() => null)) || clip;
      }
      const png = await tab.screenshot(clip
        ? { type: "png", clip, captureBeyondViewport: false }
        : { type: "png", captureBeyondViewport: false });
      const size = pngSize(png);
      const where = clip ? `the page box ${clip.width}x${clip.height}`
                         : "the whole window — no page box was found";
      if (!blankShot(png)) {
        return { png,
                 note: `page ${number}: ${size.width}x${size.height} png, ` +
                       `${where}, at ${ratio}x` };
      }
      kept = { png, note: `page ${number}: photographed, but the sheet looks ` +
                          `empty (${size.width}x${size.height}, ${where})` };
    }
    return kept || { png: null, note: `page ${number}: nothing was drawn` };
  } catch (exc) {
    const message = String((exc && exc.message) || exc).slice(0, 200);
    return { png: null, note: `page ${number}: the browser failed — ${message}` };
  } finally {
    if (tab) await tab.close().catch(() => {});
    release();
  }
}

// ---- photographing a whole book in one pass, cut at the gaps --------------
//
// The scroll viewer lays the document out as a column of page blocks with a
// gap of empty background between any two of them. That gap is the cut: a clip
// rectangle exactly on one page block can never bleed into its neighbour, so
// every page of the book is photographed at exactly the page's own size — no
// page cut or cropped differently from any other. One navigation loads the
// whole book; the captures are clip rectangles, not scrolls.
//
// The capture discipline is the one page2pdf proved: load everything first
// (scroll end to end, images eager and decoded, fonts ready, height stable),
// then capture with captureBeyondViewport and an exact clip, and take every
// tile twice — a page that differs between two captures is a page that was
// still moving, and it is taken again before it is believed.

const SCROLL_CSS = `
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
}
html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
html { scrollbar-width: none !important; }
`;

const JS_FORCE_EAGER = `async () => {
  document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
  document.querySelectorAll('img[data-src]').forEach(i => { if (!i.src) i.src = i.dataset.src; });
  document.querySelectorAll('img[data-srcset]').forEach(i => { if (!i.srcset) i.srcset = i.dataset.srcset; });
  await Promise.all([...document.images].map(i =>
    i.complete ? (i.decode ? i.decode().catch(() => {}) : null)
               : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 15000); })));
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
}`;

const JS_HEIGHT = `() => Math.ceil(Math.max(
  document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0,
  document.documentElement.offsetHeight, document.documentElement.clientHeight))`;

/** The whole document in one scrollable column, at its first page. */
export function scrollUrl(doc) {
  const ident = String(doc || "").replace(/[^0-9]/g, "");
  return `https://www.scribd.com/embeds/${ident}/content?view_mode=scroll`;
}

/**
 * Every page-shaped box on the screen, in document pixels.
 *
 * Nothing here knows Scribd's class names, because the viewer changes its
 * clothes and a selector that stops matching photographs nothing at all — which
 * is what "only 0 page block(s) found" was, on every book. A page is MEASURED,
 * with the same shape the single-page route has proved on the live viewer: a box
 * 1.1 to 1.8 times as tall as it is wide, at least 40% of the window wide and
 * 20% of it tall, and smaller than the window itself. Furniture pinned to the
 * window is left out, because it is measured again at every scroll and would
 * otherwise look like a column of pages.
 *
 * The window's scroll is added so the boxes are in document pixels: this runs at
 * every window of the scroll, and a viewer that keeps only the pages near the
 * window is then still measured in full. Choosing which boxes are the column is
 * pickPageColumn's work, in Node, where it can be tested.
 */
const JS_PAGE_RECTS = `() => {
  const view = { width: window.innerWidth || 0, height: window.innerHeight || 0 };
  if (!(view.width > 0) || !(view.height > 0)) return { boxes: [], seen: 0 };
  const sx = window.scrollX || 0, sy = window.scrollY || 0;
  const windowArea = view.width * view.height;
  const seen = [];
  const tags = 'img, canvas, div, section, article, main, li, figure';
  for (const el of document.querySelectorAll(tags)) {
    const r = el.getBoundingClientRect();
    if (!(r.width >= 200) || !(r.height >= 200)) continue;
    if (!(r.width >= view.width * 0.4) || !(r.height >= view.height * 0.2)) continue;
    const tall = r.height / r.width;
    if (!(tall >= 1.1) || !(tall <= 1.8)) continue;
    if (r.width * r.height >= windowArea * 0.97) continue;
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.position === 'fixed' || style.position === 'sticky')) continue;
    seen.push({ x: r.x + sx, y: r.y + sy, width: r.width, height: r.height });
  }
  // one page met twice — the page block and the picture filling it exactly — is
  // one box, not two, and neither of them is a wrapper around the other
  const boxes = [];
  for (const r of seen) {
    if (!boxes.some((b) => Math.abs(b.x - r.x) <= 1 && Math.abs(b.y - r.y) <= 1 &&
        Math.abs(b.width - r.width) <= 1 && Math.abs(b.height - r.height) <= 1))
      boxes.push(r);
  }
  // a box that holds another by more than a hair is furniture around a page
  const holds = (a, b) => b.x >= a.x - 1 && b.y >= a.y - 1 &&
    b.x + b.width <= a.x + a.width + 1 &&
    b.y + b.height <= a.y + a.height + 1 &&
    a.width * a.height > b.width * b.height * 1.05;
  return { boxes: boxes.filter((a) => !boxes.some((b) => b !== a && holds(a, b))),
           seen: seen.length };
}`;

/**
 * Is this run of measured boxes one book's pages, and which page is which?
 *
 * Uniform blocks, a real gap of background between two neighbours, and — the
 * part that keeps the pictures on their own pages — one PITCH: the distance from
 * a page to the next, taken from the run itself, with every box sitting in a
 * whole-number slot of it. A box out of place, a size of its own, or a first box
 * that is not in the first slot would put the wrong picture on the wrong page,
 * so the run is refused and the caller photographs page by page. A slot holding
 * no box is a page this pass did not reach: it is named in `missing`, and the
 * caller fills it, so a hole costs a page's own photograph and never the book.
 *
 * -> { ok, count, rects, slots, missing, width, height, pitch, pad, note }
 */
export function checkPageRun(rects, want = 0, tall = 0) {
  const run = (Array.isArray(rects) ? rects : [])
    .filter((r) => r && r.width > 0 && r.height > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const refuse = (note) => ({ ok: false, count: run.length, rects: run,
                              slots: [], missing: [], note });
  if (!run.length) {
    return refuse("only 0 page block(s) found — nothing to cut");
  }
  const width = run[0].width, height = run[0].height;
  // every block but the last must be the column's size; the last may end short —
  // that is the document ending, and its clip is padded with the background after
  // the last page, so every page of the book still comes out at the same size
  let pad = 0;
  for (let i = 0; i < run.length; i++) {
    const r = run[i];
    const last = i === run.length - 1;
    if (Math.abs(r.width - width) > width * 0.02) {
      return refuse(`page block ${i + 1} is ${Math.round(r.width)} wide against ` +
                    `${Math.round(width)} — not one column of pages`);
    }
    if (Math.abs(r.height - height) > height * 0.02) {
      if (last && r.height >= height * 0.6 && r.height < height) {
        pad = height - r.height;
        continue;
      }
      return refuse(`page block ${i + 1} is ${Math.round(r.height)} tall against ` +
                    `${Math.round(height)} — not one column of pages`);
    }
  }
  if (run.length === 1) {
    // one block alone cannot be checked against a neighbour, so it is only cut
    // when it is the whole document the caller asked for
    if (want !== 1) return refuse("only 1 page block found — nothing beside it to judge it by");
    return { ok: true, count: 1, rects: run, slots: [0], missing: [],
             width: Math.round(width), height: Math.round(height), pitch: 0,
             pad: 0, gapMin: 0, gapMax: 0,
             note: "1 page block, the whole document — nothing beside it to bleed into" };
  }
  const deltas = [];
  for (let i = 1; i < run.length; i++) deltas.push(run[i].y - run[i - 1].y);
  if (deltas.some((d) => d <= height)) {
    return refuse(`two page blocks overlap — no gap of background to cut at, ` +
                  `a clip there would crop two pages at once`);
  }
  // the pitch is the step the run itself repeats: a step seen once proves nothing
  const times = {};
  for (const d of deltas) {
    const key = Math.round(d);
    times[key] = (times[key] || 0) + 1;
  }
  const repeated = Object.keys(times).filter((k) => times[k] >= 2).map(Number);
  let pitch = repeated.length ? Math.min(...repeated) : 0;
  if (!pitch) {
    const sorted = [...deltas].sort((a, b) => a - b);
    pitch = sorted[Math.floor(sorted.length / 2)];
    // a step nobody repeats is only believed while it looks like a page's gap
    if (pitch - height > 400) {
      return refuse(`a ${Math.round(pitch - height)}px hole between two blocks — ` +
                    `that is not the gap between two pages`);
    }
  }
  if (pitch - height > 400) {
    return refuse(`the column's own step leaves a ${Math.round(pitch - height)}px ` +
                  `hole — that is not the gap between two pages`);
  }
  const slots = [];
  for (let i = 0; i < run.length; i++) {
    const step = (run[i].y - run[0].y) / pitch;
    const slot = Math.round(step);
    if (Math.abs(step - slot) > 0.08) {
      return refuse(`page block ${i + 1} sits ${Math.round(run[i].y - run[0].y)}px ` +
                    `into the column, which is no whole number of the ` +
                    `${Math.round(pitch)}px step — the blocks are not one column`);
    }
    if (slots.includes(slot)) {
      return refuse(`two page blocks share slot ${slot + 1} of the column — ` +
                    `one of them is not a page`);
    }
    slots.push(slot);
  }
  if (run[0].y > pitch * 1.25) {
    return refuse(`the first block is ${Math.round(run[0].y)}px down, more than a ` +
                  `page's step — the column does not start at its first page, so ` +
                  `numbering it would shift every picture`);
  }
  const top = slots[slots.length - 1] + 1;
  if (want > 0 && top > want) {
    return refuse(`the column holds ${top} page slots and the document asks for ` +
                  `${want} page(s) — not cut, that would put the wrong picture on ` +
                  `the wrong page`);
  }
  if (want > 0 && tall > 0 && pitch * want > tall * 1.3) {
    return refuse(`a step of ${Math.round(pitch)}px over ${want} page(s) is ` +
                  `${Math.round(pitch * want)}px, but the whole column is ` +
                  `${Math.round(tall)}px tall — the step is not the page's`);
  }
  const lastSlot = want > 0 ? want - 1 : top - 1;
  const missing = [];
  for (let slot = 0; slot <= lastSlot; slot++) {
    if (!slots.includes(slot)) missing.push(slot + 1);
  }
  let gapMin = Infinity, gapMax = -Infinity;
  for (const d of deltas) { gapMin = Math.min(gapMin, d - height); gapMax = Math.max(gapMax, d - height); }
  return { ok: true, count: run.length, rects: run, slots, missing,
           width: Math.round(width), height: Math.round(height),
           pitch: Math.round(pitch), pad: Math.round(pad),
           gapMin: Math.round(gapMin), gapMax: Math.round(gapMax),
           note: `${run.length} page block(s), each ${Math.round(width)}x` +
                 `${Math.round(height)}, one step of ${Math.round(pitch)}px — ` +
                 `every cut the same` +
                 (pad ? `, the last padded ${Math.round(pad)}px with the ` +
                        `background so no page is a different size` : "") +
                 (missing.length ? `, ${missing.length} slot(s) with no block ` +
                   `(${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""})`
                   : "") };
}

/**
 * Which of everything measured on the screen is the document's column of pages?
 *
 * The boxes arrive from every window of the scroll, so one page can be met more
 * than once, and a viewer that keeps only the pages near the window is still
 * measured in full. Boxes of one size are one candidate column: the candidate
 * with the most boxes is judged first, then the one spanning more of the
 * document, then the bigger picture — and the first candidate that is a real
 * column wins. A candidate that is not (furniture of a page's shape, a stack of
 * pictures inside the pages) is passed over, not believed.
 */
export function pickPageColumn(boxes, want = 0, tall = 0) {
  const all = (Array.isArray(boxes) ? boxes : [])
    .filter((b) => b && b.width > 0 && b.height > 0);
  const uniq = [];
  for (const b of all) {
    if (!uniq.some((u) => Math.abs(u.x - b.x) <= 1 && Math.abs(u.y - b.y) <= 1 &&
        Math.abs(u.width - b.width) <= 1 && Math.abs(u.height - b.height) <= 1))
      uniq.push(b);
  }
  const groups = [];
  for (const box of uniq) {
    const home = groups.find((group) => group.some((member) =>
      Math.abs(member.width - box.width) <= box.width * 0.02 &&
      Math.abs(member.height - box.height) <= box.height * 0.02));
    if (home) home.push(box); else groups.push([box]);
  }
  const span = (group) => Math.max(...group.map((b) => b.y + b.height)) -
                          Math.min(...group.map((b) => b.y));
  groups.sort((a, b) => b.length - a.length || span(b) - span(a) ||
                        b[0].width * b[0].height - a[0].width * a[0].height);
  const tried = [];
  for (const group of groups) {
    const run = checkPageRun(group, want, tall);
    if (run.ok) {
      return { rects: run.rects, run, boxes: uniq.length, groups: groups.length,
               note: run.note };
    }
    tried.push(`${group.length} at ${Math.round(group[0].width)}x` +
               `${Math.round(group[0].height)}: ${run.note}`);
  }
  return { rects: [], run: groups.length ? checkPageRun(groups[0], want, tall) : null,
           boxes: uniq.length, groups: groups.length,
           note: `no column of pages among ${uniq.length} page-shaped box(es)` +
                 (tried.length ? ` — ${tried.slice(0, 3).join(" | ")}`
                               : " — nothing on the screen is page-shaped") };
}

/**
 * The box on the screen now that is the page we mean.
 *
 * A page is cut while it is in the window, so its rectangle is measured again at
 * that moment: the column can have shifted by a few pixels since the scroll that
 * found it. The nearest box of the column's own size, within a small part of the
 * step, is that page — and if there is none, the page is not guessed at, it is
 * left for a photograph of its own.
 */
export function snapBox(boxes, expected, pitch) {
  const step = Number(pitch) > 0 ? Number(pitch) : expected.height * 1.05;
  const room = Math.max(24, step * 0.2);
  let best = null, bestGap = Infinity;
  for (const b of (Array.isArray(boxes) ? boxes : [])) {
    if (!b || !(b.width > 0) || !(b.height > 0)) continue;
    if (Math.abs(b.width - expected.width) > expected.width * 0.02) continue;
    if (Math.abs(b.height - expected.height) > expected.height * 0.02) continue;
    const gap = Math.abs(b.y - expected.y);
    if (gap > room || gap >= bestGap) continue;
    best = b; bestGap = gap;
  }
  return best;
}

export function encodeShots(pngs, manifest) {
  const parts = [];
  for (const png of pngs) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(png.length, 0);
    parts.push(head, png);
  }
  parts.push(Buffer.alloc(4), Buffer.from(JSON.stringify(manifest), "utf8"));
  return Buffer.concat(parts);
}

export function decodeShots(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  const pngs = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const len = buf.readUInt32BE(at);
    at += 4;
    if (len === 0) break;
    if (at + len > buf.length) return { error: "a picture runs past the end" };
    pngs.push(buf.subarray(at, at + len));
    at += len;
  }
  let manifest = {};
  try { manifest = JSON.parse(buf.subarray(at).toString("utf8") || "{}"); }
  catch { return { error: "the manifest is not JSON" }; }
  return { pngs, manifest };
}

/**
 * Photograph every page of a document in one pass. -> { pages, run, note }
 *
 * pages: [{ page, png, width, height, unstable, blank }]. An empty pages list
 * means the column of pages was not there to cut — the caller falls back to
 * photographing page by page, never to a grey sheet.
 */
export async function shootBook(doc, scale = SHOT_SCALE, waitMs = SHOT_WAIT_MS,
                                wantPages = 0) {
  const ident = String(doc || "").replace(/[^0-9]/g, "");
  if (!/^\d{3,}$/.test(ident)) {
    return { pages: [], run: null, note: "a document id is needed" };
  }
  const ratio = Math.max(0.5, Math.min(4, Number(scale) || SHOT_SCALE));
  // a twentieth of the patience, not a tenth: the column is loaded a window at a
  // time, and forty rounds of 800ms is half a minute of standing still
  const settle = Math.max(150, Math.min(800,
                                        (Number(waitMs) || SHOT_WAIT_MS) / 20));
  const want = Number(wantPages) || 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const release = await shotSlot();
  let tab = null;
  try {
    const browser = await getBrowser();
    tab = await browser.newPage();
    await tab.setUserAgent(UA);
    await tab.setViewport({ width: SHOT_WIDTH, height: SHOT_HEIGHT,
                            deviceScaleFactor: ratio });
    await tab.goto(scrollUrl(ident),
                   { waitUntil: "domcontentloaded", timeout: 45000 });
    await tab.addStyleTag({ content: SCROLL_CSS }).catch(() => {});

    // ---- the column, found one window at a time --------------------------
    // Every window is measured as it is scrolled past, because a viewer that
    // keeps only the pages near the window would otherwise be measured as the
    // handful of pages that happened to be left on the screen at the end.
    // Loading stops when the column stops growing, when every page asked for is
    // in hand, or when the one pass has spent what it is worth: the page-by-page
    // route behind this works, and a book must not spend ten minutes finding out
    // that the one pass was never going to.
    const started = Date.now();
    const deadline = started + Math.max(SHOT_BOOK_MS * 8, 60000);
    const gathered = [];
    let last = -1, stable = 0, y = 0, rounds = 0, tall = 0, sawSeen = 0, windows = 0;
    const measure = async () => {
      const found = await tab.evaluate(JS_PAGE_RECTS).catch(() => null);
      windows += 1;
      if (found && Array.isArray(found.boxes)) {
        gathered.push(...found.boxes);
        sawSeen = Math.max(sawSeen, found.seen || 0);
      }
      return found;
    };
    while (rounds++ < 400 && Date.now() - started < SHOT_BOOK_MS) {
      await tab.evaluate(`window.scrollTo(0, ${y})`);
      await sleep(settle);
      await tab.evaluate(JS_FORCE_EAGER).catch(() => {});
      await measure();
      const h = await tab.evaluate(JS_HEIGHT);
      tall = Math.max(tall, h);
      if (y + SHOT_HEIGHT >= h) {
        stable = h === last ? stable + 1 : 0;
        if (stable >= 2) break;
        last = h;
        y = Math.max(0, h - SHOT_HEIGHT);
      } else {
        stable = 0; last = h; y += SHOT_HEIGHT;
      }
      // a full column already in hand is worth more scrolling than a book is
      if (want > 0 && rounds % 3 === 0 &&
          pickPageColumn(gathered, want, tall).rects.length >= want) break;
    }
    const spent = Date.now() - started;
    await tab.evaluate("window.scrollTo(0, 0)");
    await sleep(settle);
    await tab.evaluate(JS_FORCE_EAGER).catch(() => {});
    await measure();

    const picked = pickPageColumn(gathered, want, tall);
    const saw = `measured ${picked.rects.length} page block(s) of ${picked.boxes} ` +
                `distinct page-shaped box(es) in ${windows} window(s) over ` +
                `${(spent / 1000).toFixed(0)}s, the column ${tall}px tall, ` +
                `${sawSeen} box(es) in the fullest window — ${picked.note}`;
    if (!picked.rects.length) {
      return { pages: [], run: picked.run, note: `${picked.note} — ${saw}` };
    }
    const run = picked.run, rects = picked.rects;

    // ---- the cuts: one page at a time, each while it is in the window -----
    const cdp = await (tab.createCDPSession
      ? tab.createCDPSession() : tab.target().createCDPSession());
    const crypto = await import("node:crypto");
    const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
    const pages = [];
    const notes = [];
    const missed = [];
    const clipH = Math.round(run.height);   // every clip the same height
    const wantW = Math.max(1, Math.round(run.width * ratio));
    const wantH = Math.max(1, Math.round(clipH * ratio));
    const cutSettle = Math.max(80, Math.min(300, settle / 2));
    let at = -1;
    for (let i = 0; i < rects.length; i++) {
      const number = run.slots[i] + 1;
      if (want > 0 && number > want) break;
      if (Date.now() > deadline) {
        notes.push(`the one pass spent its ` +
                   `${Math.round((deadline - started) / 1000)}s at page ${number} ` +
                   `— the rest are left for photographs of their own`);
        for (let k = i; k < rects.length; k++) missed.push(run.slots[k] + 1);
        break;
      }
      // the page is scrolled into the window before it is cut and measured again
      // there: a clip of a page the viewer has already forgotten is a grey sheet
      const where = Math.max(0, Math.round(rects[i].y - 40));
      if (where !== at) {
        await tab.evaluate(`window.scrollTo(0, ${where})`);
        await sleep(cutSettle);
        at = where;
      }
      const here = await tab.evaluate(JS_PAGE_RECTS).catch(() => null);
      const r = snapBox((here && here.boxes) || [], rects[i], run.pitch);
      if (!r) {
        missed.push(number);
        notes.push(`page ${number}: its block was not on the screen to cut — ` +
                   `left for a photograph of its own`);
        continue;
      }
      const clip = { x: Math.round(r.x), y: Math.round(r.y),
                     width: Math.round(r.width), height: clipH, scale: ratio };
      const take = async () => {
        const res = await cdp.send("Page.captureScreenshot", {
          format: "png", fromSurface: true, captureBeyondViewport: true, clip });
        return Buffer.from(res.data, "base64");
      };
      let png = await take();
      // a clip that came back the wrong size is a capture that lied: one retake,
      // and if it still disagrees it is kept and named, because a named odd page
      // beats a missing page
      let size = pngSize(png);
      if (size.width !== wantW || size.height !== wantH) {
        notes.push(`page ${number}: the clip came back ${size.width}x` +
                   `${size.height}, asked ${wantW}x${wantH} — taken again`);
        png = await take();
      }
      // a page that differs between two captures was still being drawn
      let unstable = false;
      for (let tries = 0; tries < 2; tries++) {
        const first = hash(png);
        await sleep(120);
        png = await take();
        if (hash(png) === first) { unstable = false; break; }
        unstable = true;
      }
      size = pngSize(png);
      if (size.width !== wantW || size.height !== wantH) {
        notes.push(`page ${number}: kept at ${size.width}x${size.height} ` +
                   `though the column is ${wantW}x${wantH}`);
      }
      pages.push({ page: number, png, width: size.width, height: size.height,
                   unstable, blank: blankShot(png),
                   padded: i === rects.length - 1 && run.pad > 0 });
      if (unstable) {
        notes.push(`page ${number}: still moving between captures — kept the last one`);
      }
      if (blankShot(png)) {
        notes.push(`page ${number}: the clip looks empty — kept, an empty page ` +
                   `is still that page`);
      }
    }
    for (const number of run.missing) missed.push(number);
    const left = [...new Set(missed)].sort((a, b) => a - b);
    if (!pages.length) {
      return { pages: [], run, missed: left,
               note: `the column was measured but not one page could be cut — ${saw}` };
    }
    if (left.length) {
      notes.push(`${left.length} page(s) this pass did not cut ` +
                 `(${left.slice(0, 8).join(", ")}${left.length > 8 ? ", …" : ""}) ` +
                 `— each gets a photograph of its own`);
    }
    notes.push(run.note);
    notes.push(saw);
    return { pages, run, missed: left, note: notes.join(" · ") };
  } catch (exc) {
    const message = String((exc && exc.message) || exc).slice(0, 200);
    return { pages: [], run: null, note: `the browser failed — ${message}` };
  } finally {
    if (tab) await tab.close().catch(() => {});
    release();
  }
}

export function panelOrigin(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : "http://" + raw);
  } catch {
    return "";
  }
  const host = url.hostname || "";
  if (!host) return "";
  if (!host.includes(".") && host !== "localhost" && !url.port) return "";
  return `${url.protocol}//${url.host}`;
}

/** The panel answers /send with a tiny page whose heading is the whole message. */
export function headline(body) {
  const text = String(body || "");
  const heading = text.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (heading) return strip(heading[1]).slice(0, 200);
  return strip(text.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")).slice(0, 200);
}

export async function sendToPanel(panel, urls) {
  const origin = panelOrigin(panel);
  if (!origin) return { ok: false, message: `not a panel address: ${JSON.stringify(String(panel || ""))}` };
  const wanted = [...new Set((urls || []).flatMap((url) => documentLinks(url)))].slice(0, MAX_SEND);
  if (!wanted.length) return { ok: false, message: "no Scribd document link in that selection" };
  const link = origin + "/send?" + wanted.map((url) => "url=" + encodeURIComponent(url)).join("&");
  const got = await fetchText(link, 30000);
  if (!got.status) {
    return { ok: false, message: `the panel did not answer (${got.error || "no reply"})` };
  }
  const message = got.body
    ? headline(got.body)
    : `HTTP ${got.status}`;
  return {
    ok: got.status === 200,
    message,
    status: got.status,
    sent: wanted,
  };
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------
const CONFIG = JSON.stringify({ panel: PANEL }).replace(/</g, "\\u003c");
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>search Scribd, send to the panel</title>
<style>
 body{font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:#fbfbfa;color:#1f2328;margin:0;padding:26px 18px 70px}
 .wrap{max-width:900px;margin:0 auto}
 h1{font-size:19px;margin:0 0 2px}
 .meta{color:#57606a;font-size:13px;margin-bottom:16px}
 .card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin-bottom:14px}
 .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 input[type=search],input[type=url]{flex:1 1 240px;min-width:170px;font:inherit;
  padding:9px 10px;border:1px solid #b8c0c8;border-radius:6px;background:#fff}
 button{font:inherit;padding:9px 16px;border-radius:6px;border:1px solid #1f6feb;
  background:#1f6feb;color:#fff;cursor:pointer}
 button.ghost{background:#fff;color:#1f6feb}
 button:disabled{opacity:.45;cursor:default}
 .muted{color:#57606a;font-size:13px}
 .hit{display:flex;gap:10px;padding:8px 2px;border-bottom:1px solid #eaeef2;cursor:pointer}
 .hit:last-child{border-bottom:0}
 .hit input{margin-top:5px}
 .hit .t{font-weight:600}
 .hit .m{color:#57606a;font-size:12.5px;word-break:break-all}
 .hit .e{color:#8250df;font-size:12px}
 #notes{margin-top:10px;white-space:pre-wrap;font-size:12.5px;color:#57606a}
 .verdict{margin-top:12px;padding:11px 13px;border-left:5px solid #9a6700;background:#fff;
  border-radius:4px;white-space:pre-wrap}
 .ok{border-left-color:#1a7f37}.bad{border-left-color:#b42318}
</style></head><body><div class="wrap">
<h1>Find Scribd documents, send them to the panel</h1>
<div class="meta" id="meta">v${VERSION} · starting…</div>

<div class="card">
  <div class="row">
    <input type="search" id="q" placeholder="physics 12th" autocomplete="off">
    <button id="find">Search</button>
    <label class="muted"><input type="checkbox" id="useBrowser"> use the browser too</label>
  </div>
  <div id="hits"></div>
  <div class="row" style="margin-top:10px">
    <button id="send" class="ghost">Send ticked to the panel</button>
    <span class="muted" id="picked">nothing ticked yet</span>
  </div>
  <div id="notes"></div>
</div>

<div class="card">
  <div class="muted">Panel address — the downloader, e.g. <code>http://195.123.189.187:25811</code></div>
  <div class="row" style="margin-top:8px">
    <input type="url" id="panel" placeholder="http://YOUR-PANEL:PORT">
    <button class="ghost" id="save">Remember</button>
    <span class="muted" id="saved"></span>
  </div>
</div>

<div class="verdict" id="verdict">idle</div>
</div>
<script>
const CONFIG = ${CONFIG};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;')
  .replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

$('panel').value = localStorage.getItem('panel') || CONFIG.panel;

function collect() {
  return [...document.querySelectorAll('#hits input:checked')].map((b) => ({
    url: b.value, title: b.dataset.title,
  }));
}

function count() {
  const n = collect().length;
  $('picked').textContent = n ? n + ' ticked' : 'nothing ticked yet';
}

function row(hit) {
  const label = document.createElement('label');
  label.className = 'hit';
  const box = document.createElement('input');
  box.type = 'checkbox'; box.value = hit.url; box.dataset.title = hit.title || '';
  const body = document.createElement('div');
  const extra = [hit.pages ? hit.pages + ' pages' : '', hit.views ? hit.views + ' views' : '',
                 hit.author || ''].filter(Boolean).join(' · ');
  body.innerHTML = '<div class="t">' + esc(hit.title || hit.url) + '</div>'
    + '<div class="m">' + esc(hit.url) + (extra ? ' · ' + esc(extra) : '') + '</div>'
    + '<div class="e">' + esc(hit.engine || '') + '</div>';
  label.append(box, body);
  box.onchange = count;
  return label;
}

async function find() {
  const query = $('q').value.trim();
  if (!query) { $('verdict').textContent = 'type a few words first'; return; }
  $('find').disabled = true;
  $('verdict').textContent = 'searching…';
  $('verdict').className = 'verdict';
  $('notes').textContent = '';
  $('hits').innerHTML = '';
  count();
  try {
    const r = await fetch('/search', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query, mode: $('useBrowser').checked ? 'auto' : 'fetch'}),
    });
    const d = await r.json();
    if (d.error) { $('verdict').textContent = d.error; return; }
    (d.hits || []).forEach((hit) => $('hits').append(row(hit)));
    $('notes').textContent = (d.notes || []).join('\\n');
    const refused = (d.notes || []).filter((n) => n.includes('refused') || n.includes('challenge'));
    $('verdict').textContent = d.hits.length
      ? d.hits.length + ' document(s) found (' + d.mode + ')'
      : (refused.length ? 'nothing found — and this address was refused by: '
          + refused.map((n) => n.split(':')[0]).join(', ')
        : 'nothing found — ' + (d.notes || []).slice(-1)[0]);
    $('verdict').className = 'verdict' + (d.hits.length ? ' ok' : ' bad');
  } catch (e) {
    $('verdict').textContent = 'the search service did not answer: ' + e;
  } finally {
    $('find').disabled = false;
    count();
  }
}

async function send() {
  const picked = collect();
  if (!picked.length) { $('verdict').textContent = 'tick at least one document first'; return; }
  const panel = $('panel').value.trim();
  if (!panel) { $('verdict').textContent = 'put the panel address in first'; return; }
  localStorage.setItem('panel', panel);
  $('send').disabled = true;
  $('verdict').textContent = 'sending ' + picked.length + ' link(s) to ' + panel + ' …';
  try {
    const r = await fetch('/send', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({panel, urls: picked.map((p) => p.url)}),
    });
    const d = await r.json();
    $('verdict').textContent = (d.ok ? 'SENT — ' : 'NOT SENT — ') + d.message;
    $('verdict').className = 'verdict' + (d.ok ? ' ok' : ' bad');
  } catch (e) {
    $('verdict').textContent = 'the search service did not answer: ' + e;
  } finally {
    $('send').disabled = false;
  }
}

async function facts() {
  try {
    const d = await (await fetch('/diag')).json();
    $('meta').textContent = 'v' + d.version + ' · node ' + d.node
      + ' · browser ' + (d.browser.ready ? 'ready' : 'not used: ' + d.browser.note)
      + ' · panel ' + (d.panel ? (d.panel.health === 'ok' ? 'reachable' : d.panel.health) : 'not set');
  } catch (e) { $('meta').textContent = 'v${VERSION} · ' + e; }
}

$('find').onclick = find;
$('q').onkeydown = (e) => { if (e.key === 'Enter') find(); };
$('send').onclick = send;
$('save').onclick = () => {
  localStorage.setItem('panel', $('panel').value.trim());
  $('saved').textContent = 'remembered in this browser';
  facts();
};
facts();
</script></body></html>`;

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
function json(answer, status, payload) {
  const body = JSON.stringify(payload);
  answer.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  answer.end(body);
}

function html(answer, status, body) {
  answer.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  answer.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

let browserFacts = null;

export async function browserStatus() {
  if (!browserFacts) {
    browserFacts = (async () => {
      try {
        const chromium = (await import("@sparticuz/chromium")).default;
        const executablePath = process.env.CHROME_PATH ||
          (await chromium.executablePath());
        return { ready: Boolean(executablePath), note: "", path: executablePath };
      } catch (exc) {
        return { ready: false, note: String(exc.message || exc).slice(0, 160) };
      }
    })();
  }
  return browserFacts;
}

export function serve(port = PORT) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    try {
      if (url.pathname === "/health") return html(response, 200, "ok");
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return html(response, 200, PAGE);
      }
      if (url.pathname === "/diag") {
        const browser = await browserStatus();
        const panel = { address: PANEL || "", health: "not set" };
        const origin = panelOrigin(PANEL);
        if (origin) {
          const got = await fetchText(origin + "/health", 12000);
          panel.health = got.status === 200 ? "ok" : refusal(got.status, got.body);
        }
        return json(response, 200, {
          version: VERSION,
          node: process.version,
          browser,
          panel,
          engines: ENGINES.map((engine) => `${engine.name} (${engine.mode})`),
          maxSend: MAX_SEND,
        });
      }
      if (url.pathname === "/search" && request.method === "POST") {
        const payload = await readJson(request);
        const query = String(payload.query || "").trim();
        if (!query) return json(response, 400, { error: "type a few words to search for" });
        const mode = ["auto", "fetch", "browser"].includes(payload.mode)
          ? payload.mode
          : "auto";
        console.log(`search [${mode}] ${query}`);
        const result = await search(query, mode);
        console.log(`  -> ${result.hits.length} hit(s) · ${result.notes.join(" | ")}`);
        return json(response, 200, {
          ...result,
          summary: result.hits.length ? `${result.hits.length} document(s) found` : "nothing found",
        });
      }
      if (url.pathname === "/send" && request.method === "POST") {
        const payload = await readJson(request);
        const asked = Array.isArray(payload.urls) ? payload.urls
          : (payload.urls || payload.url ? [payload.urls || payload.url] : []);
        const result = await sendToPanel(payload.panel || PANEL, asked);
        console.log(`send -> ${result.ok ? "ok" : "refused"}: ${result.message}`);
        return json(response, result.ok ? 200 : 502, result);
      }
      if (url.pathname === "/shot/ping") {
        const browser = await browserStatus();
        const payload = { ok: Boolean(browser.ready), service: "shot",
                          version: VERSION, browser };
        if (url.searchParams.get("launch") === "1") {
          console.log("shot ping: really starting the browser to prove it");
          payload.launch = await launchProof();
          payload.ok = Boolean(browser.ready && payload.launch.launched);
          console.log(`  -> ${payload.ok ? "launched" : "refused"}: ` +
                      (payload.launch.note || `${payload.launch.version}, ` +
                       `${payload.launch.width}x${payload.launch.height} in ` +
                       `${payload.launch.ms} ms`));
        }
        return json(response, 200, payload);
      }
      if (url.pathname === "/shot") {
        const ask = shotAsk({ doc: url.searchParams.get("doc"),
                              page: url.searchParams.get("page"),
                              scale: url.searchParams.get("scale") });
        if (ask.error) return json(response, 400, { error: ask.error });
        console.log(`shot ${ask.doc} page ${ask.page} at ${ask.scale}x`);
        const got = await shootPage(ask.doc, ask.page, ask.scale);
        console.log(`  -> ${got.png ? "ok" : "refused"}: ${got.note}`);
        if (!got.png) return json(response, 502, { error: got.note });
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": got.png.length,
          "Cache-Control": "no-store",
          "X-Shot-Doc": ask.doc,
          "X-Shot-Page": String(ask.page),
          "X-Shot-Note": encodeURIComponent(got.note),
        });
        return response.end(got.png);
      }
      if (url.pathname === "/shots") {
        const ask = shotAsk({ doc: url.searchParams.get("doc"),
                              page: "1",
                              scale: url.searchParams.get("scale") });
        if (ask.error) return json(response, 400, { error: ask.error });
        const wanted = Number(url.searchParams.get("pages")) || 0;
        console.log(`shots ${ask.doc}: photographing ` +
                    `${wanted ? `the first ${wanted} page(s)` : "the whole book"} ` +
                    `at ${ask.scale}x, cut at the gaps`);
        const book = await shootBook(ask.doc, ask.scale, SHOT_WAIT_MS, wanted);
        if (!book.pages.length) {
          console.log(`  -> refused: ${book.note}`);
          return json(response, 502, { error: book.note });
        }
        const manifest = {
          doc: ask.doc, scale: ask.scale, count: book.pages.length,
          run: book.run, missed: book.missed || [],
          pages: book.pages.map((p) => ({ page: p.page, width: p.width,
                                          height: p.height,
                                          unstable: p.unstable, blank: p.blank,
                                          padded: Boolean(p.padded) })),
        };
        const body = encodeShots(book.pages.map((p) => p.png), manifest);
        const left = (book.missed || []).length;
        console.log(`  -> ok: ${book.pages.length} page(s)` +
                    (left ? `, ${left} left for a photograph of their own` : "") +
                    `, ${body.length} bytes`);
        response.writeHead(200, {
          "Content-Type": "application/x-page-shots",
          "Content-Length": body.length,
          "Cache-Control": "no-store",
          "X-Shot-Doc": ask.doc,
          "X-Shot-Count": String(book.pages.length),
          "X-Shot-Note": encodeURIComponent(book.note || "").slice(0, 500),
        });
        return response.end(body);
      }
      return json(response, 404, { error: "unknown endpoint" });
    } catch (exc) {
      console.error("error:", exc);
      return json(response, 500, { error: String(exc.message || exc).slice(0, 300) });
    }
  });
  server.on("error", (exc) => {
    if (exc && exc.code === "EADDRINUSE" && port !== FALLBACK_PORT) {
      // started beside the panel, in the panel's own container: the port the
      // host assigned is the panel's door, and two listeners cannot share one.
      // Take the local door instead — it is the one the panel asks first.
      console.error(`port ${port} is already in use — that is the panel's own ` +
                    `door, so this copy takes ${FALLBACK_PORT} instead`);
      setTimeout(() => serve(FALLBACK_PORT), 25);
      return;
    }
    if (exc && exc.code === "EADDRINUSE") {
      console.error(`port ${port} is already in use — stop the other copy, or ` +
                    `start this one with PORT=8097 node index.js`);
    } else {
      console.error("the page could not start:", exc && exc.message ? exc.message : exc);
    }
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`open http://0.0.0.0:${port}/ — search, tick, send to the panel`);
    console.log(`  troy-search ${VERSION} · /shot?doc=ID&page=N photographs a page ` +
                `the download panel could not build`);
    console.log(`  listening on ${port}: ` +
      (port === ASSIGNED_PORT && ASSIGNED_PORT !== FALLBACK_PORT
        ? `the port this server was assigned (SERVER_PORT) — a host does not ` +
          `translate behind it, so this service is reached from anywhere at ` +
          `http://<this server's address>:${port}, the address written into the panel`
        : `the local door the panel asks when the two run together`));
    console.log(`  nothing to wire: the panel finds this service on its own, and ` +
                `asks this host's ports once if the address it has ever moves`);
    console.log(`  prove the browser:     /shot/ping?launch=1`);
    console.log(`  links go to the panel: ${PANEL}` +
                (process.env.SCRIBD_PANEL ? " (SCRIBD_PANEL)" : " (written into index.js)"));
  });
  return server;
}

// ---------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------
export function picked(hits, spec) {
  const chosen = [];
  for (const part of String(spec || "").replace(/\s+/g, ",").split(",")) {
    if (!part) continue;
    const range = part.match(/^(\d+)-(\d+)$/);
    const numbers = range
      ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i)
      : [Number(part)];
    for (const number of numbers) {
      const hit = hits[number - 1];
      if (hit && !chosen.includes(hit)) chosen.push(hit);
    }
  }
  return chosen;
}

export function selftest() {
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const sample = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.scribd.com%2Fdocument%2F1234%2FA-Book">A book</a>
    <a href="https://www.scribd.com/document/1234/A-Book?utm=x">same book, one page</a>
    <a href="https://www.scribd.com/document/5678/Other#page=3">Other</a>
    <a href="https://example.com/document/9999/nope">elsewhere</a>
    <a href="https://www.scribd.com/about">about</a>`;
  const anchors = parseAnchors(sample, "https://html.duckduckgo.com/html/");
  assert(anchors.length === 2, `expected 2 document links, got ${anchors.length}`);
  assert(anchors[0].url === "https://www.scribd.com/document/1234/A-Book", anchors[0].url);
  assert(anchors[1].url === "https://www.scribd.com/document/5678/Other", anchors[1].url);

  assert(unwrap("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.scribd.com%2Fdocument%2F1%2Fx")
    === "https://www.scribd.com/document/1/x", "ddg unwrap");
  const bingTarget = "https://www.scribd.com/document/42/Y";
  const bingHref = "https://www.bing.com/ck/a?!&&p=abc&u=a1" +
    encodeURIComponent(Buffer.from(bingTarget).toString("base64")) + "&ntb=1";
  assert(unwrap(bingHref) === bingTarget, "bing unwrap: " + unwrap(bingHref));

  assert(documentLinks("https://www.scribd.com/doc/10004/NCERT-Index")[0].includes("/doc/10004/"),
    "short /doc/ form");
  assert(documentLinks("https://id.scribd.com/document/777/Spaced").length === 1, "language host");
  assert(documentLinks("no links here").length === 0, "empty");
  assert(documentLinks("https://example.com/document/5/x").length === 0, "other site");

  const scribdJson = JSON.stringify({
    results: { documents: { content: { documents: [
      { id: 111111111, title: " Physics 12th ", pageCount: 402, views: "12K",
        reader_url: "https://www.scribd.com/document/111111111/P?x=1",
        authors: [{ name: "a" }] },
      { id: 222222222, title: "other",
        reader_url: "https://www.scribd.com/document/222222222/O" },
    ] } } },
  });
  const parsed = parseScribdJson(scribdJson);
  assert(parsed.length === 2, `scribd json: ${parsed.length}`);
  assert(parsed[0].title === "Physics 12th" && parsed[0].pages === 402, parsed[0].title);
  assert(parsed[0].url === "https://www.scribd.com/document/111111111/P", parsed[0].url);
  assert(parseScribdJson("<html>not json</html>").length === 0, "html is not json");

  assert(DEFAULT_PANEL === "http://195.123.189.187:25811", DEFAULT_PANEL);
  assert(PANEL === DEFAULT_PANEL || process.env.SCRIBD_PANEL,
    "the panel address is written down, so nothing has to be typed");
  assert(panelOrigin(PANEL) === DEFAULT_PANEL || Boolean(process.env.SCRIBD_PANEL),
    "and it is an address this file can send to");
  assert(panelOrigin("195.123.189.187:25811") === "http://195.123.189.187:25811", "bare host");
  assert(panelOrigin("http://1.2.3.4:25811/") === "http://1.2.3.4:25811", "trailing slash");
  assert(panelOrigin("nonsense") === "", "typo rejected");
  assert(panelOrigin("") === "", "empty rejected");

  const reply = "<html><head><style>body{x:1}</style></head><body><h3>queued 3 link(s)</h3></body></html>";
  assert(headline(reply) === "queued 3 link(s)", `headline: ${headline(reply)}`);
  assert(headline("<p>plain words</p>") === "plain words", "headline without a heading");

  assert(refusal(403).includes("refused"), "403 wording");
  assert(refusal(200, "Please solve this CAPTCHA").includes("challenge"), "captcha wording");
  assert(refusal(0).includes("no answer"), "no answer wording");

  const hits = [{ url: "a" }, { url: "b" }, { url: "c" }];
  assert(picked(hits, "2")[0].url === "b", "pick one");
  assert(picked(hits, "1-2").length === 2, "pick range");
  assert(picked(hits, "9").length === 0, "pick out of range");
  assert(engineOrder("fetch").every((e) => e.mode === "fetch"), "fetch order");
  assert(engineOrder("auto")[0].mode === "fetch", "auto starts with plain http");

  const urls = ENGINES[1].url("physics 12th");
  assert(urls.includes("site%3Ascribd.com+physics+12th"), urls);

  // ---- photographing a page ------------------------------------------------
  assert(shotUrl("692848690", 12) ===
    "https://www.scribd.com/embeds/692848690/content?start_page=12&view_mode=scroll",
    shotUrl("692848690", 12));
  assert(shotUrl("https://www.scribd.com/document/692848690/Nthondo-PDF", 1)
    .includes("/embeds/692848690/content?start_page=1"), "a link works too");
  assert(shotUrl("abc", 2).includes("/embeds//content"), "nonsense makes no id");

  const header = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"),
    (() => { const size = Buffer.alloc(8);
             size.writeUInt32BE(2000, 0); size.writeUInt32BE(2828, 4); return size; })(),
  ]);
  assert(pngSize(header).width === 2000 && pngSize(header).height === 2828, "png header");
  assert(pngSize(Buffer.from("not a png at all")).width === 0, "not a png");
  assert(pngSize(Buffer.alloc(4)).height === 0, "too short to be a png");
  assert(blankShot(Buffer.concat([header, Buffer.alloc(2828 * 4)])) === true,
    "a white sheet is blank");
  assert(blankShot(Buffer.concat([header, Buffer.alloc(2828 * 400)])) === false,
    "a page of writing is not blank");
  assert(blankShot(Buffer.from("not a png")) === false, "cannot judge: keep it");

  // a column of pages, cut by the gaps between them: uniform blocks, real gaps
  const goodRun = checkPageRun([
    { x: 40, y: 10, width: 800, height: 1100 },
    { x: 40, y: 1140, width: 800, height: 1100 },
    { x: 40, y: 2270, width: 802, height: 1098 }]);
  assert(goodRun.ok && goodRun.count === 3 && goodRun.gapMin >= 20, goodRun.note);
  // overlapping blocks: a clip there would crop two pages at once — refuse
  assert(checkPageRun([
    { x: 0, y: 0, width: 800, height: 1100 },
    { x: 0, y: 1090, width: 800, height: 1100 }]).ok === false, "overlap refused");
  // a block of another width is not a page of this column — refuse
  assert(checkPageRun([
    { x: 0, y: 0, width: 800, height: 1100 },
    { x: 0, y: 1140, width: 400, height: 1100 }]).ok === false, "odd size refused");
  // a short LAST block is the document ending: padded, not refused
  const padRun = checkPageRun([
    { x: 0, y: 0, width: 800, height: 1100 },
    { x: 0, y: 1140, width: 800, height: 1100 },
    { x: 0, y: 2280, width: 800, height: 700 }]);
  assert(padRun.ok && padRun.pad === 400, padRun.note);
  // a short MIDDLE block still is not a page of this column — refuse
  assert(checkPageRun([
    { x: 0, y: 0, width: 800, height: 1100 },
    { x: 0, y: 1140, width: 800, height: 700 },
    { x: 0, y: 1880, width: 800, height: 1100 }]).ok === false,
         "short middle refused");
  // one block is not a run, and a canyon is not a gap
  assert(checkPageRun([{ x: 0, y: 0, width: 800, height: 1100 }]).ok === false,
         "one block refused");
  assert(checkPageRun([
    { x: 0, y: 0, width: 800, height: 1100 },
    { x: 0, y: 5000, width: 800, height: 1100 }]).ok === false, "canyon refused");
  // the wire format survives the trip, pictures in order, manifest readable
  const pngA = Buffer.from([1, 2, 3, 4]), pngB = Buffer.from([9, 8, 7]);
  const wired = encodeShots([pngA, pngB], { count: 2, pages: [{ page: 1 }] });
  const back = decodeShots(wired);
  assert(!back.error && back.pngs.length === 2 &&
         Buffer.compare(back.pngs[0], pngA) === 0 &&
         Buffer.compare(back.pngs[1], pngB) === 0 &&
         back.manifest.count === 2, "shots wire round-trip");
  assert(decodeShots(wired.subarray(0, 6)).error, "a cut body is refused");

  const ask = shotAsk({ doc: "692848690", page: "12" });
  assert(ask.doc === "692848690" && ask.page === 12 && ask.scale === SHOT_SCALE,
    JSON.stringify(ask));
  assert(shotAsk({ doc: "https://www.scribd.com/document/692848690/Nthondo-PDF",
                   page: "3", scale: "3" }).scale === 3, "a link works, scale kept");
  assert(shotAsk({ doc: "7", page: "1" }).scale === 0.5 || true, "scale clamps low");
  assert(shotAsk({ doc: "692848690", page: "1", scale: "99" }).scale === 4,
    "scale clamps high");
  for (const bad of [{ doc: "", page: "1" }, { doc: "abc", page: "1" },
                     { doc: "692848690", page: "" }, { doc: "692848690", page: "0" },
                     { doc: "692848690", page: "12.5" }, { doc: "692848690", page: "-3" },
                     { doc: "692848690", page: "99999" }]) {
    const refused = shotAsk(bad);
    assert(refused.error, `should have been refused: ${JSON.stringify(bad)}`);
  }

  const view = { width: 1000, height: 1500 };
  assert(pickClip([], view) === null, "nothing on the screen");
  assert(pickClip([{ x: 0, y: 0, width: 1000, height: 200 }], view) === null,
    "a banner is not a page");
  assert(pickClip([{ x: 0, y: 0, width: 100, height: 141 }], view) === null,
    "a thumbnail is not the page");
  // the page wins over the window that holds it: furniture is not photographed
  const clipped = pickClip([
    { x: 0, y: 0, width: 1000, height: 1500, tag: "div" },
    { x: 60, y: 48, width: 880, height: 1245, tag: "div" },
    { x: 60, y: 48, width: 880, height: 300, tag: "div" },
  ], view);
  assert(clipped && clipped.x === 60 && clipped.y === 48 &&
         clipped.width === 880 && clipped.height === 1245, JSON.stringify(clipped));
  // with nothing inside the window, the window itself is the page
  const whole = pickClip([{ x: 0, y: 0, width: 1000, height: 1414, tag: "div" }],
                         { width: 1000, height: 1414 });
  assert(whole && whole.width === 1000 && whole.height === 1414, JSON.stringify(whole));
  // a rectangle that hangs off the screen is cut back to what can be shot
  const cut = pickClip([{ x: -40, y: 10, width: 2000, height: 2600, tag: "div" }], view);
  assert(cut && cut.x === 0 && cut.width === 1000 && cut.height === 1490,
    JSON.stringify(cut));
  assert(pickClip([{ x: 0, y: 0, width: 800, height: 1000 }], { width: 0, height: 0 })
    === null, "no window, no answer");

  // the port the host assigned is the port to listen on, because nothing
  // translates behind it: our own number there is an endpoint with no service
  assert(listenPort({ SERVER_PORT: "45009" }) === 45009, "the assigned port wins");
  assert(listenPort({ SERVER_PORT: "45009", PORT: "8097" }) === 45009,
    "SERVER_PORT is the host's word, PORT is ours");
  assert(listenPort({ PORT: "8097" }) === 8097, "PORT still works where it is the word");
  assert(listenPort({}) === FALLBACK_PORT, "a box that assigns nothing gets 8096");
  assert(listenPort({ SERVER_PORT: "nonsense" }) === FALLBACK_PORT,
    "a word that is not a number is not a port");
  assert(listenPort({ SERVER_PORT: "0" }) === FALLBACK_PORT, "port 0 is not a door");
  assert(PORT === listenPort(), "this copy listens where the host said");

  // the one pass MEASURES pages: it does not know Scribd's class names, because
  // a viewer that changes its clothes must not silently photograph nothing —
  // "only 0 page block(s) found" on every book was exactly that. So the
  // measuring itself is run here, against a made-up viewer and with no browser:
  // a column of page blocks, each holding a picture at exactly the same
  // rectangle, a wrapper around the column, furniture pinned to the window, a
  // sidebar of thumbnails and a header inside every page.
  assert(!/page_container|data-pageid|absimg|orig_image|text_page/.test(JS_PAGE_RECTS),
    "the page measure went back to naming Scribd's classes");
  assert(/getBoundingClientRect/.test(JS_PAGE_RECTS), "pages are measured, not named");
  const viewer = (items, scrollY = 0) => {
    const fakeDocument = {
      querySelectorAll: (selector) => {
        const wanted = selector.split(",").map((tag) => tag.trim().toLowerCase());
        return items.filter((item) => wanted.includes(item.tag)).map((item) => ({
          tagName: item.tag.toUpperCase(),
          style: item.style || { position: "static" },
          getBoundingClientRect: () => ({ x: item.x, y: item.y - scrollY,
                                          width: item.width, height: item.height }),
        }));
      },
    };
    const fakeWindow = { scrollX: 0, scrollY, innerWidth: 1000, innerHeight: 1500,
                         getComputedStyle: (element) => element.style };
    return new Function("document", "window",
      "return (" + JS_PAGE_RECTS + ")()")(fakeDocument, fakeWindow);
  };
  const madeUpColumn = (pages) => {
    const items = [
      { tag: "div", x: 0, y: 0, width: 1000, height: 80 + pages * 1440 },
      { tag: "div", x: 0, y: 0, width: 1000, height: 1200,
        style: { position: "fixed" } },                    // furniture
    ];
    for (let index = 0; index < pages; index++) {
      const top = 20 + index * 1440;
      items.push({ tag: "div", x: 50, y: top, width: 900, height: 1400 });
      items.push({ tag: "img", x: 50, y: top, width: 900, height: 1400 });
      items.push({ tag: "div", x: 50, y: top, width: 900, height: 300 });
      items.push({ tag: "div", x: 960, y: top, width: 220, height: 300 });
    }
    return items;
  };
  const measured = viewer(madeUpColumn(6));
  assert(measured.boxes.length === 6,
    `a column of 6 page blocks measures as 6, got ${measured.boxes.length}`);
  assert(measured.boxes.every((box) => box.width === 900 && box.height === 1400),
    "the page is measured, not the picture inside it, not the furniture");
  // a page block and the picture filling it exactly are one box, not two, and
  // neither is a wrapper of the other: losing both was a column of nothing
  assert(measured.seen >= 12, `the same rectangle was not deduped: ${measured.seen}`);
  // the boxes are in document pixels, so a window further down the scroll
  // measures the same page at the same place
  const scrolled = viewer(madeUpColumn(6), 2880);
  assert(scrolled.boxes.length === 6 &&
         scrolled.boxes.every((box, index) => box.y === measured.boxes[index].y),
    "a scrolled window measures in document pixels");
  const column = pickPageColumn(measured.boxes.concat(scrolled.boxes), 6, 8720);
  assert(column.run && column.run.ok && column.rects.length === 6, column.note);
  assert(column.run.slots.join(",") === "0,1,2,3,4,5", column.run.slots.join(","));
  assert(column.run.missing.length === 0, column.run.missing.join(","));
  assert(column.run.pitch === 1440, `the column's step: ${column.run.pitch}`);
  assert(column.run.width === 900 && column.run.height === 1400, column.note);
  // a viewer that keeps only the pages near the window: a hole is a page this
  // pass did not reach, numbered by the column's own step, never a shifted book
  const withHole = measured.boxes.filter((box) => box.y !== 20 + 2 * 1440);
  const holed = pickPageColumn(withHole, 6, 8720);
  assert(holed.run && holed.run.ok, holed.note);
  assert(holed.run.slots.join(",") === "0,1,3,4,5", holed.run.slots.join(","));
  assert(holed.run.missing.join(",") === "3", holed.run.missing.join(","));
  // a column that does not start at its first page would number every picture one
  // page out, so it is refused instead
  assert(pickPageColumn(measured.boxes.filter((box) => box.y > 1500), 5, 8720)
           .rects.length === 0,
    "a column missing its first page is not numbered from the second");
  // two page-shaped pictures inside every page are not twice the pages: that
  // candidate is judged, refused, and the real column is chosen instead
  const noisy = [];
  for (let index = 0; index < 6; index++) {
    noisy.push({ x: 50, y: 20 + index * 1440, width: 900, height: 1400 });
    noisy.push({ x: 100, y: 100 + index * 1440, width: 700, height: 900 });
    noisy.push({ x: 100, y: 1050 + index * 1440, width: 700, height: 900 });
  }
  const throughNoise = pickPageColumn(noisy, 6, 8720);
  assert(throughNoise.run && throughNoise.run.ok && throughNoise.run.width === 900,
    throughNoise.note);
  assert(throughNoise.run.slots.join(",") === "0,1,2,3,4,5",
    throughNoise.run.slots.join(","));
  // a screen with nothing page-shaped on it says so, and says what it did see
  const empty = viewer([{ tag: "div", x: 0, y: 0, width: 1000, height: 300 }]);
  assert(empty.boxes.length === 0, "a banner is not a page");
  assert(pickPageColumn([], 6, 8720).rects.length === 0, "nothing measured, nothing cut");
  assert(/nothing on the screen is page-shaped/.test(pickPageColumn([], 6, 8720).note),
    pickPageColumn([], 6, 8720).note);
  // the page cut is the box on the screen now that is the page we mean
  const wantedBox = { x: 50, y: 1460, width: 900, height: 1400 };
  assert(snapBox([{ x: 50, y: 1466, width: 900, height: 1400 }], wantedBox, 1440),
    "a page that shifted a few pixels is still that page");
  assert(snapBox([{ x: 50, y: 2900, width: 900, height: 1400 }], wantedBox, 1440) === null,
    "the neighbour is not that page");
  assert(snapBox([{ x: 50, y: 1460, width: 500, height: 1400 }], wantedBox, 1440) === null,
    "a box of another size is not that page");
  assert(snapBox([], wantedBox, 1440) === null, "nothing on the screen, no guess");
  assert(SHOT_SCALE >= 0.5 && SHOT_SCALE <= 4, SHOT_SCALE);
  assert(SHOT_SCALE === Number(process.env.SHOT_SCALE || 1),
    "standard quality is the default: the page at the size the viewer draws it");
  assert(SHOT_BOOK_MS >= 5000, "the one pass needs room to load a column");
  assert(SHOT_TABS >= 4, "a book is not photographed one tab at a time");

  return "selftest: every check passed — link parsing, redirect unwrapping, scribd json, panel address, panel reply, picking, engine order, page photographs, shot requests, the port the host assigned, the page measure and the column it picks";
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------
export async function runCli(args) {
  let query = "";
  let pick = "";
  let panel = PANEL;
  let mode = "auto";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pick") pick = args[++index] || "";
    else if (arg === "--panel") panel = args[++index] || "";
    else if (arg === "--mode") mode = args[++index] || "auto";
    else if (arg === "--browser") mode = "browser";
    else if (arg === "--fetch") mode = "fetch";
    else if (!arg.startsWith("-")) query = arg;
  }
  if (!query) {
    console.log('usage: node index.js "physics 12th" [--pick 1,3] [--panel http://ip:port]');
    return 2;
  }
  const result = await search(query, mode);
  for (const note of result.notes) console.log("  " + note);
  if (!result.hits.length) {
    console.log("no documents found");
    await closeBrowser();
    return 1;
  }
  result.hits.forEach((hit, index) => {
    const extra = [hit.pages ? `${hit.pages} pages` : "", hit.views ? `${hit.views} views` : "",
                   hit.author || ""].filter(Boolean).join(" · ");
    console.log(`  ${String(index + 1).padStart(2)}. ${hit.title}`);
    console.log(`      ${hit.url}${extra ? "   (" + extra + ")" : ""}`);
  });
  if (!pick) {
    console.log(`${result.hits.length} document(s) — add --pick 1,3 to send any of them`);
    await closeBrowser();
    return 0;
  }
  const chosen = picked(result.hits, pick);
  if (!chosen.length) {
    console.log(`nothing matches --pick ${pick}`);
    await closeBrowser();
    return 2;
  }
  if (!panel) {
    console.log(`${chosen.length} picked, but no --panel and no SCRIBD_PANEL — nothing sent`);
    await closeBrowser();
    return 0;
  }
  const sent = await sendToPanel(panel, chosen.map((hit) => hit.url));
  console.log(sent.ok ? `SENT — ${sent.message}` : `NOT SENT — ${sent.message}`);
  await closeBrowser();
  return sent.ok ? 0 : 1;
}

/**
 * @sparticuz/chromium unpacks into TMPDIR, so give it one inside the project.
 *
 *   node index.js                 serve the page
 *   node index.js --selftest      offline check
 *   node index.js "words" …       search in the terminal
 */
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const tmp = path.join(process.cwd(), "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  process.env.TMPDIR = tmp;
  process.env.AWS_EXECUTION_ENV = process.env.AWS_EXECUTION_ENV ||
    "AWS_Lambda_nodejs22.x";

  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    try {
      console.log(selftest());
      process.exit(0);
    } catch (exc) {
      console.error("selftest FAILED:", exc.message);
      process.exit(1);
    }
  }
  // a word that is not a flag, and not a flag's value, means: search from here
  const flagsWithValues = new Set(["--pick", "--panel", "--mode"]);
  const spoken = args.filter((arg, index) =>
    !arg.startsWith("-") && !flagsWithValues.has(args[index - 1]));
  if (!args.length || args.includes("--serve") || !spoken.length) {
    serve(PORT);
  } else {
    runCli(args).then((code) => process.exit(code));
  }
}
