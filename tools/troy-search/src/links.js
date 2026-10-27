import { DOC_LINK, DOC_ID, MAX_SEND } from "./config.js";
import { fetchText } from "./network.js";


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
