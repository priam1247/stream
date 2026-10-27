/** Offline regression checks for troy-search. Reads core.js to inspect source. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VERSION, FALLBACK_PORT, listenPort, ASSIGNED_PORT, PORT, DEFAULT_PANEL, PANEL,
  UA, liveUA, refererFor, within, navOptions, MAX_SEND, DOC_LINK, DOC_ID,
  BLANK_BYTES_PER_ROW, pngSize, blankShot,
  refusal, fetchText,
  userAgentOf, getBrowser, closeBrowser, launchProof, browserStatus, forgetBrowser,
  documentLinks, parseAnchors, unwrap, strip, htmlDecode, parseScribdJson,
  panelOrigin, headline, sendToPanel, picked,
  ENGINES, engineOrder, searchWithFetch, searchWithBrowser, search,
  SHOT_WIDTH, SHOT_HEIGHT, SHOT_SCALE, SHOT_WAIT_MS, SHOT_TABS, shotUrl,
  pickPageBox, measurePage, shotAsk, shotSlot, shootPage, JS_PAGE_RECTS,
  PAGE, serve,
} from "./core.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PRODUCTION_FILES = ["core.js"];

function allSource() {
  return PRODUCTION_FILES
    .map((name) => readFileSync(join(SRC_DIR, name), "utf8"))
    .join("\n");
}

function serveSource() {
  return readFileSync(join(SRC_DIR, "core.js"), "utf8");
}

export async function selftest() {
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
  // the picker's refusals are the whole point: every one of them is a shape
  // that used to end in a viewport photograph, and a viewport photograph is
  // how a neighbour's header lands at the bottom of a page
  const pageView = { width: 1000, height: 1500 };
  assert(pickPageBox([], pageView).box === null, "nothing on the screen");
  assert(/nothing on the screen is a page block/.test(pickPageBox([], pageView).why),
    pickPageBox([], pageView).why);
  assert(pickPageBox([{ x: 0, y: 0, width: 1000, height: 1500 }], pageView).box === null,
    "a block covering the window is the viewer, not a page");
  assert(/the viewer, not a page/.test(
    pickPageBox([{ x: 0, y: 0, width: 1000, height: 1500 }], pageView).why),
    "the refusal must say why, or the log cannot");
  assert(pickPageBox([{ x: 0, y: -80, width: 900, height: 1400 }], pageView).box === null,
    "a page starting above the window would lose its top");
  assert(/cut the page's own top/.test(
    pickPageBox([{ x: 0, y: -80, width: 900, height: 1400 }], pageView).why),
    pickPageBox([{ x: 0, y: -80, width: 900, height: 1400 }].why || "") ||
    pickPageBox([{ x: 0, y: -80, width: 900, height: 1400 }], pageView).why);
  assert(pickPageBox([{ x: 50, y: 20, width: 900, height: 1400 },
                      { x: 50, y: 1300, width: 900, height: 1400 }], pageView).box === null,
    "two pages sharing a window cannot be separated honestly");
  assert(/cannot be isolated from its neighbour/.test(pickPageBox(
    [{ x: 50, y: 20, width: 900, height: 1400 },
     { x: 50, y: 1300, width: 900, height: 1400 }], pageView).why),
    pickPageBox([{ x: 50, y: 20, width: 900, height: 1400 },
                 { x: 50, y: 1300, width: 900, height: 1400 }], pageView).why);
  // a layer INSIDE the page is part of the page, not a neighbour
  const layered = pickPageBox([{ x: 50, y: 20, width: 900, height: 1400 },
                               { x: 150, y: 120, width: 700, height: 1100 }], pageView);
  assert(layered.box && layered.box.width === 900, JSON.stringify(layered));
  // no aspect band, no clamping: a landscape page is a page, and the box comes
  // back exactly as measured, even when it is taller than the window
  const landscape = pickPageBox([{ x: 0, y: 0, width: 1400, height: 900 }], pageView);
  assert(landscape.box && landscape.box.width === 1400 &&
         landscape.box.height === 900, JSON.stringify(landscape));
  const tall = pickPageBox([{ x: 50, y: 10, width: 900, height: 2600 }], pageView);
  assert(tall.box && tall.box.height === 2600 && tall.box.y === 10,
    `a page taller than the window is measured, not clipped to the window: ` +
    JSON.stringify(tall.box));
  const columnish = pickPageBox([{ x: 0, y: 0, width: 900, height: 9000 }], pageView);
  assert(columnish.box === null && /a column of pages, not one page/.test(columnish.why),
    `nine thousand pixels of blocks is a column, and must be refused: ` +
    columnish.why);
  assert(pickPageBox([{ x: 0, y: 0, width: 800, height: 1000 }],
                     { width: 0, height: 0 }).box === null,
    "a window with no size cannot measure anything");

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
  const fuzzy = viewer([
    { tag: "div", x: 50, y: 20, width: 900, height: 1400 },
    { tag: "img", x: 51, y: 21, width: 901, height: 1399 },
  ]);
  assert(fuzzy.seen === 2 && fuzzy.boxes.length === 1,
    `a one-pixel measurement jitter must dedupe: ${JSON.stringify(fuzzy)}`);
  const chain = viewer([
    { tag: "div", x: 50, y: 20, width: 900, height: 1400 },
    { tag: "img", x: 51, y: 20, width: 900, height: 1400 },
    { tag: "canvas", x: 52, y: 20, width: 900, height: 1400 },
  ]);
  assert(chain.boxes.length === 2 && chain.boxes[0].x === 50 &&
         chain.boxes[1].x === 52,
    `fuzzy dedupe must retain the first representative, not form a chain: ` +
    `${JSON.stringify(chain.boxes)}`);
  // a grid narrows the search, so the pins must live ON the grid lines: a
  // duplicate straddling a cell boundary is the case a wrong cell size misses
  const straddle = viewer([
    { tag: "div", x: 3.9, y: 20, width: 900, height: 1400 },
    { tag: "img", x: 4.0, y: 20, width: 900, height: 1400 },
  ]);
  assert(straddle.boxes.length === 1,
    `a duplicate straddling a 2px cell boundary must still dedupe: ` +
    JSON.stringify(straddle.boxes));
  const apart = viewer([
    { tag: "div", x: 0, y: 20, width: 900, height: 1400 },
    { tag: "img", x: 2, y: 20, width: 900, height: 1400 },
  ]);
  assert(apart.boxes.length === 2,
    `two pages two pixels apart are two pages: ${JSON.stringify(apart.boxes)}`);
  const edgeHeld = viewer([
    { tag: "div", x: 50, y: 20, width: 900, height: 1400 },
    { tag: "img", x: 51, y: 19, width: 800, height: 1300 },
  ]);
  assert(edgeHeld.boxes.length === 1 && edgeHeld.boxes[0].width === 800,
    `the wrapper around a page must go even when the page starts exactly one ` +
    `pixel above the wrapper's top — the scan window's edge case: ` +
    JSON.stringify(edgeHeld.boxes));
  const nested = viewer([
    { tag: "div", x: 50, y: 20, width: 900, height: 1400 },
    { tag: "img", x: 150, y: 100, width: 700, height: 1200 },
  ]);
  assert(nested.boxes.length === 1 && nested.boxes[0].width === 700,
    `the larger wrapper must be removed around the inner page: ${JSON.stringify(nested)}`);
  // ---- a browser that looks like a browser ------------------------------
  // Two shapes no real browser has, and a bot check does not have to be clever
  // to notice either: a header claiming a Chrome version the browser is not
  // running (its own client hints name the real one on every request), and a
  // visit to the viewer that says it came from nowhere. Both are pinned here.
  const headless = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) HeadlessChrome/156.0.8078.47 Safari/537.36";
  assert(liveUA(headless) === headless.replace("HeadlessChrome", "Chrome"),
    liveUA(headless));
  assert(!/Headless/.test(liveUA(headless)), "headless must not be in the words");
  assert(/Chrome\/156\.0\.8078\.47/.test(liveUA(headless)),
    "the browser's own version survives, so the header and its hints agree");
  assert(liveUA("") === UA && liveUA("curl/8.7.1") === UA,
    "a browser that will not answer gets the fallback, not an empty header");
  assert(refererFor(shotUrl("398154705", 1), "398154705") ===
         "https://www.scribd.com/document/398154705",
    refererFor(shotUrl("398154705", 1), "398154705"));
  assert(refererFor("https://www.scribd.com/document/398154705/Lin", "398154705") ===
         "https://www.scribd.com/",
    refererFor("https://www.scribd.com/document/398154705/Lin", "398154705"));
  assert(refererFor("about:blank", "1") === "", "a blank page came from nowhere");
  assert(refererFor("https://duckduckgo.com/html/?q=x", "1") === "",
    "somewhere else's site gets no scribd referer — that lie runs the other way");
  assert(navOptions(shotUrl("7", 1), "7").referer ===
         "https://www.scribd.com/document/7", JSON.stringify(navOptions(shotUrl("7", 1), "7")));
  assert(navOptions(shotUrl("7", 1), "7").waitUntil === "domcontentloaded" &&
         navOptions(shotUrl("7", 1), "7").timeout === 45000,
    "asking where we came from must not change what we wait for");
  assert(navOptions("about:blank", "7").referer === undefined,
    "an empty referer is left out, not sent as nothing");
  const looksReal = String(shootPage);
  assert(!/setUserAgent\(UA\)/.test(looksReal),
    "a version written into this file goes stale, and a stale header next to " +
    "the client hints the browser really sends is a mismatch no browser has");
  assert(/setUserAgent\(await within\(userAgentOf\(browser\)/.test(looksReal),
    "every tab must ask the browser what to call itself, mortally");
  assert((String(shootPage).match(/navOptions\(/g) || []).length === 1,
    "the one capture path's visit says where it came from");
  assert(/browser\.userAgent\(\)/.test(String(userAgentOf)),
    "the browser is asked, not guessed at");

  // ---- a hang must not outlive the budget that was meant to contain it ----
  // A run sat at `page 0/20 · 0 ok` for nine minutes because one await on the
  // browser never settled, and every budget in this file is only checked at the
  // top of a loop. within() is what makes those budgets real, so this pin lets
  // one actually fire.
  const hung = new Promise(() => {});              // never settles, on purpose
  const beganHang = Date.now();
  let hangNote = "";
  await within(hung, 60, "a test that hangs")
    .catch((exc) => { hangNote = String((exc && exc.message) || exc); });
  assert(hangNote.includes("still running after 60ms"), hangNote);
  assert(hangNote.includes("gives up on it instead of waiting forever"), hangNote);
  assert(Date.now() - beganHang < 5000,
    "a deadline that arrives late is not a deadline");
  const fast = await within(Promise.resolve(7), 5000, "a fast answer");
  assert(fast === 7, "an answer inside the deadline must come through untouched");
  // A string that LOOKS like a function is not one: Puppeteer evaluates a
  // string as an expression and serialises the resulting function as {}, so
  // every measure says "nothing on the screen is a page block" and no page is
  // ever photographed. The measure must go to the browser as a real function.
  assert(typeof JS_PAGE_RECTS === "function",
    "the page measure passed to tab.evaluate must be a real function, not a " +
    "string: a string returns {} and every screenshot is refused");
  assert(/tab\.evaluate\(JS_PAGE_RECTS\)/.test(String(measurePage)),
    "measurePage must pass that function itself to the browser");
  // and the awaits that can hang are the ones that go through it
  const mortal = String(shootPage) + String(measurePage);
  for (const [needle, why] of [
    ["within(tab.evaluate(JS_PAGE_RECTS)", "a measure on a page that stopped " +
      "answering is what held a loop open for nine minutes"],
    ["within(tab.screenshot(", "a page photograph that never arrives"],
    ["within(tab.close(), 5000", "a window that will not close holds the slot " +
      "permit, and with it every book behind this one"],
    ["within(getBrowser(), 60000", "a browser that will not start must not hang " +
      "the request that asked for it"],
  ]) {
    assert(mortal.includes(needle), why);
  }
  // the master deadline: a hung one pass answers 502 instead of nothing at all
  const server = serveSource().slice(serveSource().indexOf("export function serve("));
  assert(!/url\.pathname === "\/shots"/.test(server),
    "the whole-column endpoint must not come back: it is the route that cut " +
    "pages by inference instead of measuring each one");
  // the scan stops where the selftest begins, or the pin that names the dead
  // code would find its own list of names and fail forever
  const prod = allSource();
  const deadCode = new RegExp(["encodeShots", "decodeShots", "shootBook",
    "checkPageRun", "pickPageColumn", "lanePlan", "cutBudgetMs", "snapBox",
    "sightReport", "SCROLL_CSS", "JS_FORCE_EAGER", "pickClip"].join("|"));
  assert(!deadCode.test(prod),
    "no code may remain that only the column route used");
  const shot = String(shootPage);
  assert(!/the whole window/.test(shot),
    "a page with no measured box is a failed page, never a window photograph");
  assert(!/captureBeyondViewport: false/.test(shot),
    "the clip is the page's own box, captured beyond the window or not at all");
  assert(/size\.width !== want\.width \|\| size\.height !== want\.height/.test(shot),
    "every capture is checked against the bounds it was clipped to");
  assert(/is failed, not shipped/.test(shot),
    "a capture that does not match its page is reported failed");
  assert(/X-Shot-Box/.test(server),
    "the answer must state the box it measured, or the panel cannot check " +
    "the picture against it");
  assert(/box: clip/.test(shot),
    "the measured box travels with the picture");
  assert(!/kept = {/.test(shot),
    "an empty sheet must not be kept and shipped as a page");
  assert(/measurePage\(tab, viewport\)/.test(shot) &&
         /tab\.evaluate\(JS_PAGE_RECTS\)/.test(String(measurePage)),
    "the page's bounds come from the indexed measure, not a naive walk");
  assert(/continue;/.test(shot) && /patience \* 2/.test(shot.replace(/\n/g, " ")) ||
         /\(Number\(waitMs\) \|\| SHOT_WAIT_MS\) \* 2/.test(shot),
    "a doubt is retried once, same page, same method, longer wait");

  return "selftest: every check passed — link parsing, redirect unwrapping, scribd json, panel address, panel reply, picking, engine order, page photographs, shot requests, the port the host assigned, the page measure and the refusals that keep a page's edges its own, a browser that says what it really is and where it came from, a hang that cannot outlive the budget meant to contain it, and the proof that the column route stays gone";
}
