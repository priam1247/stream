"""Browser route: render the document and capture every page, one by one.

Why this exists: Scribd **lazy-loads** the viewer. Page images for later
pages are not in the initial HTML — the frontend injects them as the reader
scrolls. Static requests therefore only ever see the first pages, and even a
browser needs to scroll *each* page into view before it renders.

The previous version scrolled the window and watched ``scrollHeight``, which
Scribd's virtualised viewer never changes: it stopped after 4 steps, captured
15 of 95 pages, and the image URLs it harvested were lazy placeholders that
returned HTML ("html-response x11"), so only 3 pages made it into the PDF.

This version walks the page containers **one at a time**:

    for each container i:
        scroll container i into view
        wait for its <img> to actually decode (complete && naturalWidth > 0)
        read its text from the DOM
        screenshot the element  ->  a guaranteed image of that page

The screenshots do not depend on CDN tokens, subdomains or hotlink rules, so
the PDF is assembled from what the logged-in user can genuinely see.

Optional dependency (nothing is imported at module import time):

    pip install playwright
    playwright install chromium
"""
from __future__ import annotations

from .models import Page, ScrapedDocument

# Ordered most-specific first. `.outer_page` was observed 124x on a 95-page
# document (it wraps each page, sometimes with extra wrappers); duplicates are
# removed by content in `dedupe_entries`.
PAGE_SELECTORS = ("div.outer_page", "div.newpage", "div.page", "div.text_layer")

# Scroll every page into view until the number of page containers stops
# growing. Adapted from youngpiu/scribd-pdf-downloader, which scrolls with
# scrollIntoView (block: center) rather than window.scrollBy — Scribd's
# viewer is virtualised, so scrollHeight never changes and a height-based
# stop fires after a few steps (observed: "scrolled 4 steps", 15/95 pages).
SCROLL_PAGES_JS = """
async (args) => {
  const {selectors, delayMs} = args;
  const pick = () => {
    for (const sel of selectors) {
      if (document.querySelector(sel)) return sel;
    }
    return null;
  };
  let sel = pick();
  if (!sel) return {selector: null, pages: 0, rounds: 0};
  let seen = 0, stable = 0, rounds = 0;
  while (stable < 2 && rounds < 200) {
    rounds++;
    const els = Array.from(document.querySelectorAll(sel));
    if (!els.length) break;
    for (let i = seen; i < els.length; i++) {
      els[i].scrollIntoView({behavior: 'instant', block: 'center'});
      await new Promise(r => setTimeout(r, delayMs));
    }
    seen = els.length;
    const now = document.querySelectorAll(sel).length;
    stable = (now === seen) ? stable + 1 : 0;
  }
  return {selector: sel, pages: document.querySelectorAll(sel).length, rounds};
}
"""

# 2) Print preparation + CSS (ported from youngpiu/scribd-pdf-downloader):
#    hide toolbars, flatten the scroller, @page sized to the paper.
PRINT_JS = """
(config) => {
  const {widthIn, heightIn} = config;
  const styleId = 'scribd-print-styles';
  const existing = document.getElementById(styleId);
  if (existing) existing.remove();

  document.querySelectorAll('.toolbar_top, .toolbar_bottom').forEach(el => {
    el.style.display = 'none';
  });
  document.querySelectorAll('.document_scroller').forEach(el => {
    el.setAttribute('data-scribd-print-root', 'true');
  });

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    @media print {
      @page { size: ${widthIn.toFixed(3)}in ${heightIn.toFixed(3)}in; margin: 0; }
      html, body { margin: 0 !important; padding: 0 !important;
                   -webkit-print-color-adjust: exact !important;
                   print-color-adjust: exact !important; }
      .toolbar_top, .toolbar_bottom { display: none !important; }
      .document_scroller, [data-scribd-print-root="true"] {
        position: static !important; overflow: visible !important;
        height: auto !important; max-height: none !important; margin: 0 !important;
      }
      .outer_page_container, .newpage_container {
        margin: 0 !important; padding: 0 !important; height: auto !important;
      }
      .outer_page_container > *:not(.outer_page),
      .newpage_container > *:not(.newpage) { display: none !important; }
      .outer_page, .newpage {
        margin: 0 !important; break-inside: avoid !important;
        page-break-inside: avoid !important; break-after: page !important;
      }
      [class*="cookie"], [class*="consent"], [id*="osano"], [class*="osano"] {
        display: none !important;
      }
    }
  `;
  document.head.appendChild(style);

  // Measure the paper (96 CSS px per inch).
  const candidates = ['.outer_page', '.newpage', 'div.page'];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 50 && r.height > 50) {
      return {widthIn: r.width / 96, heightIn: (r.height / 96) + 0.04};
    }
  }
  return {widthIn: widthIn, heightIn: heightIn};
}
"""

# Read one container: its text and its best image URL / readiness.
PAGE_INFO_JS = """
(el) => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
  const imgs = Array.from(el.querySelectorAll('img'));
  let best = '', bestArea = 0, ready = false;
  for (const img of imgs) {
    const src = img.currentSrc || img.src || '';
    if (!src || src.startsWith('data:')) continue;
    const area = (img.naturalWidth || 0) * (img.naturalHeight || 0);
    if (area > bestArea) {
      bestArea = area;
      best = abs(src);
      ready = !!(img.complete && img.naturalWidth > 0);
    }
  }
  return {
    text: (el.innerText || '').trim(),
    image: best,
    imageReady: ready,
    width: el.scrollWidth,
    height: el.scrollHeight,
    rectHeight: Math.round(el.getBoundingClientRect().height),
  };
}
"""


def dedupe_entries(entries: list[dict], *, min_words: int = 2) -> list[dict]:
    """Drop empty/duplicate page captures and keep document order.

    Scribd's DOM contains extra wrappers for the same page (124 containers
    for a 95-page document), so identical text+image captures are collapsed.
    Pure function, so it is testable without a browser.
    """
    seen: set[str] = set()
    out: list[dict] = []
    for entry in entries or []:
        text = str(entry.get("text") or "").strip()
        image = str(entry.get("image") or "")
        shot = entry.get("screenshot")
        words = len(text.split())
        if words < min_words and not shot:
            continue
        key = f"{text[:200]}|{image}"
        if key in seen:
            continue
        seen.add(key)
        out.append(entry)
    return out


def entries_to_pages(entries: list[dict]) -> list[Page]:
    """Number the captures; keep the text and the image reference."""
    pages: list[Page] = []
    for entry in entries or []:
        pages.append(
            Page(
                number=len(pages) + 1,
                text=str(entry.get("text") or "").strip(),
                image_url=str(entry.get("image") or "") or None,
            )
        )
    return pages


def screenshots_of(entries: list[dict]) -> list[bytes]:
    """Image blobs for the PDF, in page order."""
    return [
        e["screenshot"]
        for e in entries or []
        if isinstance(e.get("screenshot"), (bytes, bytearray)) and e["screenshot"]
    ]


def clean_pages(texts: list[str], *, min_words: int = 2) -> list[Page]:
    """Number and filter captured page texts (pure, so it is testable)."""
    pages: list[Page] = []
    for text in texts:
        text = (text or "").strip()
        if len(text.split()) < min_words:
            continue
        pages.append(Page(number=len(pages) + 1, text=text))
    return pages


class BrowserStrategy:
    """Render in Chromium, visit every page container, capture text + image."""

    name = "browser"

    def __init__(
        self,
        *,
        max_pages: int = 1000,
        settle_ms: int = 150,
        image_wait_ms: int = 4000,
        timeout: float = 60_000,
        screenshot: bool = False,
        # Print-to-PDF gives a vector PDF with selectable text and is far
        # faster than screenshotting every page; screenshots remain a
        # fallback for when printing is unavailable.
    ) -> None:
        self.max_pages = max_pages
        self.settle_ms = settle_ms
        self.image_wait_ms = image_wait_ms
        self.timeout = timeout
        self.screenshot = screenshot

    async def run(self, ctx, fetcher) -> ScrapedDocument | None:
        try:
            from playwright.async_api import async_playwright  # type: ignore
        except Exception:
            ctx.note(
                "browser: playwright not installed "
                "(pip install playwright && playwright install chromium)"
            )
            return None

        try:
            cookies = dict(getattr(fetcher, "cookies", {}) or {})
        except Exception:
            cookies = {}

        entries: list[dict] = []
        selector = ""
        page_html = ""
        printed_pdf: bytes | None = None

        try:
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(headless=True)
                try:
                    context = await browser.new_context(
                        user_agent=(
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/124.0.0.0 Safari/537.36"
                        ),
                        viewport={"width": 1280, "height": 1400},
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
                    page = await context.new_page()
                    await page.goto(
                        ctx.url, wait_until="domcontentloaded", timeout=self.timeout
                    )
                    try:
                        await page.wait_for_selector(
                            ", ".join(PAGE_SELECTORS), timeout=30_000
                        )
                    except Exception:
                        ctx.note("browser: no page containers appeared")
                        return None

                    # 1) Force every page into the DOM by scrolling each one
                    #    into view until the container count stabilises.
                    try:
                        stats = await page.evaluate(
                            SCROLL_PAGES_JS,
                            {
                                "selectors": list(PAGE_SELECTORS),
                                "delayMs": self.settle_ms,
                            },
                        ) or {}
                        ctx.note(
                            f"browser: scroll pass done — "
                            f"{stats.get('pages', '?')} containers "
                            f"({stats.get('rounds', '?')} rounds)"
                        )
                        if stats.get("selector"):
                            selector = str(stats["selector"])
                    except Exception as exc:
                        ctx.note(f"browser: scroll pass failed ({type(exc).__name__})")

                    if not selector:
                        selector = await self._pick_selector(page, ctx)
                    if not selector:
                        return None

                    entries = await self._capture_pages(page, ctx, selector)
                    page_html = await page.content()

                    # 2) Prepare print CSS and print the whole document. This
                    #    yields a real PDF with selectable text, sized to the
                    #    document's own page, instead of stitched screenshots.
                    try:
                        paper = await page.evaluate(
                            PRINT_JS,
                            {
                                "widthIn": 8.5,
                                "heightIn": 11.0,
                            },
                        ) or {}
                        width = float(paper.get("widthIn") or 8.5)
                        height = float(paper.get("heightIn") or 11.0)
                        printed_pdf = await page.pdf(
                            print_background=True,
                            prefer_css_page_size=True,
                            width=f"{width:.3f}in",
                            height=f"{height:.3f}in",
                            margin={
                                "top": "0",
                                "bottom": "0",
                                "left": "0",
                                "right": "0",
                            },
                        )
                    except Exception as exc:
                        ctx.note(f"browser: print-to-PDF failed ({type(exc).__name__})")
                        try:
                            printed_pdf = await page.pdf(
                                format="A4", print_background=True
                            )
                        except Exception:
                            printed_pdf = None
                finally:
                    await browser.close()
        except Exception as exc:
            ctx.note(f"browser: {type(exc).__name__}: {str(exc)[:120]}")
            return None

        entries = dedupe_entries(entries)
        if not entries:
            ctx.note("browser: nothing captured")
            return None

        pages = entries_to_pages(entries)
        shots = screenshots_of(entries)
        ctx.note(
            f"browser: captured {len(pages)} pages via '{selector}' "
            f"({len(shots)} screenshots, "
            f"{sum(1 for e in entries if e.get('image'))} image URLs)"
        )

        from .extractors import extract_meta, extract_page_count, fetch_oembed

        meta = extract_meta(page_html or "", ctx.url, ctx.doc_id, ctx.kind)
        total = extract_page_count(page_html or "") or meta.page_count or len(pages)
        meta.page_count = max(total, len(pages))

        # Real title/author: the viewer's <title>/og:title is often "Scribd".
        placeholder = meta.title in ("", f"scribd_{ctx.doc_id}") or (
            meta.title.strip().lower() == "scribd"
        )
        oembed = {}
        try:
            oembed = await fetch_oembed(fetcher, ctx.url)
        except Exception:
            pass
        if placeholder and oembed.get("title"):
            meta.title = str(oembed["title"])
        if not meta.author and oembed.get("author_name"):
            meta.author = str(oembed["author_name"])

        pdf: bytes | None = None
        if printed_pdf and printed_pdf.startswith(b"%PDF"):
            pdf = printed_pdf
            ctx.note(f"browser: PDF from browser print ({len(printed_pdf):,} bytes)")
        if not pdf and len(shots) >= 2:
            from .fetch import _images_to_pdf

            skipped: list[int] = []
            pdf = _images_to_pdf(list(shots), skipped=skipped)
            if skipped:
                ctx.note(f"browser: skipped {len(skipped)} unreadable screenshot(s)")
            if pdf:
                ctx.note(f"browser: PDF from {len(shots)} page screenshots")


        complete = bool(meta.page_count) and len(pages) >= meta.page_count * 0.9
        if not complete:
            ctx.note(f"browser: PARTIAL {len(pages)}/{meta.page_count} pages")
        return ScrapedDocument(
            meta=meta,
            pages=pages,
            strategy=self.name,
            pdf=pdf,
            complete=complete,
        )

    async def _pick_selector(self, page, ctx) -> str:
        """Choose the selector that yields the most plausible page elements."""
        best, best_n = "", 0
        for sel in PAGE_SELECTORS:
            try:
                n = await page.locator(sel).count()
            except Exception:
                continue
            if n > best_n:
                best, best_n = sel, n
        if best:
            ctx.note(f"browser: '{best}' matched {best_n} containers")
        return best

    async def _capture_pages(self, page, ctx, selector: str) -> list[dict]:
        """Walk the containers one by one: scroll, wait for image, capture."""
        entries: list[dict] = []
        index = 0
        attempts_without_growth = 0
        count = await self._count(page, selector)

        while index < min(count, self.max_pages) and len(entries) < self.max_pages:
            loc = page.locator(selector).nth(index)
            try:
                await loc.scroll_into_view_if_needed(timeout=5000)
            except Exception:
                # Virtualised lists can recycle nodes; skip and move on.
                index += 1
                continue
            await page.wait_for_timeout(self.settle_ms)

            # Give the page image a chance to decode before we read it.
            try:
                await loc.locator("img").first.evaluate(
                    """img => new Promise(res => {
                        if (img.complete && img.naturalWidth > 0) return res(true);
                        const done = () => res(true);
                        img.addEventListener('load', done, {once: true});
                        img.addEventListener('error', done, {once: true});
                        setTimeout(() => res(false), %d);
                    })"""
                    % self.image_wait_ms
                )
            except Exception:
                pass

            try:
                info = await loc.evaluate(PAGE_INFO_JS)
            except Exception:
                index += 1
                continue
            info = info or {}
            entry = {
                "text": str(info.get("text") or "").strip(),
                "image": str(info.get("image") or ""),
                "index": index,
            }

            if self.screenshot:
                try:
                    entry["screenshot"] = await loc.screenshot(
                        timeout=10_000, animations="disabled", caret="hide"
                    )
                except Exception:
                    pass

            entries.append(entry)
            index += 1

            if index % 10 == 0:
                ctx.note(f"browser: captured {len(entries)} pages…")

            new_count = await self._count(page, selector)
            if new_count <= count:
                attempts_without_growth += 1
            else:
                attempts_without_growth = 0
            count = max(count, new_count)
            if attempts_without_growth > 40 and index >= count:
                break

        return entries

    @staticmethod
    async def _count(page, selector: str) -> int:
        try:
            return await page.locator(selector).count()
        except Exception:
            return 0
