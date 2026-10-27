import http from "node:http";
import { VERSION, PORT, ASSIGNED_PORT, FALLBACK_PORT, PANEL, MAX_SEND } from "./config.js";
import { PAGE } from "./page.js";
import { search, ENGINES } from "./search.js";
import { sendToPanel, panelOrigin } from "./links.js";
import { refusal, fetchText } from "./network.js";
import { browserStatus, launchProof } from "./browser.js";
import { shotAsk, shootPage } from "./shots.js";

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
