"""Print exactly one document page per PDF sheet.

Ported from three working projects:

* **themrsami/scribd-downloader** prints each page on its own: mark the
  target ``.outer_page``, hide every other page, inject
  ``@page { size: Wpx Hpx; margin: 0 }`` sized to *that* page, call
  ``Page.printToPDF`` with ``paperWidth/paperHeight`` = page size,
  ``preferCSSPageSize``, ``pageRanges: "1"`` and ``scale: 1``, and asserts the
  result has exactly **one** sheet. The per-page PDFs are then merged with
  ``pypdf``.
* **xDatx/Studocu-Scribd-Helper** isolates the viewer: the page container is
  moved under ``<body>`` and every other body child is hidden with inline
  ``!important`` styles, so toolbars, sidebars, cookie banners and tracking
  iframes never reach the PDF. It also hides Scribd's decorative corners
  (``.b_tl .b_tr .b_br .b_bl .b_t .b_r .b_b .b_l``) and ``.highlighter_canvas``.
* **youngpiu/scribd-pdf-downloader** sizes ``@page`` at 96 CSS px per inch.

Why the old version failed
--------------------------
It still marked the target page *in place* and relied on print CSS to hide
everything else. Two things go wrong with that on Scribd's virtualised
viewer: (1) the page box was taken from the inline ``style`` attribute, where
Scribd stores percentages (``width: 100%``), so ``parseFloat`` returned
``100`` and the paper was ~1 inch instead of the page size — the page then
spilled over ~14 sheets; (2) nothing guaranteed that the viewer's scrollers,
toolbars and virtual pages stopped contributing to the printed document.

This version makes the sheet *physically* impossible to overflow:

1. the page is **cloned** into a fresh ``<div>`` appended to ``<body>``, so
   the viewer (React etc.) can no longer re-render or unload it while it is
   printed;
2. that root is ``position: fixed; top: 0; left: 0``, which in print media is
   anchored to the top-left of the *paper*, not to the scrolled viewport;
3. ``html``/``body`` are clamped to the page size with ``overflow: hidden``
   and every other body child is hidden with inline ``!important``;
4. the paper is measured from the computed (untransformed) page box plus the
   visible image/text layer bounds — never from a percentage string;
5. the caller prints with ``pageRanges: "1"``, so the output is one sheet
   even if a document page has odd content.

Pure helpers live here so the merge/size logic is testable without a browser.
"""
from __future__ import annotations

from io import BytesIO

# Selectors used by the caller for the print root (screenshot fallback).
PRINT_ROOT_ID = "scribd-printed-page-root"
PRINT_ROOT_SELECTOR = f"#{PRINT_ROOT_ID}"
ESTIMATE_STYLE_ID = "scribd-printed-page-style"

# One page per sheet: clone the page into a fixed-size root at the top-left of
# the paper and hide the entire viewer around it.
ISOLATE_PAGE_JS = r"""
(args) => {
  const {selector, index} = args;
  const PAD = 4;                                  // Chrome rounds paper sizes down
  const STYLE_ID = 'scribd-printed-page-style';
  const ROOT_ID = 'scribd-printed-page-root';

  // --- undo whatever the previous page left behind ------------------------
  const restore = () => {
    const old = document.getElementById(ROOT_ID);
    if (old) old.remove();
    const st = document.getElementById(STYLE_ID);
    if (st) st.remove();
    for (const [el, prev] of (window.__scribdPrintHidden || [])) {
      try {
        if (prev === null || prev === undefined) el.removeAttribute('style');
        else el.setAttribute('style', prev);
      } catch (e) {}
    }
    window.__scribdPrintHidden = [];
  };
  restore();

  const pages = Array.from(document.querySelectorAll(selector));
  const target = pages[index];
  if (!target) return null;

  // --- measure the page from its computed box -----------------------------
  // getComputedStyle().width/height are always used values in CSS px and are
  // NOT affected by the viewer's CSS zoom/transform. Scribd's inline
  // style="width: 100%" would parseFloat() to 100 — never look at that.
  const num = (v) => { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : 0; };
  const cs = getComputedStyle(target);
  const rect = target.getBoundingClientRect();
  let width = Math.round(num(cs.width) || target.offsetWidth || rect.width);
  let height = Math.round(num(cs.height) || target.offsetHeight || rect.height);
  if (width < 50 || height < 50) {
    // Some wrappers have no box of their own; derive the page size from the
    // largest image it holds (the page scan is the real document page).
    for (const el of target.querySelectorAll('img, canvas, svg')) {
      const r = el.getBoundingClientRect();
      const natW = Math.round(el.naturalWidth || 0);
      const natH = Math.round(el.naturalHeight || 0);
      const w2 = natW > 50 ? natW : Math.round(r.width);
      const h2 = natH > 50 ? natH : Math.round(r.height);
      if (w2 > width && h2 > height) { width = w2; height = h2; }
    }
  }
  if (width < 50 || height < 50) return null;    // unmeasured / collapsed page

  // --- clone it (an inert copy the viewer cannot unload) ------------------
  const clone = target.cloneNode(true);
  clone.setAttribute('data-print-clone', 'true');
  clone.removeAttribute('data-export-target');
  clone.removeAttribute('aria-hidden');

  // cloneNode() copies a <canvas> element but not its bitmap.
  const fromCanvas = target.querySelectorAll('canvas');
  const toCanvas = clone.querySelectorAll('canvas');
  for (let i = 0; i < fromCanvas.length && i < toCanvas.length; i++) {
    try {
      const src = fromCanvas[i], dst = toCanvas[i];
      dst.width = src.width;
      dst.height = src.height;
      dst.getContext('2d').drawImage(src, 0, 0);
    } catch (e) {}
  }

  // cloneNode() does not copy shadow roots either.
  const srcAll = [target, ...target.querySelectorAll('*')];
  const dstAll = [clone, ...clone.querySelectorAll('*')];
  for (let i = 0; i < srcAll.length && i < dstAll.length; i++) {
    const shadow = srcAll[i].shadowRoot;
    if (!shadow) continue;
    try {
      dstAll[i].attachShadow({mode: 'open'}).appendChild(shadow.cloneNode(true));
    } catch (e) {}
  }

  // --- a clean, fixed root at the top-left of the PAPER -------------------
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('data-print-root', 'true');
  root.style.cssText = [
    'position: fixed', 'top: 0', 'left: 0',
    'width: ' + width + 'px', 'height: ' + height + 'px',
    'margin: 0', 'padding: 0', 'border: 0', 'overflow: hidden',
    'background: #ffffff', 'transform: none', 'zoom: 1', 'z-index: 2147483647',
  ].map((s) => s + ' !important').join('; ') + ';';
  // Rebuild the ancestor chain as class-only "shims" inside the root so that
  // Scribd's descendant selectors (`.document_container .text_layer span`,
  // `.document_scroller img`, ...) still match the clone. The shims carry no
  // viewer geometry: static, auto-sized, no transform, no overflow clipping.
  const chain = [];
  for (let n = target.parentElement; n && n !== document.body; n = n.parentElement) {
    chain.unshift(n);
  }
  let host = root;
  for (const src of chain) {
    const shim = document.createElement(src.tagName || 'div');
    if (src.id) shim.id = src.id;
    if (src.className && typeof src.className === 'string') shim.className = src.className;
    shim.setAttribute('data-print-shim', 'true');
    for (const [prop, val] of [
      ['display', 'block'], ['position', 'static'], ['transform', 'none'],
      ['zoom', '1'], ['overflow', 'visible'], ['margin', '0'], ['padding', '0'],
      ['border', '0'], ['width', 'auto'], ['height', 'auto'],
      ['min-width', '0'], ['min-height', '0'], ['max-width', 'none'],
      ['max-height', 'none'], ['float', 'none'],
    ]) shim.style.setProperty(prop, val, 'important');
    host.appendChild(shim);
    host = shim;
  }
  host.appendChild(clone);
  document.body.appendChild(root);

  // The clone must not keep the viewer's offset/scale.
  const force = (el, prop, val) => el.style.setProperty(prop, val, 'important');
  const own = [
    ['position', 'relative'], ['top', '0px'], ['left', '0px'],
    ['right', 'auto'], ['bottom', 'auto'], ['float', 'none'],
    ['transform', 'none'], ['zoom', '1'],
    ['margin', '0'], ['padding', '0'], ['border', '0'],
    ['min-width', '0'], ['min-height', '0'],
    ['max-width', 'none'], ['max-height', 'none'],
    ['overflow', 'hidden'], ['background', '#ffffff'],
    ['width', width + 'px'], ['height', height + 'px'],
  ];
  for (const [prop, val] of own) force(clone, prop, val);

  // --- grow to the real content if the page box is smaller ----------------
  // Some pages place the text layer slightly outside .outer_page; include it,
  // but ignore runaway offsets (children positioned against the old scroller
  // end up thousands of px away once cloned).
  const base = clone.getBoundingClientRect();
  let unionW = width, unionH = height;
  for (const el of clone.querySelectorAll(
      'img, canvas, svg, .text_layer, .image_layer, .absimg')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    unionW = Math.max(unionW, Math.ceil(r.right - base.left));
    unionH = Math.max(unionH, Math.ceil(r.bottom - base.top));
  }
  const runaway = unionW > width * 1.5 || unionH > height * 1.5;
  if (!runaway) {
    if (unionW > width) { width = unionW; force(clone, 'width', width + 'px'); }
    if (unionH > height) { height = unionH; force(clone, 'height', height + 'px'); }
  }
  force(root, 'width', width + 'px');
  force(root, 'height', height + 'px');

  // --- hide the whole viewer (toolbars, scrollers, other pages) -----------
  const skip = ['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE'];
  const hide = (el) => {
    if (!el || el === root || skip.includes(el.tagName)) return;
    window.__scribdPrintHidden.push([el, el.getAttribute('style')]);
    el.style.setProperty('display', 'none', 'important');
  };
  for (const child of Array.from(document.body.children)) hide(child);
  for (const child of Array.from(document.documentElement.children)) {
    if (child !== document.body && child.tagName !== 'HEAD') hide(child);
  }
  window.__scribdPrintHidden = window.__scribdPrintHidden || [];

  // --- the paper is exactly this page -------------------------------------
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @page { size: ${width}px ${height}px; margin: 0; }
    html, body {
      margin: 0 !important; padding: 0 !important;
      transform: none !important; filter: none !important;
      contain: none !important;
      width: ${width}px !important; height: ${height}px !important;
      min-width: 0 !important; min-height: 0 !important;
      max-width: none !important; max-height: none !important;
      overflow: hidden !important; background: #ffffff !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body > *:not(#${ROOT_ID}) { display: none !important; }
    #${ROOT_ID} { display: block !important; }
    #${ROOT_ID} :is(.b_tl, .b_tr, .b_br, .b_bl, .b_t, .b_r, .b_b, .b_l,
                    .highlighter_canvas) { display: none !important; }
  `;
  document.head.appendChild(style);

  return {
    width, height,
    pageWidth: width + PAD, pageHeight: height + PAD,
    unionWidth: unionW, unionHeight: unionH, runaway: runaway ? 1 : 0,
    docWidth: document.documentElement.scrollWidth,
    docHeight: document.documentElement.scrollHeight,
    images: clone.querySelectorAll('img').length,
    canvases: clone.querySelectorAll('canvas').length,
    text: (clone.innerText || '').trim().length,
    pages: pages.length,
  };
}
"""

# Let the clone's images decode and the layout settle before printing; a
# print that runs too early has been seen to emit blank pages.
WAIT_FOR_PRINT_JS = r"""
async () => {
  const root = document.getElementById('scribd-printed-page-root');
  if (!root) return {images: 0, loaded: 0};
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return null;
    return new Promise((resolve) => {
      img.addEventListener('load', resolve, {once: true});
      img.addEventListener('error', resolve, {once: true});
      setTimeout(resolve, 3000);
    });
  }));
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  } catch (e) {}
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 50));
  return {
    images: imgs.length,
    loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
  };
}
"""

CLEANUP_JS = r"""
() => {
  const root = document.getElementById('scribd-printed-page-root');
  if (root) root.remove();
  const style = document.getElementById('scribd-printed-page-style');
  if (style) style.remove();
  document.querySelectorAll('[data-print-clone]').forEach(
    el => el.removeAttribute('data-print-clone')
  );
  for (const [el, prev] of (window.__scribdPrintHidden || [])) {
    try {
      if (prev === null || prev === undefined) el.removeAttribute('style');
      else el.setAttribute('style', prev);
    } catch (e) {}
  }
  window.__scribdPrintHidden = [];
  return true;
}
"""


def px_to_inches(px: float, dpi: int = 96) -> float:
    """CSS pixels -> inches (96 CSS px per inch), as printToPDF expects."""
    return round(float(px) / float(dpi), 4)


def merge_pdfs(parts: list[bytes]) -> bytes | None:
    """Concatenate one-sheet PDFs in order (needs pypdf)."""
    parts = [p for p in parts if p and p[:4] == b"%PDF"]
    if not parts:
        return None
    try:
        from pypdf import PdfReader, PdfWriter
    except Exception:
        return None
    writer = PdfWriter()
    added = 0
    for blob in parts:
        try:
            reader = PdfReader(BytesIO(blob))
        except Exception:
            continue
        for pdf_page in reader.pages:
            writer.add_page(pdf_page)
            added += 1
    if not added:
        return None
    out = BytesIO()
    writer.write(out)
    return out.getvalue()


def count_pages(pdf: bytes) -> int:
    """Number of sheets in a PDF (0 if unreadable)."""
    try:
        from pypdf import PdfReader

        return len(PdfReader(BytesIO(pdf)).pages)
    except Exception:
        return 0


def pdf_page_sizes(pdf: bytes) -> list[tuple[int, int]]:
    """Sheet sizes in points, in order (empty if unreadable)."""
    try:
        from pypdf import PdfReader
    except Exception:
        return []
    try:
        reader = PdfReader(BytesIO(pdf))
    except Exception:
        return []
    sizes: list[tuple[int, int]] = []
    for sheet in reader.pages:
        try:
            box = sheet.mediabox
            sizes.append((round(float(box.width)), round(float(box.height))))
        except Exception:
            sizes.append((0, 0))
    return sizes


def image_to_pdf(blob: bytes, dpi: float = 96.0) -> bytes | None:
    """One screenshot -> a one-sheet PDF sized to the image (needs Pillow).

    Used only when printing a single page fails: better a faithful raster of
    that page than a missing page (or a whole-viewport screenshot).
    """
    if not blob:
        return None
    try:
        from PIL import Image
    except Exception:
        return None
    try:
        im = Image.open(BytesIO(blob))
        im.load()
        im = im.convert("RGB")
    except Exception:
        return None
    out = BytesIO()
    try:
        im.save(out, format="PDF", resolution=float(dpi))
    except Exception:
        return None
    return out.getvalue()
