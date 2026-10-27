/**
 * troy-search — find Scribd documents from the JS box, send the links to the
 * download panel. Split into ./src/. Depends only on what you already have:
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
