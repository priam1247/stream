/**
 * troy-search entry point. The runtime lives in ./core.js and the offline
 * checks in ./selftest.js — three files total. This file only re-exports the
 * public API and starts the server / CLI / selftest.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PORT, serve, runCli } from "./core.js";
import { selftest } from "./selftest.js";

export * from "./core.js";
export { selftest } from "./selftest.js";

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
