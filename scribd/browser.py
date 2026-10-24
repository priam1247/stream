"""Browser route: drive a real Chromium to get the whole document.

Why this exists as a separate strategy: the HTTP routes depend on Scribd's
asset URLs staying fetchable (tokens, CDN subdomains, bot checks). A real
browser has none of those problems — it renders exactly what the logged-in
user sees, including pages that are lazy-loaded by JavaScript.

Optional dependency (the module imports nothing at import time):

    pip install playwright
    playwright install chromium

If Playwright is missing the strategy simply reports it and returns None, so
the rest of the chain is unaffected.
"""
from __future__ import annotations

from .models import Page, ScrapedDocument

# Ordered most-specific first. `.outer_page` was observed 95x on a 95-page
# document; `.newpage`/`.text_layer` are fallbacks if the markup changes.
PAGE_SELECTORS = ("div.outer_page", "div.newpage", "div.text_layer", "div.page")

COLLECT_JS = """
(selectors) => {
  for (const sel of selectors) {
    const els = Array.from(document.querySelectorAll(sel));
    if (els.length) {
      return {selector: sel, pages: els.map(e => (e.innerText || '').trim())};
    }
  }
  const body = document.body ? (document.body.innerText || '') : '';
  return {selector: 'body', pages: body.trim() ? [body] : []};
}
"""

SCROLL_JS = """
async () => {
  const step = Math.round(window.innerHeight * 0.9);
  let last = -1, stable = 0;
  for (let i = 0; i < 400; i++) {
    window.scrollBy(0, step);
    await new Promise(r => setTimeout(r, 220));
    const h = document.body ? document.body.scrollHeight : 0;
    if (h === last) { if (++stable >= 3) break; } else { stable = 0; last = h; }
  }
  window.scrollTo(0, 0);
  return last;
}
"""


def clean_pages(texts: list[str], *, min_words: int = 2) -> list[Page]:
    """Number and filter captured page texts (kept pure so it is testable)."""
    pages: list[Page] = []
    for text in texts:
        text = (text or "").strip()
        if len(text.split()) < min_words:
            continue
        pages.append(Page(number=len(pages) + 1, text=text))
    return pages


class BrowserStrategy:
    """Render the document in Chromium and capture text + a print PDF."""

    name = "browser"

    async def run(self, ctx, fetcher) -> ScrapedDocument | None:
        try:
            from playwright.async_api import async_playwright  # type: ignore
        except Exception:
            ctx.note(
                "browser: playwright not installed "
                "(pip install playwright && playwright install chromium)"
            )
            return None

        cookies = getattr(fetcher, "cookies", {}) or {}
        want_pdf = True
        try:
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(headless=True)
                try:
                    context = await browser.new_context(
                        locale="en-US",
                        viewport={"width": 1280, "height": 2000},
                    )
                    if cookies:
                        await context.add_cookies(
                            [
                                {
                                    "name": k,
                                    "value": v,
                                    "domain": ".scribd.com",
                                    "path": "/",
                                }
                                for k, v in cookies.items()
                            ]
                        )
                    page = await context.new_page()
                    await page.goto(ctx.url, wait_until="domcontentloaded", timeout=60000)
                    try:
                        await page.wait_for_selector(
                            ", ".join(PAGE_SELECTORS), timeout=20000
                        )
                    except Exception:
                        ctx.note("browser: no page containers appeared")
                    await page.evaluate(SCROLL_JS)
                    result = await page.evaluate(COLLECT_JS, list(PAGE_SELECTORS))
                    pages = clean_pages(result.get("pages") or [])
                    pdf: bytes | None = None
                    if want_pdf:
                        try:
                            pdf = await page.pdf(
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

        if not pages and not pdf:
            ctx.note("browser: nothing captured")
            return None
        ctx.note(
            f"browser: {len(pages)} pages via '{result.get('selector')}'"
            f"{', + PDF' if pdf else ''}"
        )
        from .extractors import extract_meta

        meta = extract_meta("", ctx.url, ctx.doc_id, ctx.kind)
        meta.page_count = meta.page_count or len(pages)
        return ScrapedDocument(
            meta=meta,
            pages=pages,
            strategy=self.name,
            pdf=pdf,
            complete=bool(pages) and len(pages) >= max(1, meta.page_count * 0.9),
        )
