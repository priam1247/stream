import { liveUA, UA, within } from "./config.js";
import { pngSize } from "./png.js";

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
