"""Export a Scribd document the way themrsami/scribd-downloader does.

This module is a **port, not a re-invention**.  It follows
https://github.com/themrsami/scribd-downloader step by step, because that
project is known to produce clean PDFs on very large documents (their README
reports 2,552 pages):

1. ``/document/<id>/...`` (or legacy ``/doc/<id>/...``) becomes
   ``https://www.scribd.com/embeds/<id>/content`` — the bare embed viewer,
   without the site's navigation, sidebar, footer or paywall chrome.
2. Pages are loaded **directly through the viewer's own manager** instead of
   being scrolled into view::

       window.docManager.pages[n].load()          # fetch the page DOM
       window.docManager.pages[n].display()       # render it
       window.docManager.pages[n].turnOnImages()  # start image decoding
       window.docManager.pages[n].innerPageElem    # ready marker

   Loading runs in bounded batches (default 8) so Chrome's memory stays
   bounded on thousand-page documents; each batch is released after printing.
3. Toolbars are removed, the cookie/consent banners are removed, the scroll
   containers are flattened (``.document_scroller`` keeps its class so
   descendant CSS for math/SVG keeps working — removing the class, as older
   versions did, broke formulas).
4. Fonts/images/layout are given time to settle before the export starts.
5. Each ``.outer_page`` is printed **alone**: every other page is
   ``display: none``, the target is pinned to ``0,0`` at its measured size,
   ``html``/``body`` are clamped to that size with ``overflow: hidden``, and
   ``@page { size: <w>px <h>px; margin: 0 }`` is injected.
6. The sheet is produced with the Chrome DevTools Protocol call
   ``Page.printToPDF`` using ``scale: 1``, ``paperWidth/paperHeight`` in
   inches (measured px / 96), zero margins, ``preferCSSPageSize: true`` and
   ``pageRanges: "1"`` — so one document page can only ever become one sheet.
7. Every page PDF is read back with ``pypdf`` and must contain exactly one
   sheet; the pages are then concatenated in order.

The only differences from the upstream script: Playwright drives Chrome (this
project's browser dependency) instead of Selenium, the text of every page is
collected for the .txt/.md/.epub outputs, and the PDFs are merged in memory.
"""
from __future__ import annotations

import asyncio
import base64
import os
import re
from dataclasses import dataclass

from .models import DocumentMeta, Page, ScrapedDocument

# Same defaults as the upstream script (all overridable by env var there).
DEFAULT_RENDER_SETTLE_TIMEOUT = int(os.getenv("SCRIBD_RENDER_SETTLE_TIMEOUT", "30"))
DEFAULT_PAGE_LOAD_CONCURRENCY = max(1, int(os.getenv("SCRIBD_PAGE_LOAD_CONCURRENCY", "8")))
DEFAULT_PAGE_LOAD_TIMEOUT = max(10, int(os.getenv("SCRIBD_PAGE_LOAD_TIMEOUT", "120")))
DEFAULT_EXPORT_BATCH_SIZE = max(1, int(os.getenv("SCRIBD_EXPORT_BATCH_SIZE", "8")))
DEFAULT_PAPER_WIDTH_INCHES = 7.25
DEFAULT_PAPER_HEIGHT_INCHES = 10.5

DOC_URL_RE = re.compile(r"scribd\.com/(?:document|doc)/(\d+)")


def embed_url(*, doc_id: str = "", url: str = "") -> str:
    """``/document/<id>/Title`` -> ``https://www.scribd.com/embeds/<id>/content``."""
    if not doc_id:
        match = DOC_URL_RE.search(url or "")
        doc_id = match.group(1) if match else ""
    if not doc_id:
        return ""
    return f"https://www.scribd.com/embeds/{doc_id}/content"


# ---------------------------------------------------------------------------
# 1) load every page through docManager (no scrolling)
# ---------------------------------------------------------------------------
LOAD_ALL_PAGES_JS = r"""
async (args) => {
  const {concurrency, pageTimeoutMs, documentTimeoutMs} = args;
  const manager = window.docManager;
  if (!manager || !manager.pages) return {supported: false};

  const pages = Object.values(manager.pages).filter(Boolean);
  const pending = pages.filter((page) => !page.innerPageElem);
  const active = new Map();
  const failed = [];
  const startedAt = Date.now();
  let nextIndex = 0;
  let completed = pages.length - pending.length;

  const launchMore = () => {
    while (active.size < concurrency && nextIndex < pending.length) {
      const page = pending[nextIndex++];
      try {
        if (!page.loadHasStarted) page.load();
        active.set(page.pageNum, {page, startedAt: Date.now()});
      } catch (error) {
        failed.push({pageNum: page.pageNum, reason: String(error)});
      }
    }
  };

  launchMore();

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      for (const [pageNum, state] of active) {
        if (state.page.innerPageElem) {
          active.delete(pageNum);
          completed += 1;
          continue;
        }
        if (Date.now() - state.startedAt >= pageTimeoutMs) {
          active.delete(pageNum);
          failed.push({pageNum, reason: 'page load timed out'});
        }
      }

      if (Date.now() - startedAt >= documentTimeoutMs) {
        for (const [pageNum] of active) {
          failed.push({pageNum, reason: 'document load timed out'});
        }
        active.clear();
      }

      launchMore();
      if (active.size === 0 && nextIndex >= pending.length) {
        clearInterval(timer);
        return resolve();
      }
    }, 50);
  });

  // Render + start image decoding for everything that did load.
  for (const page of pages) {
    if (!page.innerPageElem) continue;
    try { page.display(); } catch (error) {}
    try { page.turnOnImages(); } catch (error) {}
  }

  return {
    supported: true,
    total: pages.length,
    loaded: pages.filter((page) => page.innerPageElem).length,
    failed,
    elapsedMs: Date.now() - startedAt,
  };
}
"""

# Bounded batch: load only these page numbers (keeps Chrome memory flat).
LOAD_PAGE_BATCH_JS = r"""
async (args) => {
  const {pageNumbers, timeoutMs} = args;
  const manager = window.docManager;
  if (!manager || !manager.pages) return {supported: false};

  const states = pageNumbers.map((pageNum) => ({
    pageNum,
    page: manager.pages[pageNum],
    error: null,
  }));
  const startedAt = Date.now();

  for (const state of states) {
    if (!state.page) { state.error = 'page object missing'; continue; }
    try {
      if (!state.page.innerPageElem && !state.page.loadHasStarted) state.page.load();
    } catch (error) { state.error = String(error); }
  }

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      let ready = 0;
      for (const state of states) {
        if (state.error) { ready += 1; continue; }
        const page = state.page;
        if (!page || !page.innerPageElem) continue;
        try {
          page.display();
          if (!page._imagesTurnedOn) page.turnOnImages();
        } catch (error) {
          state.error = String(error);
          ready += 1;
          continue;
        }
        const pending = Array.from(page.innerPageElem.querySelectorAll('img'))
          .filter((image) => !image.complete);
        if (pending.length === 0) ready += 1;
      }

      if (ready === states.length || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        if (Date.now() - startedAt >= timeoutMs) {
          for (const state of states) {
            if (!state.error && (!state.page || !state.page.innerPageElem)) {
              state.error = 'page or image load timed out';
            }
          }
        }
        return resolve({
          supported: true,
          failed: states
            .filter((state) => state.error)
            .map((state) => ({pageNum: state.pageNum, reason: state.error})),
        });
      }
    }, 50);
  });
}
"""

RELEASE_PAGE_BATCH_JS = r"""
(pageNumbers) => {
  const manager = window.docManager;
  if (!manager || !manager.pages) return 0;
  let released = 0;
  for (const pageNum of pageNumbers) {
    const page = manager.pages[pageNum];
    if (!page) continue;
    try {
      page.remove();
      released += 1;
    } catch (error) {
      const container = document.getElementById(`outer_page_${pageNum}`);
      const inner = container && container.querySelector('.newpage');
      if (inner) { inner.remove(); released += 1; }
    }
  }
  return released;
}
"""

# ---------------------------------------------------------------------------
# 2) strip chrome, flatten scrollers, hide cookie banners
# ---------------------------------------------------------------------------
PREPARE_JS = r"""
() => {
  const removed = {toolbarTop: false, toolbarBottom: false, containers: 0};

  const toolbarTop = document.querySelector('.toolbar_top');
  if (toolbarTop) { toolbarTop.remove(); removed.toolbarTop = true; }

  const toolbarBottom = document.querySelector('.toolbar_bottom');
  if (toolbarBottom) { toolbarBottom.remove(); removed.toolbarBottom = true; }

  // Keep the class: removing it broke descendant CSS used by equations.
  document.querySelectorAll('.document_scroller').forEach((element) => {
    element.setAttribute('data-scribd-print-root', 'true');
    element.style.position = 'static';
    element.style.top = 'auto';
    element.style.bottom = 'auto';
    element.style.left = 'auto';
    element.style.right = 'auto';
    element.style.overflow = 'visible';
    element.style.maxHeight = 'none';
    element.style.height = 'auto';
    element.style.margin = '0';
    element.style.padding = '0';
    removed.containers += 1;
  });

  return removed;
}
"""

HIDE_COOKIES_JS = r"""
() => {
  let removed = 0;

  const closeSelectors = [
    '[class*="cookie"] [class*="close"]',
    '[class*="cookie"] [class*="dismiss"]',
    '[class*="consent"] [class*="close"]',
    '[class*="consent"] [class*="dismiss"]',
    '[class*="banner"] [class*="close"]',
    '[class*="banner"] [class*="dismiss"]',
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    'button[aria-label="Dismiss"]',
    '[data-dismiss]',
  ];
  for (const selector of closeSelectors) {
    try {
      document.querySelectorAll(selector).forEach((button) => button.click());
    } catch (error) {}
  }

  const cookieSelectors = [
    '[class*="cookie"]', '[class*="Cookie"]', '[class*="consent"]',
    '[class*="Consent"]', '[class*="gdpr"]', '[id*="cookie"]',
    '[id*="consent"]', '[id*="gdpr"]', '[class*="privacy-notice"]',
    '[class*="notice-banner"]', '.cc-window', '.cc-banner',
    '#onetrust-consent-sdk', '#onetrust-banner-sdk', '.evidon-banner',
    '[class*="osano-cm"]', '[id*="osano"]',
  ];
  for (const selector of cookieSelectors) {
    try {
      document.querySelectorAll(selector).forEach((element) => {
        element.remove();
        removed += 1;
      });
    } catch (error) {}
  }

  // Fixed/sticky overlay at the top of the page whose text talks about
  // cookies/privacy: only look at body-level elements so a 3,000-page DOM
  // does not get a computed-style sweep.
  try {
    for (const element of Array.from(document.body.children)) {
      const style = getComputedStyle(element);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      if (element.getBoundingClientRect().top >= 100) continue;
      const text = (element.innerText || '').toLowerCase();
      if (/(cookie|privacy|consent|analytics|advertising|personalization)/.test(text)) {
        element.remove();
        removed += 1;
      }
    }
  } catch (error) {}

  return removed;
}
"""

# ---------------------------------------------------------------------------
# 3) print CSS (upstream's rules + a hard stop for site chrome)
# ---------------------------------------------------------------------------
PRINT_CSS_JS = r"""
() => {
  const existing = document.getElementById('scribd-print-styles');
  if (existing) existing.remove();

  const style = document.createElement('style');
  style.id = 'scribd-print-styles';
  style.textContent = `
    [class*="cookie"], [class*="Cookie"], [class*="consent"],
    [class*="Consent"], [class*="gdpr"], [class*="privacy-notice"],
    [class*="notice-banner"], [id*="cookie"], [id*="consent"],
    [class*="osano-cm"], [id*="osano"] {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      height: 0 !important;
      overflow: hidden !important;
    }

    [data-scribd-print-root="true"], .document_scroller {
      position: static !important;
      top: auto !important; right: auto !important;
      bottom: auto !important; left: auto !important;
      overflow: visible !important;
      height: auto !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    @media print {
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      .toolbar_top, .toolbar_bottom { display: none !important; }

      /* Site chrome that is not part of the document. :not(.outer_page) so a
         page that is a *direct* child of <body> is never hidden by this rule
         (it would outrank the target rule below on specificity). */
      body > *:not(.outer_page):not(:has(.outer_page[data-export-target="true"])) {
        display: none !important;
      }

      [data-scribd-print-root="true"], .document_scroller {
        position: static !important;
        top: auto !important; right: auto !important;
        bottom: auto !important; left: auto !important;
        overflow: visible !important;
        height: auto !important;
        max-height: none !important;
        margin: 0 !important;
        padding: 0 !important;
      }

      /* keep math/SVG content from being clipped */
      mjx-container, .MathJax, .katex, math, svg {
        visibility: visible !important;
        overflow: visible !important;
      }
    }
  `;
  document.head.appendChild(style);
  return true;
}
"""

# ---------------------------------------------------------------------------
# 4) wait for fonts / images / geometry to settle
# ---------------------------------------------------------------------------
WAIT_SETTLE_JS = r"""
async (budgetMs) => {
  const start = performance.now();
  let stableTicks = 0;
  let lastSample = '';

  const sample = () => {
    const pages = Array.from(document.querySelectorAll("[class*='page']"));
    const heights = pages.slice(0, 12).map(
      (element) => Math.round(element.getBoundingClientRect().height)
    );
    const pendingImages = Array.from(document.images || [])
      .filter((image) => !image.complete).length;
    return JSON.stringify({pageCount: pages.length, heights, pendingImages});
  };

  try {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready.catch(() => undefined);
    }
  } catch (error) {}

  while (performance.now() - start < budgetMs) {
    lastSample = sample();
    const parsed = JSON.parse(lastSample);
    if (parsed.pendingImages === 0 && lastSample === window.__scribdLastRenderSample) {
      stableTicks += 1;
    } else {
      stableTicks = 0;
    }
    window.__scribdLastRenderSample = lastSample;
    if (stableTicks >= 2) return {timedOut: false, sample: lastSample};
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 200)));
  }
  return {timedOut: true, sample: lastSample || sample()};
}
"""

# How many pages does the viewer know about? No page is loaded by this call —
# the batch loader fetches only the pages we are about to print.
COUNT_PAGES_JS = r"""
() => {
  const manager = window.docManager;
  const fromManager = manager && manager.pages ? Object.keys(manager.pages).length : 0;
  const fromDom = document.querySelectorAll('.outer_page').length;
  return {
    supported: Boolean(manager && manager.pages),
    fromManager,
    fromDom,
    count: Math.max(fromManager, fromDom),
  };
}
"""

MEASURE_PAPER_JS = r"""
() => {
  const candidates = ['.outer_page', '.newpage', '.outer_page_container', "[class*='page']"];
  for (const selector of candidates) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {widthInches: rect.width / 96, heightInches: rect.height / 96, selector};
    }
  }
  return null;
}
"""

# ---------------------------------------------------------------------------
# 5) isolate one page (upstream's exact print model) and report its size
# ---------------------------------------------------------------------------
ISOLATE_PAGE_JS = r"""
(index) => {
  const pages = Array.from(document.querySelectorAll('.outer_page'));
  const target = pages[index];
  if (!target) return null;

  const oldStyle = document.getElementById('isolated-page-print-style');
  if (oldStyle) oldStyle.remove();

  // Restore every page before measuring (previous iterations hide them).
  pages.forEach((page) => {
    for (const prop of ['display', 'visibility', 'position', 'top', 'left',
                        'right', 'bottom', 'margin', 'break-after',
                        'page-break-after', 'break-before', 'page-break-before']) {
      page.style.removeProperty(prop);
    }
  });

  const rect = target.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);

  pages.forEach((page) => page.removeAttribute('data-export-target'));
  target.setAttribute('data-export-target', 'true');

  const style = document.createElement('style');
  style.id = 'isolated-page-print-style';
  style.textContent = `
    @page { size: ${width}px ${height}px; margin: 0; }

    @media print {
      html, body {
        width: ${width}px !important;
        height: ${height}px !important;
        min-width: ${width}px !important;
        min-height: ${height}px !important;
        max-width: ${width}px !important;
        max-height: ${height}px !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      .outer_page { display: none !important; }

      .outer_page[data-export-target="true"] {
        display: block !important;
        visibility: visible !important;
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        right: auto !important;
        bottom: auto !important;
        width: ${width}px !important;
        height: ${height}px !important;
        min-width: 0 !important;
        min-height: 0 !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        padding: 0 !important;
        transform: none !important;
        break-before: auto !important;
        break-after: auto !important;
        break-inside: auto !important;
        page-break-before: auto !important;
        page-break-after: auto !important;
        page-break-inside: auto !important;
        overflow: hidden !important;
      }
    }
  `;
  document.head.appendChild(style);

  return {
    width,
    height,
    text: (target.innerText || '').trim(),
    images: target.querySelectorAll('img').length,
    ready: target.querySelectorAll('img:not([src=""])').length,
  };
}
"""


@dataclass
class EmbedPageResult:
    index: int
    width_px: int
    height_px: int
    text: str
    pdf: bytes | None


class EmbedPrintStrategy:
    """themrsami/scribd-downloader's export path, driven by Playwright.

    Speed: the print work is split across ``workers`` tabs (each with its own
    CDP session) and each tab loads only the pages it prints, so the network
    cost is the same as a sequential run while ``Page.printToPDF`` — the slow
    part — happens in parallel.
    """

    name = "embed-print"

    def __init__(
        self,
        *,
        max_pages: int = 5000,
        workers: int = 2,
        settle_timeout: int = DEFAULT_RENDER_SETTLE_TIMEOUT,
        page_load_concurrency: int = DEFAULT_PAGE_LOAD_CONCURRENCY,
        page_load_timeout: int = DEFAULT_PAGE_LOAD_TIMEOUT,
        batch_size: int = DEFAULT_EXPORT_BATCH_SIZE,
        preload_all: bool = False,
        timeout: float = 90_000,
        headless: bool = True,
    ) -> None:
        self.max_pages = max_pages
        self.workers = max(1, int(workers))
        self.settle_timeout = settle_timeout
        self.page_load_concurrency = page_load_concurrency
        self.page_load_timeout = page_load_timeout
        self.batch_size = max(1, batch_size)
        self.preload_all = preload_all
        self.timeout = timeout
        self.headless = headless

    # -- entry point ------------------------------------------------------
    async def run(self, ctx, fetcher) -> ScrapedDocument | None:
        try:
            from playwright.async_api import async_playwright  # type: ignore
        except Exception:
            ctx.note(
                "embed-print: playwright not installed "
                "(pip install playwright && playwright install chromium)"
            )
            return None

        target_url = embed_url(doc_id=ctx.doc_id, url=ctx.url)
        if not target_url:
            ctx.note("embed-print: no document id in the URL")
            return None

        try:
            cookies = dict(getattr(fetcher, "cookies", {}) or {})
        except Exception:
            cookies = {}

        try:
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(
                    headless=self.headless,
                    args=[
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--hide-scrollbars",
                        "--force-color-profile=srgb",
                        "--disable-blink-features=AutomationControlled",
                    ],
                )
                try:
                    context = await browser.new_context(
                        viewport={"width": 1600, "height": 2200},
                        user_agent=(
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/124.0.0.0 Safari/537.36"
                        ),
                        locale="en-US",
                    )
                    if cookies:
                        await context.add_cookies(
                            [
                                {
                                    "name": str(k),
                                    "value": str(v),
                                    "domain": ".scribd.com",
                                    "path": "/",
                                }
                                for k, v in cookies.items()
                            ]
                        )

                    ctx.note(f"embed-print: {target_url}")
                    first = await self._open_tab(context, target_url, ctx, 1)
                    if first is None:
                        return None

                    info = await first.evaluate(COUNT_PAGES_JS) or {}
                    if self.preload_all:
                        await self._load_all_pages(first, ctx)
                    count = int(info.get("count") or 0)
                    if not count:
                        count = await first.locator(".outer_page").count()
                    if count <= 0:
                        ctx.note("embed-print: the viewer reports no pages")
                        return None
                    count = min(count, self.max_pages)
                    ctx.note(
                        f"embed-print: viewer knows {count} pages "
                        f"(docManager {info.get('fromManager', '?')}, "
                        f"DOM {info.get('fromDom', '?')})"
                    )

                    pages = [first]
                    workers = max(1, min(self.workers, count))
                    for number in range(2, workers + 1):
                        extra = await self._open_tab(context, target_url, ctx, number)
                        if extra is not None:
                            pages.append(extra)
                    workers = len(pages)
                    if workers > 1:
                        ctx.note(
                            f"embed-print: printing with {workers} tabs in parallel"
                        )

                    chunks = _split_range(count, workers)
                    cdps = [await context.new_cdp_session(p) for p in pages]
                    gathered = await asyncio.gather(
                        *[
                            self._export_range(
                                pages[i], cdps[i], ctx, chunks[i], i + 1, workers
                            )
                            for i in range(workers)
                        ]
                    )
                    results = sorted(
                        [item for chunk in gathered for item in chunk],
                        key=lambda item: item.index,
                    )

                    page_html = ""
                    try:
                        page_html = await first.content()
                    except Exception:
                        pass

                    exported = len(results)
                    pdf: bytes | None = None
                    if exported:
                        from .pdfprint import count_pages, merge_pdfs

                        pdf = merge_pdfs([r.pdf for r in results if r.pdf])
                        if pdf:
                            sheets = count_pages(pdf)
                            ctx.note(
                                f"embed-print: merged {exported} page PDFs -> "
                                f"{sheets} sheets"
                            )
                            if sheets != exported:
                                ctx.note(
                                    f"embed-print: WARNING {sheets} sheets for "
                                    f"{exported} pages"
                                )
                    if not pdf:
                        ctx.note("embed-print: no page could be printed")
                        return None

                    return await self._build_document(
                        ctx, fetcher, page_html, results, count, pdf
                    )
                finally:
                    await browser.close()
        except Exception as exc:  # pragma: no cover - browser/env failures
            ctx.note(f"embed-print: failed ({type(exc).__name__}: {exc})"[:200])
            return None

    # -- tabs -------------------------------------------------------------
    async def _open_tab(self, context, url: str, ctx, number: int):
        """Open the embed viewer, strip its chrome and wait for it to settle."""
        label = f"embed-print[w{number}]" if number > 1 else "embed-print"
        try:
            page = await context.new_page()
            await page.goto(url, wait_until="domcontentloaded", timeout=self.timeout)
            await page.wait_for_selector(".outer_page", timeout=45_000)
            prep = await page.evaluate(PREPARE_JS) or {}
            try:
                hidden = await page.evaluate(HIDE_COOKIES_JS)
                if hidden:
                    ctx.note(f"{label}: removed {hidden} cookie/consent element(s)")
            except Exception:
                pass
            await page.evaluate(PRINT_CSS_JS)
            if number == 1:
                ctx.note(
                    "embed-print: toolbars removed "
                    f"({int(bool(prep.get('toolbarTop')))} top, "
                    f"{int(bool(prep.get('toolbarBottom')))} bottom), "
                    f"{prep.get('containers', 0)} scroll container(s) flattened"
                )
            settle = await page.evaluate(
                WAIT_SETTLE_JS, int(self.settle_timeout * 1000)
            ) or {}
            if number == 1:
                ctx.note(
                    "embed-print: render settled"
                    if not settle.get("timedOut")
                    else "embed-print: render settle hit its budget (continuing)"
                )
            return page
        except Exception as exc:
            ctx.note(f"{label}: could not open the viewer ({type(exc).__name__})")
            return None

    async def _load_all_pages(self, page, ctx) -> None:
        """Upstream's optional preload (``--preload-all``)."""
        try:
            loaded = await page.evaluate(
                LOAD_ALL_PAGES_JS,
                {
                    "concurrency": self.page_load_concurrency,
                    "pageTimeoutMs": self.page_load_timeout * 1000,
                    "documentTimeoutMs": self.page_load_timeout * 1000 * 4,
                },
            ) or {}
        except Exception as exc:
            ctx.note(f"embed-print: preload failed ({type(exc).__name__})")
            return
        if not loaded.get("supported"):
            ctx.note("embed-print: window.docManager is unavailable")
            return
        ctx.note(
            f"embed-print: preloaded {loaded.get('loaded', 0)}/"
            f"{loaded.get('total', 0)} pages"
        )
        if loaded.get("failed"):
            nums = ", ".join(
                str(item.get("pageNum")) for item in loaded["failed"][:20]
            )
            ctx.note(f"embed-print: pages that did not load: {nums}")

    # -- printing ---------------------------------------------------------
    async def _export_range(
        self,
        page,
        cdp,
        ctx,
        indices: list[int],
        worker: int,
        workers: int,
    ) -> list["EmbedPageResult"]:
        """Print the pages assigned to this tab, one sheet each."""
        import time

        from .pdfprint import count_pages

        if not indices:
            return []
        label = f"embed-print[w{worker}]" if workers > 1 else "embed-print"
        ctx.note(
            f"{label}: pages {indices[0] + 1}-{indices[-1] + 1} "
            f"({len(indices)} of them)"
        )
        started = time.monotonic()
        results: list[EmbedPageResult] = []
        bad = 0

        for start in range(0, len(indices), self.batch_size):
            batch = indices[start : start + self.batch_size]
            page_numbers = [i + 1 for i in batch]
            try:
                loaded = await page.evaluate(
                    LOAD_PAGE_BATCH_JS,
                    {
                        "pageNumbers": page_numbers,
                        "timeoutMs": self.page_load_timeout * 1000,
                    },
                ) or {}
                if loaded.get("failed"):
                    nums = ", ".join(
                        str(item.get("pageNum")) for item in loaded["failed"][:10]
                    )
                    ctx.note(
                        f"{label}: batch {page_numbers[0]}-{page_numbers[-1]} "
                        f"issues: {nums}"
                    )
            except Exception as exc:
                ctx.note(
                    f"{label}: batch {page_numbers[0]}-{page_numbers[-1]} "
                    f"load failed ({type(exc).__name__})"
                )

            for index in batch:
                info = None
                try:
                    info = await page.evaluate(ISOLATE_PAGE_JS, index)
                except Exception as exc:
                    ctx.note(
                        f"{label}: page {index + 1} isolate failed "
                        f"({type(exc).__name__})"
                    )
                if not info or not info.get("width") or not info.get("height"):
                    bad += 1
                    ctx.note(f"{label}: page {index + 1} skipped (no geometry)")
                    continue

                width_px = int(info["width"])
                height_px = int(info["height"])
                blob = None
                try:
                    blob = await self._print_one(
                        cdp, width_px / 96.0, height_px / 96.0
                    )
                except Exception as exc:
                    ctx.note(
                        f"{label}: page {index + 1} printToPDF failed "
                        f"({type(exc).__name__}: {exc})"[:160]
                    )

                if blob and count_pages(blob) == 1:
                    results.append(
                        EmbedPageResult(
                            index=index,
                            width_px=width_px,
                            height_px=height_px,
                            text=str(info.get("text") or ""),
                            pdf=blob,
                        )
                    )
                else:
                    sheets = count_pages(blob) if blob else 0
                    bad += 1
                    ctx.note(
                        f"{label}: page {index + 1} produced {sheets} sheets "
                        "(expected 1)"
                    )

            try:
                await page.evaluate(RELEASE_PAGE_BATCH_JS, page_numbers)
            except Exception:
                pass
            try:
                await cdp.send("HeapProfiler.collectGarbage")
            except Exception:
                pass

        elapsed = time.monotonic() - started
        rate = (len(results) / elapsed) if elapsed > 0 else 0.0
        ctx.note(
            f"{label}: done — {len(results)}/{len(indices)} pages in "
            f"{elapsed:.1f}s ({rate:.1f} pages/s)"
            + (f", {bad} failed" if bad else "")
        )
        return results

    @staticmethod
    async def _print_one(cdp, width_in: float, height_in: float) -> bytes:
        """CDP Page.printToPDF with upstream's exact options: one sheet."""
        await cdp.send("Emulation.setEmulatedMedia", {"media": "print"})
        result = await cdp.send(
            "Page.printToPDF",
            {
                "landscape": False,
                "displayHeaderFooter": False,
                "printBackground": True,
                "scale": 1,
                "paperWidth": width_in,
                "paperHeight": height_in,
                "marginTop": 0,
                "marginBottom": 0,
                "marginLeft": 0,
                "marginRight": 0,
                "preferCSSPageSize": True,
                "pageRanges": "1",
                "transferMode": "ReturnAsBase64",
            },
        )
        return base64.b64decode(result["data"])

    # -- result -----------------------------------------------------------
    async def _build_document(
        self,
        ctx,
        fetcher,
        page_html: str,
        results: list[EmbedPageResult],
        total: int,
        pdf: bytes,
    ) -> ScrapedDocument:
        from .extractors import extract_meta, fetch_oembed

        meta = extract_meta(page_html or "", ctx.url, ctx.doc_id, ctx.kind)
        pages = [Page(number=r.index + 1, text=r.text) for r in results]
        meta.page_count = max(total, len(pages))

        # The embed viewer's <title> is usually just "Scribd"; ask oEmbed.
        if not meta.title or meta.title.strip().lower() == "scribd":
            try:
                oembed = await fetch_oembed(fetcher, ctx.url)
            except Exception:
                oembed = {}
            meta.title = str(oembed.get("title") or "") or meta.title
            if not meta.author:
                meta.author = str(oembed.get("author_name") or "")

        complete = bool(total) and len(pages) == total
        if not complete:
            ctx.note(f"embed-print: PARTIAL {len(pages)}/{meta.page_count} pages")
        return ScrapedDocument(
            meta=meta,
            pages=pages,
            strategy=self.name,
            pdf=pdf,
            complete=complete,
        )


def _split_range(count: int, workers: int) -> list[list[int]]:
    """Contiguous 0-based page indices, one list per worker."""
    workers = max(1, min(workers, count))
    base, extra = divmod(count, workers)
    chunks: list[list[int]] = []
    start = 0
    for worker in range(workers):
        size = base + (1 if worker < extra else 0)
        if not size:
            continue
        chunks.append(list(range(start, start + size)))
        start += size
    return chunks
