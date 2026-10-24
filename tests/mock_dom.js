/* Run scribd/pdfprint.py's browser scripts against a minimal fake DOM.
 *
 * Scribd cannot be reached from CI, so this exercises the *logic* of
 * ISOLATE_PAGE_JS / CLEANUP_JS instead: three .outer_page containers inside a
 * virtualised viewer, a toolbar/sidebar/cookie banner around them, inline
 * `width: 100%` styles on the pages (the thing that used to be parsed as
 * "100px" paper) and one page whose image is larger than its box.
 *
 * stdin:  {"isolate": "<js>", "cleanup": "<js>"}
 * exit 0: prints "ok";  exit 1: prints what went wrong.
 */
const fs = require("fs");

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const isolate = new Function("return (" + input.isolate + ")")();
const cleanup = new Function("return (" + input.cleanup + ")")();

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}
function eq(got, want, what) {
  check(got === want, `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

class Style {
  constructor(owner) {
    this.owner = owner;
    this._props = new Map();
  }
  _sync() {
    if (this._props.size) this.owner._attrs.set("style", this.cssText);
    else this.owner._attrs.delete("style");
  }
  setProperty(name, value) {
    this._props.set(name, String(value));
    this._sync();
  }
  removeProperty(name) {
    this._props.delete(name);
    this._sync();
  }
  getPropertyValue(name) {
    return this._props.has(name) ? this._props.get(name) : "";
  }
  get cssText() {
    return [...this._props.entries()].map(([k, v]) => `${k}: ${v};`).join(" ");
  }
  set cssText(text) {
    this._props = new Map();
    for (const part of String(text || "").split(";")) {
      const i = part.indexOf(":");
      if (i < 0) continue;
      const k = part.slice(0, i).trim().toLowerCase();
      const v = part.slice(i + 1).replace("!important", "").trim();
      if (k && v) this._props.set(k, v);
    }
    this._sync();
  }
  clear() {
    this._props = new Map();
    this.owner._attrs.delete("style");
  }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this._attrs = new Map();
    this._classes = [];
    this.style = new Style(this);
    this._rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    this._naturalRect = null;
    this._computed = { width: "", height: "" };
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.innerText = "";
    this._text = "";
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
  get className() {
    return this._classes.join(" ");
  }
  set className(v) {
    this._classes = String(v || "").split(/\s+/).filter(Boolean);
  }
  get id() {
    return this._attrs.get("id") || "";
  }
  set id(v) {
    this._attrs.set("id", String(v));
  }
  getAttribute(k) {
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  setAttribute(k, v) {
    if (k === "style") {
      this.style.cssText = v; // parses + writes the attribute
      return;
    }
    this._attrs.set(k, String(v));
  }
  removeAttribute(k) {
    this._attrs.delete(k);
    if (k === "style") this.style.clear();
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    const kids = this.parentElement.children;
    const i = kids.indexOf(this);
    if (i >= 0) kids.splice(i, 1);
    this.parentElement = null;
  }
  cloneNode(deep) {
    const copy = new El(this.tagName);
    for (const [k, v] of this._attrs) copy._attrs.set(k, v);
    copy._classes = this._classes.slice();
    copy.style._props = new Map(this.style._props);
    copy.style._sync();
    copy._computed = { ...this._computed };
    copy.offsetWidth = this.offsetWidth;
    copy.offsetHeight = this.offsetHeight;
    copy.innerText = this.innerText;
    copy._text = this._text;
    // A clone is rendered at the page's natural (unscaled) size.
    copy._rect = { ...(this._naturalRect || this._rect) };
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  getBoundingClientRect() {
    return { ...this._rect };
  }
  descendants(out = []) {
    for (const child of this.children) {
      out.push(child);
      child.descendants(out);
    }
    return out;
  }
  querySelectorAll(selector) {
    return this.descendants().filter((el) => matches(el, selector));
  }
}

function matches(el, selector) {
  return String(selector)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((part) => {
      const attr = part.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
      if (attr) {
        if (attr[2] === undefined) return el._attrs.has(attr[1]);
        return el.getAttribute(attr[1]) === attr[2];
      }
      const bits = part.split(".");
      const tag = bits.shift();
      const classes = bits;
      if (tag && tag !== "*" && el.tagName !== tag.toUpperCase()) return false;
      return classes.every((c) => el._classes.includes(c));
    });
}

// ---------------------------------------------------------------- the page
const html = new El("html");
const head = new El("head");
const body = new El("body");
html.appendChild(head);
html.appendChild(body);

const toolbar = new El("div");
toolbar._classes.push("toolbar_top");
body.appendChild(toolbar);
const sidebar = new El("div");
sidebar._classes.push("sidebar");
body.appendChild(sidebar);
const cookie = new El("div");
cookie._classes.push("cookie_banner");
body.appendChild(cookie);

const container = new El("div");
container._classes.push("document_container");
const scroller = new El("div");
scroller._classes.push("document_scroller");
container.appendChild(scroller);
body.appendChild(container);

// box px, and (for page 3) an image that is bigger than the page box
const SIZES = [
  { w: 1114, h: 1442, img: { w: 1114, h: 1442 } },
  { w: 1114, h: 1442, img: { w: 1114, h: 1442 } },
  { w: 800, h: 1200, img: { w: 900, h: 1300 } },
  // a wrapper with no box of its own: sized from its page image
  { w: 0, h: 0, img: { w: 1000, h: 1400 }, natural: true },
];

const pages = SIZES.map((spec, i) => {
  const page = new El("div");
  page._classes.push("outer_page");
  page.id = `outer_page_${i + 1}`;
  // Scribd stores percentages inline: parsing this must never set the paper.
  page.style.cssText = "width: 100%; height: 100%; top: 0px; left: 0px;";
  page._computed = { width: `${spec.w}px`, height: `${spec.h}px` };
  page.offsetWidth = spec.w;
  page.offsetHeight = spec.h;
  // The viewer scales pages with a CSS transform: the rendered rect is
  // smaller than the layout box.
  page._rect = {
    left: 37,
    top: 100 + i * 4000,
    width: spec.w * 0.7,
    height: spec.h * 0.7,
    right: 37 + spec.w * 0.7,
    bottom: 100 + i * 4000 + spec.h * 0.7,
  };
  page._naturalRect = { left: 0, top: 0, width: spec.w, height: spec.h, right: spec.w, bottom: spec.h };
  page.innerText = `page ${i + 1} text`;

  const img = new El("img");
  img._classes.push("absimg");
  img.setAttribute("src", `page-${i + 1}.jpg`);
  img._rect = { left: 0, top: 0, width: spec.img.w, height: spec.img.h, right: spec.img.w, bottom: spec.img.h };
  img.naturalWidth = spec.img.w;
  img.naturalHeight = spec.img.h;
  page.appendChild(img);

  scroller.appendChild(page);
  return page;
});

const document = {
  body,
  head,
  documentElement: html,
  createElement: (tag) => new El(tag),
  getElementById: (id) => html.descendants().find((el) => el.id === id) || null,
  querySelectorAll: (sel) => html.descendants().filter((el) => matches(el, sel)),
};

globalThis.document = document;
globalThis.window = globalThis;
globalThis.getComputedStyle = (el) => ({
  width: el._computed.width,
  height: el._computed.height,
});

const SELECTOR = "div.outer_page";

// ------------------------------------------------------------- page 1 (0)
const info = isolate({ selector: SELECTOR, index: 0 });
check(info, "isolate returned nothing");
if (info) {
  eq(info.width, 1114, "paper width (must be the page box, not '100%')");
  eq(info.height, 1442, "paper height");
  eq(info.pageWidth, 1118, "paper width + pad");
  eq(info.pageHeight, 1446, "paper height + pad");
  eq(info.runaway, 0, "runaway flag");
  eq(info.images, 1, "images in the clone");
}

const root = document.getElementById("scribd-printed-page-root");
check(root, "no print root was created");
if (root) {
  eq(root.style.getPropertyValue("position"), "fixed", "root position");
  eq(root.style.getPropertyValue("top"), "0", "root top");
  eq(root.style.getPropertyValue("left"), "0", "root left");
  eq(root.style.getPropertyValue("width"), "1114px", "root width");
  eq(root.style.getPropertyValue("height"), "1442px", "root height");
  const clone = root.querySelectorAll("[data-print-clone]")[0];
  check(clone, "no page clone inside the print root");
  if (clone) {
  eq(clone.id, "outer_page_1", "the clone keeps the page id (CSS positioning)");
  eq(clone.style.getPropertyValue("position"), "relative", "clone position");
  eq(clone.style.getPropertyValue("transform"), "none", "clone transform");
  eq(clone.style.getPropertyValue("width"), "1114px", "clone width");
  eq(clone.style.getPropertyValue("height"), "1442px", "clone height");
  eq(clone.getBoundingClientRect().width, 1114, "clone is rendered at natural size");

  // ancestor classes are rebuilt around the clone so Scribd's descendant
  // selectors still match, without any viewer geometry
  const shims = root.querySelectorAll("[data-print-shim]");
  eq(shims.length, 2, "ancestor shim count (document_container, document_scroller)");
  eq((shims[0] || { _classes: [] })._classes.join(" "), "document_container", "outer shim class");
  eq((shims[1] || { _classes: [] })._classes.join(" "), "document_scroller", "inner shim class");
  for (const shim of shims) {
    eq(shim.style.getPropertyValue("transform"), "none", "shim transform");
    eq(shim.style.getPropertyValue("overflow"), "visible", "shim overflow");
    eq(shim.style.getPropertyValue("width"), "auto", "shim width");
  }
  const innermost = shims[shims.length - 1];
  check(innermost && innermost.children.includes(clone), "the clone sits inside the shim chain");
  }
}

// The whole viewer must be gone from the sheet.
for (const el of [toolbar, sidebar, cookie, container]) {
  eq(el.style.getPropertyValue("display"), "none", `${el._classes.join(".") || el.tagName} hidden`);
}
eq(pages[0].getAttribute("style"), "width: 100%; height: 100%; top: 0px; left: 0px;",
   "the original page itself is never mutated");

const style = document.getElementById("scribd-printed-page-style");
check(style, "no @page style was injected");
if (style) {
  check(/@page\s*{\s*size:\s*1114px\s+1442px/.test(style.textContent), "@page is not sized to the page: " + style.textContent);
  check(/body > \*:not\(#scribd-printed-page-root\)/.test(style.textContent), "viewer is not hidden by CSS");
}

// ------------------------------------------------- page 3 (2): union growth
const grown = isolate({ selector: SELECTOR, index: 2 });
check(grown, "isolate returned nothing for the overflowing page");
if (grown) {
  eq(grown.width, 900, "paper grows to the overflowing image width");
  eq(grown.height, 1300, "paper grows to the overflowing image height");
}
// ...and the previous page's root is not left behind twice.
eq(document.querySelectorAll("[data-print-root]").length, 1, "exactly one print root at a time");

// ------------------------------- page 4 (3): no box, sized from its image
const derived = isolate({ selector: SELECTOR, index: 3 });
check(derived, "isolate returned nothing for the unsized wrapper");
if (derived) {
  eq(derived.width, 1000, "paper width derived from the page image");
  eq(derived.height, 1400, "paper height derived from the page image");
}

// ------------------------------------------------------------- cleanup
cleanup();
eq(document.getElementById("scribd-printed-page-root"), null, "root removed by cleanup");
eq(document.getElementById("scribd-printed-page-style"), null, "style removed by cleanup");
for (const el of [toolbar, sidebar, cookie, container]) {
  eq(el.style.getPropertyValue("display"), "", `${el.tagName} display restored`);
}
eq(pages[0].getAttribute("style"), "width: 100%; height: 100%; top: 0px; left: 0px;", "original inline style restored");

// ------------------------------------------------- isolate works again
const again = isolate({ selector: SELECTOR, index: 1 });
check(again, "isolate failed after cleanup");
if (again) eq(again.width, 1114, "paper width after cleanup");
cleanup();

// ------------------------------------------------- embed-print isolation
// themrsami/scribd-downloader's per-page print model (one page per sheet).
if (input.embedIsolate) {
  const embedIsolate = new Function("return (" + input.embedIsolate + ")")();
  // leftovers from the previous iteration must be cleared before measuring
  pages[1].style.setProperty("display", "none");
  pages[1].style.setProperty("position", "absolute");
  pages[1].style.setProperty("page-break-after", "always");

  const info = embedIsolate(1);
  check(info, "embed isolate returned nothing");
  if (info) {
    // ceil() of the rendered rect: 1114 x 0.7 -> 780, 1442 x 0.7 -> 1010
    eq(info.width, 780, "embed paper width (ceil of the measured rect)");
    eq(info.height, 1010, "embed paper height");
    eq(info.text, "page 2 text", "embed page text");
  }
  eq(pages[1].style.getPropertyValue("display"), "", "leftover display cleared");
  eq(pages[1].style.getPropertyValue("position"), "", "leftover position cleared");
  eq(pages[1].style.getPropertyValue("page-break-after"), "", "leftover break cleared");
  eq(pages[1].getAttribute("data-export-target"), "true", "target marked");
  eq(document.querySelectorAll("[data-export-target]").length, 1, "exactly one target");

  const isolated = document.getElementById("isolated-page-print-style");
  check(isolated, "embed isolate injected no style");
  if (isolated) {
    check(/@page\s*{\s*size:\s*780px\s+1010px/.test(isolated.textContent),
          "embed @page not sized to the page: " + isolated.textContent.slice(0, 200));
    check(isolated.textContent.includes('.outer_page { display: none !important; }'),
          "other pages are not hidden");
    check(isolated.textContent.includes('.outer_page[data-export-target="true"]'),
          "target has no absolute/0,0 rule");
    check(isolated.textContent.includes("position: absolute !important"),
          "target is not pinned");
    check(isolated.textContent.includes("overflow: hidden !important"),
          "document is not clamped to one sheet");
  }
}

if (failures.length) {
  console.error("FAIL\n" + failures.join("\n"));
  process.exit(1);
}
console.log("ok");
