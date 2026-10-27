import { within, navOptions } from "./config.js";
import { getBrowser, userAgentOf } from "./browser.js";
import { pngSize, blankShot } from "./png.js";

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
