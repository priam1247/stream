import { PANEL } from "./config.js";
import { search } from "./search.js";
import { picked, sendToPanel } from "./links.js";
import { closeBrowser } from "./browser.js";

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
