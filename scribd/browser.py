"""Browser route: drive a real Chromium to get the whole document.

Why this exists: Scribd **lazy-loads** the viewer. Page images for later
pages are not in the initial HTML — the frontend injects them as the reader
scrolls. Any static request (however good its regexes) can only ever see the
first couple of pages. A real browser plus an incremental scroll puts all
95 pages into the DOM, and then both routes work:

* every page's text is read straight from the rendered DOM, and
* every page image URL is harvested and merged into one PDF.

Optional dependency (nothing is imported at module import time):

    pip install playwright
    playwright install chromium

When Playwright is missing the strategy reports it and returns None, so the
rest of the chain is unaffected.
"""
from __future__ import annotations

from .models import Page, ScrapedDocument

# Ordered most-specific first. `.outer_page` was observed 95x on a 95-page
# document; `.newpage`/`.text_layer` are fallbacks if the markup changes.
PAGE_SELECTORS = ("div.outer_page", "div.newpage", "div.text_layer", "div.page")

# Scroll every scrollable element (Scribd puts the reader in its own pane,
# so window.scrollTo alone does not move it), then report what we reached.
SCROLL_JS = """
async (maxSteps) => {
  const scrollables = () => {
    const els = [document.scrollingElement || document.documentElement];
    for (const el of document.querySelectorAll('div, section, main')) {
      const st = getComputedStyle(el);
      const scrollable = /(auto|scroll)/.test(st.overflowY);
      if (scrollable && el.scrollHeight > el.clientHeight + 200) els.push(el);
    }
    return els;
  };
  let stable = 0;
  let lastTotal = -1;
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    let total = 0;
    for (const el of scrollables()) {
      const step = Math.max(200, Math.round(el.clientHeight * 0.85));
      el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight);
      total += el.scrollHeight;
    }
    window.scrollBy(0, Math.round(window.innerHeight * 0.85));
    await new Promise(r => setTimeout(r, 300));
    if (total === lastTotal) {
      if (++stable >= 4) break;
    } else {
      stable = 0;
      lastTotal = total;
    }
  }
  // Let the last batch of images settle.
  await new Promise(r => setTimeout(r, 800));
  return {
    steps,
    height: lastTotal,
    pages: document.querySelectorAll(
      'div.outer_page, div.newpage, div.text_layer, div.page'
    ).length,
    images: document.querySelectorAll('img').length,
  };
}
"""

# Per page: its text and its image URL(s), straight from the live DOM.
COLLECT_JS = """
(selectors) => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
  const pickImages = (el) => Array.from(el.querySelectorAll('img'))
    .map(i => abs(i.currentSrc || i.src || ''))
    .filter(u => u && !u.startsWith('data:'));
  for (const sel of selectors) {
    const els = Array.from(document.querySelectorAll(sel));
    if (els.length) {
      return {
        selector: sel,
        items: els.map(e => ({
          text: (e.innerText || '').trim(),
          images: pickImages(e),
        })),
      };
    }
  }
  const body = document.body ? (document.body.innerText || '').trim() : '';
  return {
    selector: 'body',
    items: body ? [{
      text: body,
      images: Array.from(document.images).map(i => abs(i.currentSrc || i.src || '')),
    }] : [],
  };
}
"""


def clean_pages(texts: list[str], *, min_words: int = 2) -> list[Page]:
    """Number and filter captured page texts (pure, so it is testable)."""
    pages: list[Page] = []
    for text in texts:
        text = (text or "").strip()
        if len(text.split()) < min_words:
            continue
        pages.append(Page(number=len(pages) + 1, text=text))
    return pages


def dom_items_to_pages(
    items: list[dict], *, min_words: int = 2
) -> list[Page]:
    """Turn {text, images} DOM items into numbered pages.

    Pure function: keeps numbering/filtering testable without a browser.
    A page is kept when it has text OR at least one image, so image-only
    (scanned) pages still end up in the PDF.
    """
    pages: list[Page] = []
    for item in items or []:
        text = str(item.get("text") or "").strip()
        images = [str(u) for u in (item.get("images") or []) if u]
        words = len(text.split())
        if words < min_words and not images:
            continue
        pages.append(
            Page(
                number=len(pages) + 1,
                text=text if words >= min_words else "",
                image_url=images[0] if images else None,
            )
        )
    return pages


class BrowserStrategy:
    """Render the document in Chromium, auto-scroll it, capture everything."""

    name = "browser"

    def __init__(self, *, max_steps: int = 400, timeout: float = 60_000) -> None:
        self.max_steps = max_steps
        self.timeout = timeout

    async def run(self, ctx, fetcher) -> ScrapedDocument | None:
        try:
            from playwright.async_api import async_playwright  # type: ignore
        except Exception:
            ctx.note(
                "browser: playwright not installed "
                "(pip install playwright && playwright install chromium)"
            )
            return None

        cookies = {}
        try:
            cookies = dict(getattr(fetcher, "cookies", {}) or {})
        except Exception:
            cookies = {}

        ctx.note("browser: launching Chromium to load and scroll the document…")
        items: list[dict] = []
        selector = ""
        printed_pdf: bytes | None = None
        scroll_stats: dict = {}

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
                    await page.goto(ctx.url, wait_until="domcontentloaded", timeout=self.timeout)
                    try:
                        await page.wait_for_selector(
                            ", ".join(PAGE_SELECTORS), timeout=20_000
                        )
                    except Exception:
                        ctx.note("browser: no page containers appeared (continuing)")

                    scroll_stats = await page.evaluate(SCROLL_JS, self.max_steps) or {}
                    ctx.note(
                        "browser: scrolled "
                        f"{scroll_stats.get('steps', '?')} steps, "
                        f"{scroll_stats.get('pages', '?')} page containers, "
                        f"{scroll_stats.get('images', '?')} images in DOM"
                    )

                    result = await page.evaluate(COLLECT_JS, list(PAGE_SELECTORS)) or {}
                    items = result.get("items") or []
                    selector = str(result.get("selector") or "")

                    try:
                        printed_pdf = await page.pdf(
                            format="A4",
                            print_background=True,
                            margin={
                                "top": "10mm",
                                "bottom": "10mm",
                                "left": "8mm",
                                "right": "8mm",
                            },
                        )
                    except Exception as exc:
                        ctx.note(f"browser: print-to-PDF failed ({type(exc).__name__})")
                finally:
                    await browser.close()
        except Exception as exc:
            ctx.note(f"browser: {type(exc).__name__}: {str(exc)[:120]}")
            return None

        pages = dom_items_to_pages(items)
        if not pages:
            ctx.note("browser: nothing captured after scrolling")
            return None
        ctx.note(f"browser: {len(pages)} pages via '{selector}'")

        # Prefer a PDF built from the page images (higher fidelity and it
        # includes pages whose text layer is empty). Fall back to the
        # browser's own print output.
        pdf = await self._pdf_from_images(ctx, fetcher, pages)
        if pdf:
            ctx.note("browser: PDF assembled from page images")
        elif printed_pdf:
            pdf = printed_pdf
            ctx.note("browser: PDF from browser print (image merge unavailable)")

        from .extractors import extract_meta

        meta = extract_meta("", ctx.url, ctx.doc_id, ctx.kind)
        meta.page_count = meta.page_count or len(pages)
        await self._fill_meta(ctx, fetcher, meta)

        complete = bool(meta.page_count) and len(pages) >= meta.page_count * 0.9
        return ScrapedDocument(
            meta=meta,
            pages=pages,
            strategy=self.name,
            pdf=pdf,
            complete=complete,
        )

    async def _fill_meta(self, ctx, fetcher, meta) -> None:
        try:
            from .extractors import fetch_oembed

            oembed = await fetch_oembed(fetcher, ctx.url)
        except Exception:
            return
        placeholder = meta.title in ("", f"scribd_{ctx.doc_id}") or (
            meta.title.strip().lower() == "scribd"
        )
        if oembed.get("title") and placeholder:
            meta.title = str(oembed["title"])
        if oembed.get("author_name") and not meta.author:
            meta.author = str(oembed["author_name"])

    async def _pdf_from_images(self, ctx, fetcher, pages: list[Page]) -> bytes | None:
        """Download each page's image through the shared fetcher, merge."""
        import asyncio

        from .fetch import _images_to_pdf

        targets = [(p.number, p.image_url) for p in pages if p.image_url]
        if len(targets) < 2:
            return None

        sem = asyncio.Semaphore(6)
        failures: dict[str, int] = {}

        async def one(number: int, url: str) -> bytes | None:
            async with sem:
                for attempt in range(3):
                    try:
                        resp = await fetcher.get(url, headers={"Referer": ctx.url})
                    except Exception as exc:
                        if attempt == 2:
                            key = f"exception:{type(exc).__name__}"
                            failures[key] = failures.get(key, 0) + 1
                        else:
                            await asyncio.sleep(0.5 * (attempt + 1))
                        continue
                    if resp.status_code == 200 and resp.content:
                        if b"<html" not in resp.content[:200].lower():
                            return resp.content
                        failures["html-response"] = failures.get("html-response", 0) + 1
                        return None
                    if attempt == 2:
                        key = f"http:{resp.status_code}"
                        failures[key] = failures.get(key, 0) + 1
                    else:
                        await asyncio.sleep(0.5 * (attempt + 1))
            return None

        raw = await asyncio.gather(
            *(one(n, u) for n, u in targets), return_exceptions=True
        )
        blobs = [b for b in raw if isinstance(b, (bytes, bytearray)) and b]
        if failures:
            detail = ", ".join(f"{k} x{v}" for k, v in sorted(failures.items()))
            ctx.note(f"browser: image failures — {detail}")
        if len(blobs) < 2:
            return None
        skipped: list[int] = []
        pdf = _images_to_pdf(list(blobs), skipped=skipped)
        if skipped:
            ctx.note(f"browser: skipped {len(skipped)} unreadable image(s)")
        if pdf:
            ctx.note(f"browser: merged {len(blobs)} images into a PDF")
        return pdf
