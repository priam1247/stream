/**
 * troy-search runtime — every production function in one module.
 * index.js is the thin entry point; selftest.js holds the offline checks.
 */
import http from "node:http";

/**
 * troy-search — find Scribd documents from the JS box, send the links to the
 * download panel. Consolidated in core.js. Depends only on what you already have:
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

export const VERSION = "3.0";
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
export const ASSIGNED_PORT = listenPort();
export const PORT = ASSIGNED_PORT;
// The download panel this box sends links to, written down rather than wired:
// SCRIBD_PANEL still wins when it is set, and the page still lets you type a
// different one — but a fresh restart now works with nothing configured.
export const DEFAULT_PANEL = "http://195.123.189.187:25811";
export const PANEL = (process.env.SCRIBD_PANEL || "").trim() || DEFAULT_PANEL;
// The fallback only. A version written into this file is a version that goes
// stale: Chrome/126 was current in mid-2024, and the browser this service
// actually runs is dozens of versions past it. What makes that worse than old is
// that it is inconsistent — Chrome sends Sec-CH-UA client hints naming its own
// real version on every request, so a header claiming 126 next to hints naming
// something else is a shape no real browser has, and a bot check does not have
// to be clever to notice it. liveUA() below asks the browser instead.
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * -> what this browser says it is, with "Headless" taken out of it.
 *
 * The version is the browser's own, so the header and the client hints it sends
 * by itself agree, and nothing here has to be bumped by hand ever again. A
 * browser that will not answer, or an answer that is not a Chrome, falls back to
 * the constant above: a stale but consistent header beats no header.
 */
export function liveUA(browserUA) {
  const text = String(browserUA || "").trim();
  if (!/Chrome\/\d+/.test(text)) return UA;
  return text.replace(/HeadlessChrome/g, "Chrome").replace(/Headless/g, "");
}
/**
 * -> where this visit says it came from, or "" when it came from nowhere we
 * should claim.
 *
 * A real reader arrives at the embed FROM the document's own page, and at that
 * page from scribd.com, so both requests carry a Referer. Ours arrived from
 * nowhere at all, which is another shape no browser has. Somewhere else's site
 * gets no scribd referer, because that would be a lie in the other direction.
 */
export function refererFor(target, doc) {
  const url = String(target || "");
  if (!/^https?:\/\/([^\/?#]*\.)?scribd\.com\//i.test(url)) return "";
  const ident = String(doc || "").replace(/[^0-9]/g, "");
  if (/\/embeds\//.test(url) && ident) {
    return `https://www.scribd.com/document/${ident}`;
  }
  return "https://www.scribd.com/";
}

/**
 * Make an await on the browser mortal.
 *
 * A budget that is only checked at the top of a loop is not a budget: one await
 * inside the loop that never settles — a measure on a page that has stopped
 * answering, a screenshot on a renderer that will not paint — and the loop
 * never reaches its next check again. A run sat at `page 0/20 · 0 ok` for nine
 * minutes exactly like that. Every await on the browser inside a measuring or
 * cutting pass goes through here, so "this pass gets half a minute" means half
 * a minute. The browser work is not cancelled, only abandoned: the window it
 * was happening in is closed in the pass's finally.
 */
export function within(promise, ms, what) {
  let timer = null;
  const bail = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${what} was still running after ${ms}ms — the browser stopped answering, ` +
      `so this pass gives up on it instead of waiting forever`)), ms);
  });
  return Promise.race([promise, bail]).finally(() => clearTimeout(timer));
}

/** How to load a page: what to wait for, how long, and where we came from. */
export function navOptions(target, doc, timeoutMs = 45000) {
  const options = { waitUntil: "domcontentloaded", timeout: timeoutMs };
  const referer = refererFor(target, doc);
  if (referer) options.referer = referer;
  return options;
}
export const MAX_SEND = 40;

// the same pattern the panel accepts, so nothing we send can be rejected there
export const DOC_LINK =
  /https?:\/\/(?:[a-z0-9-]+\.)*scribd\.com\/(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)\/\d{3,}(?:\/[^\s"'<>]*)?/gi;
export const DOC_ID = /\/(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)\/(\d+)/i;

// ---------------------------------------------------------------------------
// finding links — shared by both modes, so both are judged by one rule
// ---------------------------------------------------------------------------
// a page of writing costs hundreds of bytes per row of png; a sheet with nothing
// drawn on it costs a handful. Same rule the download panel uses.
export const BLANK_BYTES_PER_ROW = 12;

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

export async function fetchText(url, timeoutMs = 25000) {
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

let askedUA = "";

/** The user agent to browse with, asked of the browser once and remembered. */
export async function userAgentOf(browser) {
  if (!askedUA) {
    try {
      askedUA = liveUA(await browser.userAgent());
    } catch {
      askedUA = UA;
    }
  }
  return askedUA || UA;
}

// ---------------------------------------------------------------------------
// the browser — only when plain http was not enough
// ---------------------------------------------------------------------------
let browserPromise = null;

export async function getBrowser() {
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
    const browser = await within(getBrowser(), 60000, "the browser starting");
    tab = await within(browser.newPage(), 30000, "opening a window");
    await within(tab.setViewport({ width: 40, height: 40, deviceScaleFactor: 1 }),
                 10000, "sizing the window");
    await tab.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 30000 });
    const png = await within(tab.screenshot({ type: "png", timeout: 30000 }),
                             35000, "photographing a blank window");
    const size = pngSize(png);
    return { launched: true, ms: Date.now() - started, bytes: png.length,
             width: size.width, height: size.height,
             version: typeof browser.version === "function"
               ? await browser.version() : "",
             note: "" };
  } catch (exc) {
    return { launched: false, ms: Date.now() - started, bytes: 0, width: 0, height: 0,
             version: "", note: String((exc && exc.message) || exc).slice(0, 400) };
  } finally {
    if (tab) await within(tab.close(), 5000, "closing a window")
      .catch(() => {});
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

/** A tab found the browser gone; do not keep handing out the dead promise. */
export function forgetBrowser() {
  browserPromise = null;
}


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

export function strip(html) {
  return htmlDecode(String(html || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function htmlDecode(text) {
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
      await page.setUserAgent(await userAgentOf(browser));
      const answers = [];
      page.on("response", (response) => {
        const type = response.request().resourceType();
        if (type === "document") answers.push(response.status());
      });
      const target = engine.url(query);
      await page.goto(target, navOptions(target, ""));
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
        forgetBrowser();
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
// the page
// ---------------------------------------------------------------------------
const CONFIG = JSON.stringify({ panel: PANEL }).replace(/</g, "\\u003c");
export const PAGE = `<!doctype html>
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
export const SHOT_WIDTH = Number(process.env.SHOT_WIDTH || 1000);
// deliberately taller than A4: the viewer can put furniture above the page, and
// a window with room to spare means the page itself is never the thing cut off
export const SHOT_HEIGHT = Number(process.env.SHOT_HEIGHT || 1500);
// 1x is standard quality: the page at the size the viewer draws it. 2x was the
// same page at twice the detail — four times the pixels to draw, encode, send
// and embed, for a sheet that is placed at the same size in the PDF anyway.
export const SHOT_SCALE = Number(process.env.SHOT_SCALE || 1);
export const SHOT_WAIT_MS = Number(process.env.SHOT_WAIT_MS || 8000);
export const SHOT_TABS = Number(process.env.SHOT_TABS || 8);
export function shotUrl(doc, page) {
  const ident = String(doc || "").replace(/[^0-9]/g, "");
  return `https://www.scribd.com/embeds/${ident}/content` +
    `?start_page=${Number(page) || 1}&view_mode=scroll`;
}


/**
 * Which rectangle on the screen is this page — and when the honest answer is
 * "none of them".
 *
 * The rules are the ones a bleed taught. A box that starts above the window
 * would lose the page's top; a box the window clips would lose its bottom; two
 * page blocks in one window mean the page cannot be separated from its
 * neighbour; and a box covering the window is the viewer, not a page. Each of
 * those is a REFUSAL, because the alternative — photographing the window
 * anyway — is exactly how the next page's header ended up at the bottom of the
 * previous sheet in a finished book. Nothing here assumes a page's size,
 * proportion or orientation: the box is measured, returned unclamped, and the
 * capture is later checked against exactly this box in exactly these units.
 * -> { box, why }: a box to clip, or the reason there is none.
 */
export function pickPageBox(boxes, viewport) {
  const view = { width: Number(viewport && viewport.width) || 0,
                 height: Number(viewport && viewport.height) || 0 };
  if (!(view.width > 0) || !(view.height > 0)) {
    return { box: null, why: "the window has no size to measure against" };
  }
  const blocks = (Array.isArray(boxes) ? boxes : [])
    .filter((b) => b && b.width >= 200 && b.height >= 200);
  if (!blocks.length) {
    return { box: null, why: "nothing on the screen is a page block" };
  }
  // the viewer itself is a block the size of the window, in both axes; a page
  // is allowed to be any other size, taller or wider than the window included
  const isWindow = (b) => b.width >= view.width * 0.97 &&
                          b.height >= view.height * 0.97 &&
                          b.width <= view.width * 1.03 &&
                          b.height <= view.height * 1.03;
  const pages = blocks.filter((b) => !isWindow(b));
  if (!pages.length) {
    return { box: null,
             why: "the only page-shaped block is the size of the window — that " +
                  "is the viewer, not a page, and photographing it would put " +
                  "the next page's top at this page's bottom" };
  }
  // the page this window was opened for is the first block of the column
  const first = pages.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0];
  if (first.height > view.height * 3) {
    return { box: null,
             why: `the first page block is ${Math.round(first.height)}px tall in ` +
                  `a ${view.height}px window — more than three windows of page, ` +
                  `which is a column of pages, not one page` };
  }
  if (first.y < -1) {
    return { box: null,
             why: `the page starts ${Math.round(-first.y)}px above the window ` +
                  `— clipping it would cut the page's own top off` };
  }
  // a second page block reaching into this page's span means two pages share
  // the window, and no clip separates them honestly. A box INSIDE the first
  // one is a layer of the same page, not a neighbour.
  const intruder = pages.find((b) => b !== first &&
    b.y < first.y + first.height - 1 && b.y + b.height > first.y + 1 &&
    !(b.x >= first.x - 1 && b.y >= first.y - 1 &&
      b.x + b.width <= first.x + first.width + 1 &&
      b.y + b.height <= first.y + first.height + 1));
  if (intruder) {
    return { box: null,
             why: `two page blocks share this window (${Math.round(first.height)}px ` +
                  `and ${Math.round(intruder.height)}px tall, overlapping) — ` +
                  `this page cannot be isolated from its neighbour` };
  }
  return { box: { x: Math.round(first.x), y: Math.round(first.y),
                  width: Math.round(first.width), height: Math.round(first.height) },
           why: "" };
}

/** Every rectangle on the screen that could be a page, as the browser sees it. */
/**
 * The page's own bounds in this window, measured with the same indexed
 * geometry the column once used: dedupe on a grid, wrappers removed on a
 * sorted scan. -> { box, why } from pickPageBox.
 */
export async function measurePage(tab, viewport) {
  const found = await within(tab.evaluate(JS_PAGE_RECTS), 15000,
                             "measuring the window").catch(() => null);
  return pickPageBox(found && found.boxes, viewport);
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


let shotRunning = 0;
const shotWaiting = [];

/** At most SHOT_TABS tabs at once: a small box runs out of memory before that. */
export function shotSlot(max = SHOT_TABS) {
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
/**
 * One page, one window, one photograph of exactly that page — the only capture
 * method this service has.
 *
 * The window is opened at the page's own address, the page's bounds are
 * measured in it, and the clip is exactly those bounds: a capture can neither
 * lose the page's own edges nor carry its neighbour's, because nothing outside
 * the measured box is ever photographed. Everything questionable is a failure
 * with a reason, never a picture — no page box, a box the window cuts, two
 * pages sharing a window, a capture whose size does not match the measured
 * box, or a sheet that comes back empty. A doubt is retried once on the same
 * page with the same method and a longer wait; past that the page is reported
 * failed, and the panel names it in the book's record instead of hiding it.
 */
export async function shootPage(doc, page, scale = SHOT_SCALE, waitMs = SHOT_WAIT_MS) {
  const ident = String(doc || "").replace(/[^0-9]/g, "");
  const number = Number(page);
  if (!/^\d{3,}$/.test(ident) || !(number >= 1)) {
    return { png: null, note: "a document id and a page number are needed" };
  }
  const viewport = { width: SHOT_WIDTH, height: SHOT_HEIGHT };
  const ratio = Math.max(0.5, Math.min(4, Number(scale) || SHOT_SCALE));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const release = await shotSlot();
  let tab = null;
  try {
    const browser = await within(getBrowser(), 60000, "the browser starting");
    tab = await within(browser.newPage(), 30000, "opening a window");
    await within(tab.setUserAgent(await within(userAgentOf(browser), 10000,
                                               "asking the browser's name")),
                 10000, "naming the window").catch(() => {});
    await within(tab.setViewport({ width: viewport.width,
                                   height: viewport.height,
                                   deviceScaleFactor: ratio }),
                 10000, "sizing the window").catch(() => {});
    const single = shotUrl(ident, number);
    let why = "nothing on the screen was a page block";
    for (const patience of [Number(waitMs) || SHOT_WAIT_MS,
                            (Number(waitMs) || SHOT_WAIT_MS) * 2]) {
      await tab.goto(single, navOptions(single, ident));
      let found = null;
      const deadline = Date.now() + patience;
      do {
        found = await measurePage(tab, viewport);
        if (found.box) break;
        await sleep(250);
      } while (Date.now() < deadline);
      if (!found.box) { why = found.why; continue; }   // reload, wait longer
      let clip = found.box;
      const want = { width: Math.round(clip.width * ratio),
                     height: Math.round(clip.height * ratio) };
      let shot = await within(tab.screenshot({ type: "png", clip,
                              captureBeyondViewport: true, timeout: 30000 }),
                              35000, "photographing one page");
      let size = pngSize(shot);
      if (size.width !== want.width || size.height !== want.height) {
        // a capture that does not match the measured page was truncated,
        // scaled, or taken while the page was still moving: one retake of this
        // same page, same method, longer wait — then it is a failed page
        await sleep(Math.max(700, Math.round(patience / 4)));
        const again = await measurePage(tab, viewport);
        if (!again.box) { why = again.why; continue; }
        shot = await within(tab.screenshot({ type: "png", clip: again.box,
                            captureBeyondViewport: true, timeout: 30000 }),
                            35000, "photographing one page again");
        size = pngSize(shot);
        const want2 = { width: Math.round(again.box.width * ratio),
                        height: Math.round(again.box.height * ratio) };
        if (size.width !== want2.width || size.height !== want2.height) {
          return { png: null,
                   note: `page ${number}: the capture came back ` +
                         `${size.width}x${size.height} against a measured page ` +
                         `of ${want2.width}x${want2.height} — a picture that is ` +
                         `not the page's own size is failed, not shipped` };
        }
        // the retake used a new box, so X-Shot-Box must describe THAT box —
        // the panel checks the png's pixels against the header it is given
        clip = again.box;
      }
      if (blankShot(shot)) {
        why = `the sheet came back empty (${size.width}x${size.height})`;
        continue;                    // same page, same method, longer wait
      }
      return { png: shot, box: clip,
               note: `page ${number}: ${size.width}x${size.height} png, clipped ` +
                     `to the page's own measured box ${clip.width}x${clip.height} ` +
                     `in a window holding that page alone, at ${ratio}x` };
    }
    return { png: null,
             note: `page ${number}: ${why} — failed after a longer wait on the ` +
                   `same page, and named` };
  } catch (exc) {
    const message = String((exc && exc.message) || exc).slice(0, 200);
    return { png: null, note: `page ${number}: the browser failed — ${message}` };
  } finally {
    if (tab) await within(tab.close(), 5000, "closing a window")
      .catch(() => {});
    release();
  }
}

export const JS_PAGE_RECTS = () => {
  const view = { width: window.innerWidth || 0, height: window.innerHeight || 0 };
  if (!(view.width > 0) || !(view.height > 0)) return { boxes: [], seen: 0 };
  const sx = window.scrollX || 0, sy = window.scrollY || 0;
  const seen = [];
  const tags = 'img, canvas, div, section, article, main, li, figure';
  for (const el of document.querySelectorAll(tags)) {
    const r = el.getBoundingClientRect();
    if (!(r.width >= 200) || !(r.height >= 200)) continue;
    if (!(r.width >= view.width * 0.4) || !(r.height >= view.height * 0.2)) continue;
    const tall = r.height / r.width;
    if (!(tall >= 1.1) || !(tall <= 1.8)) continue;
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.position === 'fixed' || style.position === 'sticky')) continue;
    // whole pixels, so the same block met at two windows is the same box
    seen.push({ x: Math.round(r.x + sx), y: Math.round(r.y + sy),
                width: Math.round(r.width), height: Math.round(r.height) });
  }
  // one page met twice — the page block and the picture filling it exactly — is
  // one box, not two, and neither of them is a wrapper around the other
  const boxes = [];
  // A 2px grid in x/y narrows each comparison to neighbouring cells. The
  // original four <=1px checks remain authoritative, and insertion order still
  // decides which representative survives a fuzzy match.
  const cellSize = 2, spatial = new Map();
  for (const r of seen) {
    const cx = Math.floor(r.x / cellSize), cy = Math.floor(r.y / cellSize);
    let duplicate = false;
    for (let dx = -1; dx <= 1 && !duplicate; dx++) {
      for (let dy = -1; dy <= 1 && !duplicate; dy++) {
        const nearby = spatial.get((cx + dx) + "," + (cy + dy)) || [];
        duplicate = nearby.some((b) => Math.abs(b.x - r.x) <= 1 &&
          Math.abs(b.y - r.y) <= 1 && Math.abs(b.width - r.width) <= 1 &&
          Math.abs(b.height - r.height) <= 1);
      }
    }
    if (!duplicate) {
      boxes.push(r);
      const key = cx + "," + cy;
      if (!spatial.has(key)) spatial.set(key, []);
      spatial.get(key).push(r);
    }
  }
  // a box that holds another by more than a hair is furniture around a page
  const holds = (a, b) => b.x >= a.x - 1 && b.y >= a.y - 1 &&
    b.x + b.width <= a.x + a.width + 1 &&
    b.y + b.height <= a.y + a.height + 1 &&
    a.width * a.height > b.width * b.height * 1.05;
  // A held box must start within this page's vertical interval. Sorting once
  // lets each page inspect only plausible contained boxes instead of scanning
  // every page-shaped rectangle in the document.
  const byY = boxes.slice().sort((a, b) => a.y - b.y);
  const lowerBound = (y) => {
    let low = 0, high = byY.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (byY[mid].y < y) low = mid + 1; else high = mid;
    }
    return low;
  };
  const kept = [];
  for (const a of boxes) {
    let contained = false;
    for (let i = lowerBound(a.y - 1);
         i < byY.length && byY[i].y <= a.y + a.height + 1; i++) {
      const b = byY[i];
      if (b !== a && holds(a, b)) { contained = true; break; }
    }
    if (!contained) kept.push(a);
  }
  return { boxes: kept, seen: seen.length };
};

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
          // the box this picture claims to be, in the page's own units: the
          // panel checks the pixels against it, because a picture that is not
          // the size of its page is a picture of something else
          "X-Shot-Box": got.box ? `${got.box.width}x${got.box.height}` : "",
        });
        return response.end(got.png);
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
                (process.env.SCRIBD_PANEL ? " (SCRIBD_PANEL)" : " (written into config.js)"));
  });
  return server;
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
