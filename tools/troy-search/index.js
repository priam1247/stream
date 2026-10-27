/**
 * troy-search entry point. The implementation is split by responsibility under
 * ./src/ — see ./src/MAP.md. This file only re-exports the public API and runs
 * the server / CLI / selftest.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PORT } from "./src/config.js";
import { serve } from "./src/http.js";
import { selftest } from "./src/selftest.js";
import { runCli } from "./src/cli.js";

export { VERSION, FALLBACK_PORT, listenPort, ASSIGNED_PORT, PORT, DEFAULT_PANEL, PANEL, UA, liveUA, refererFor, within, navOptions, MAX_SEND, DOC_LINK, DOC_ID } from "./src/config.js";
export { BLANK_BYTES_PER_ROW, pngSize, blankShot } from "./src/png.js";
export { refusal, fetchText } from "./src/network.js";
export { userAgentOf, getBrowser, closeBrowser, launchProof, browserStatus, forgetBrowser } from "./src/browser.js";
export { documentLinks, parseAnchors, unwrap, strip, htmlDecode, parseScribdJson, panelOrigin, headline, sendToPanel, picked } from "./src/links.js";
export { ENGINES, engineOrder, searchWithFetch, searchWithBrowser, search } from "./src/search.js";
export { SHOT_WIDTH, SHOT_HEIGHT, SHOT_SCALE, SHOT_WAIT_MS, SHOT_TABS, shotUrl, pickPageBox, measurePage, shotAsk, shotSlot, shootPage, JS_PAGE_RECTS } from "./src/shots.js";
export { PAGE } from "./src/page.js";
export { serve } from "./src/http.js";
export { selftest } from "./src/selftest.js";
export { runCli } from "./src/cli.js";

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
      console.log(await selftest());
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
