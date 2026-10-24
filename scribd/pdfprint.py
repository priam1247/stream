"""Print exactly one document page per PDF sheet.

Ported from two working projects:

* **themrsami/scribd-downloader** prints each page on its own:
  mark the target ``.outer_page`` with an attribute, hide every other page,
  inject ``@page { size: Wpx Hpx; margin: 0 }`` sized to *that* page, call
  ``Page.printToPDF`` with ``paperWidth/paperHeight`` = page size and
  ``preferCSSPageSize``, assert the result has exactly one sheet, then merge
  the per-page PDFs with pypdf.
* **xDatx/Studocu-Scribd-Helper** isolates the viewer the same way — the
  document container is moved under ``<body>`` and every other body child is
  hidden — so toolbars, sidebars and cookie banners never reach the PDF.
  It also hides Scribd's decorative corner elements
  (``.b_tl .b_tr .b_br .b_bl .b_t .b_r .b_b .b_l`` and
  ``.highlighter_canvas``).

Without that isolation the print contains the whole browser viewport (what
you saw: "screenshots of the whole page, not just the book page").

Pure helpers live here so the merge/size logic is testable without a browser.
"""
from __future__ import annotations

from io import BytesIO

# One page per sheet: only the marked page is laid out, at its own size.
ISOLATE_PAGE_JS = """
(args) => {
  const {selector, index} = args;
  const PAD = 4;                       // Chrome rounds paper sizes down
  const STYLE_ID = 'scribd-isolated-page-print';

  const pages = Array.from(document.querySelectorAll(selector));
  const target = pages[index];
  if (!target) return null;

  // Measure this page (explicit size wins over the rendered box).
  const parse = v => { const n = parseFloat(v || ''); return isFinite(n) && n > 0 ? n : 0; };
  const cs = getComputedStyle(target);
  let width = Math.floor(parse(target.style.width) || parse(cs.width) ||
                          target.offsetWidth || target.getBoundingClientRect().width);
  let height = Math.floor(parse(target.style.height) || parse(cs.height) ||
                           target.offsetHeight || target.getBoundingClientRect().height);
  if (!width || !height) return null;

  pages.forEach(p => p.removeAttribute('data-export-target'));
  target.setAttribute('data-export-target', 'true');

  // Isolate: hide every top-level body child that does not contain the page
  // (toolbars, sidebars, cookie banners, tracking iframes). Done inline with
  // !important because some of those elements carry "display:block!important".
  const topChild = el => {
    let c = el;
    while (c && c.parentElement && c.parentElement !== document.body) c = c.parentElement;
    return c;
  };
  const keep = topChild(target);
  window.__scribdPrintHidden = [];
  for (const child of Array.from(document.body.children)) {
    if (child === keep) continue;
    if (['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT'].includes(child.tagName)) continue;
    window.__scribdPrintHidden.push([child, child.getAttribute('style')]);
    child.style.setProperty('display', 'none', 'important');
  }
  // Flatten the ancestors of the target so it can be laid out at 0,0.
  for (let n = target.parentElement; n && n !== document.body; n = n.parentElement) {
    n.style.setProperty('position', 'static', 'important');
    n.style.setProperty('overflow', 'visible', 'important');
    n.style.setProperty('transform', 'none', 'important');
    n.style.setProperty('width', 'auto', 'important');
    n.style.setProperty('height', 'auto', 'important');
    n.style.setProperty('max-width', 'none', 'important');
    n.style.setProperty('max-height', 'none', 'important');
    n.style.setProperty('margin', '0', 'important');
    n.style.setProperty('padding', '0', 'important');
  }

  const old = document.getElementById(STYLE_ID);
  if (old) old.remove();

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @page { size: ${width}px ${height}px; margin: 0; }
    @media print {
      html, body {
        width: ${width}px !important; height: ${height}px !important;
        min-width: ${width}px !important; min-height: ${height}px !important;
        max-width: ${width}px !important; max-height: ${height}px !important;
        margin: 0 !important; padding: 0 !important;
        overflow: hidden !important; background: #fff !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      /* isolate: nothing else on the site may contribute to the sheet */
      html > body > *:not(.document_container):not(:has(${selector}[data-export-target="true"])) {
        display: none !important;
      }
      .toolbar_top, .toolbar_bottom, .sidebar, .page_support,
      .snp-hide, [class*="cookie"], [class*="consent"], [id*="osano"] {
        display: none !important;
      }
      ${selector} { display: none !important; visibility: hidden !important; }
      ${selector}[data-export-target="true"] {
        display: block !important; visibility: visible !important;
        position: absolute !important; top: 0 !important; left: 0 !important;
        right: auto !important; bottom: auto !important;
        width: ${width}px !important; height: ${height}px !important;
        min-width: 0 !important; min-height: 0 !important;
        max-width: none !important; max-height: none !important;
        margin: 0 !important; padding: 0 !important;
        border: 0 !important; transform: none !important;
        overflow: hidden !important;
        break-before: auto !important; break-after: auto !important;
        break-inside: auto !important; page-break-inside: auto !important;
      }
      /* Scribd's decorative frame + highlight canvas add nothing */
      ${selector}[data-export-target="true"] :is(
        .b_tl, .b_tr, .b_br, .b_bl, .b_t, .b_r, .b_b, .b_l, .highlighter_canvas
      ) { display: none !important; }
    }
  `;
  document.head.appendChild(style);
  return {width, height, pageWidth: width + PAD, pageHeight: height + PAD};
}
"""

CLEANUP_JS = """
() => {
  const style = document.getElementById('scribd-isolated-page-print');
  if (style) style.remove();
  document.querySelectorAll('[data-export-target]').forEach(
    el => el.removeAttribute('data-export-target')
  );
  for (const [el, prev] of (window.__scribdPrintHidden || [])) {
    try {
      if (prev === null) el.removeAttribute('style');
      else el.setAttribute('style', prev);
    } catch (e) {}
  }
  window.__scribdPrintHidden = [];
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
