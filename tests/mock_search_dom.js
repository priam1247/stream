/* Run scribd/search.py's BROWSER_EXTRACT_JS against a fake result grid.
 *
 * stdin:  {"extract": "<js>"}
 * exit 0: prints "ok";  exit 1: prints what went wrong.
 *
 * The fixture mirrors a Scribd search card: a thumbnail link (alt text only),
 * a title link (title attribute), a "Save" link, a legacy /doc/ link, another
 * content type, a slug-only card and a non-document nav link.
 */
const fs = require("fs");

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const extract = new Function("return (" + input.extract + ")")();

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}

function el(tag, props = {}) {
  const attrs = props.attrs || {};
  return {
    tagName: tag.toUpperCase(),
    innerText: props.text || "",
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelector: (selector) =>
      props.img && selector === "img" ? props.img : null,
  };
}

const cards = [
  el("a", {
    attrs: { href: "/document/1234567/Excel-Basics" },
    img: el("img", { attrs: { alt: "Excel Basics" } }),
  }),
  el("a", {
    attrs: {
      href: "/document/1234567/Excel-Basics",
      title: "Excel Basics for Beginners",
    },
    text: "Excel Basics for Beginners",
  }),
  el("a", {
    attrs: { href: "/document/1234567/Excel-Basics", "aria-label": "Save" },
    text: "Save",
  }),
  el("a", {
    attrs: { href: "https://www.scribd.com/presentation/7654321/Excel-Dashboard" },
    text: "Excel Dashboard",
  }),
  el("a", {
    attrs: { href: "/doc/999/Excel-Legacy" },
    text: "Excel Legacy Doc",
  }),
  el("a", { attrs: { href: "/spreadsheet/555/Excel-Template" } }),
  el("a", { attrs: { href: "/about" }, text: "About" }),
];

globalThis.document = {
  querySelectorAll: (selector) =>
    selector.includes("data-document-id") ? [] : cards,
};

const hits = extract();
check(Array.isArray(hits), "extractor did not return a list");
const byId = Object.fromEntries((hits || []).map((hit) => [hit.doc_id, hit]));

check((hits || []).length === 4, `expected 4 unique documents, got ${(hits || []).length}`);
check(byId["1234567"], "the /document/ card is missing");
check(
  byId["1234567"] && byId["1234567"].title === "Excel Basics for Beginners",
  `title attribute must win over the thumbnail alt, got ${JSON.stringify(byId["1234567"])}`
);
check(byId["1234567"] && byId["1234567"].kind === "document", "kind for /document/");
check(byId["7654321"] && byId["7654321"].kind === "presentation", "kind for /presentation/");
check(byId["999"] && byId["999"].kind === "document", "legacy /doc/ maps to document");
check(byId["555"] && byId["555"].title === "", "slug-only card has no title text");
check(!byId["about"], "non-document links must be ignored");

// order is the page order
check(
  (hits || []).map((hit) => hit.doc_id).join(",") === "1234567,7654321,999,555",
  `page order lost: ${(hits || []).map((hit) => hit.doc_id).join(",")}`
);

if (failures.length) {
  console.error("FAIL\n" + failures.join("\n"));
  process.exit(1);
}
console.log("ok");
