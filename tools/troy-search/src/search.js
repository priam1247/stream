import { DOC_ID, MAX_SEND, navOptions } from "./config.js";
import { refusal, fetchText } from "./network.js";
import { documentLinks, parseAnchors, unwrap, strip, parseScribdJson } from "./links.js";
import { getBrowser, forgetBrowser, userAgentOf } from "./browser.js";

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
