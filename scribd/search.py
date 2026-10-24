"""Find Scribd documents from a keyword — no link required.

The download chain needs a document URL, so this module turns

    excel

into real document URLs:

0. **A real browser.** Scribd's search page is a JavaScript app: the HTTP
   response is a shell with no result links in it, which is why the first
   version found "0 result(s)" on a page that shows twenty results in Chrome.
   :func:`browser_search` therefore opens
   ``https://www.scribd.com/search?query=excel`` in headless Chromium (with the
   user's cookies), waits for the result cards, scrolls to load more, and
   reads the document links out of the live DOM. It tries a few known search
   URL shapes and keeps the first that renders results.
1. ``GET https://www.scribd.com/search?query=excel&page=1`` (with the user's
   cookies, through the same :class:`~scribd.http.Fetcher`) as the fast path,
   for when Scribd does server-render the links.
2. Parse the result page for document links
   (``/document/<id>/<slug>``, ``/presentation/<id>/...``,
   ``/spreadsheet/<id>/...``, ``/ebook/<id>/...``). The anchor's ``title`` /
   ``aria-label`` wins, then its text, then the image ``alt``, then the slug.
3. If the page carries the results only as inline JSON (Scribd renders some
   views client-side), fall back to pairing ``"documentId": <id>`` with the
   nearest ``"title": "..."``.
4. Keep document order, drop duplicates (the same document appears as a
   thumbnail, a title link and a "Save" link on one page), and stop at the
   requested number of hits.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from urllib.parse import quote_plus, unquote

from bs4 import BeautifulSoup

SEARCH_URL = "https://www.scribd.com/search?query={query}&page={page}"

# Scribd has shipped several search URLs; use whichever renders results.
SEARCH_VARIANTS = (
    "https://www.scribd.com/search?query={query}&page={page}",
    "https://www.scribd.com/search?query={query}&content_type=documents&page={page}",
    "https://www.scribd.com/search/documents?query={query}&page={page}",
)

# `/document/123/Slug`, legacy `/doc/123/Slug`, and the other content types.
DOC_HREF_RE = re.compile(
    r"/(document|doc|presentation|spreadsheet|ebook|audiobook|magazine)"
    r"/(\d{3,})(?:/([^/?#\"']*))?",
    re.I,
)
KIND_ALIASES = {"doc": "document"}
GENERIC_TITLES = {
    "download", "save", "read more", "read", "scribd", "upload", "share",
    "open", "view", "preview", "see all", "more",
}


@dataclass
class SearchHit:
    """One document found by a search."""

    doc_id: str
    kind: str = "document"
    slug: str = ""
    title: str = ""

    @property
    def url(self) -> str:
        slug = self.slug or f"Scribd-{self.doc_id}"
        return f"https://www.scribd.com/{self.kind}/{self.doc_id}/{slug}"

    def to_dict(self) -> dict:
        return {
            "doc_id": self.doc_id,
            "kind": self.kind,
            "title": self.title,
            "url": self.url,
        }


def search_url(query: str, page: int = 1) -> str:
    """Scribd search URL for ``query`` (percent-encoded, never raw spaces)."""
    return SEARCH_URL.format(
        query=quote_plus((query or "").strip()), page=max(1, int(page))
    )


def _slug_title(slug: str, doc_id: str) -> str:
    if not slug:
        return f"scribd_{doc_id}"
    text = unquote(slug).replace("-", " ").replace("_", " ")
    text = " ".join(text.split())
    return text or f"scribd_{doc_id}"


def _is_generic(title: str) -> bool:
    return title.strip().lower() in GENERIC_TITLES or len(title.strip()) < 3


def parse_search_results(html: str, *, limit: int = 0) -> list[SearchHit]:
    """Document links in ``html``, in page order, deduplicated by document id.

    Titles are improved as duplicates are found: an anchor that only carries a
    thumbnail gets the title of a later, text-bearing anchor for the same id.
    """
    hits: list[SearchHit] = []
    by_id: dict[str, SearchHit] = {}
    soup = BeautifulSoup(html or "", "lxml")

    for anchor in soup.find_all("a", href=True):
        match = DOC_HREF_RE.search(str(anchor.get("href") or ""))
        if not match:
            continue
        kind = KIND_ALIASES.get(match.group(1).lower(), match.group(1).lower())
        doc_id = match.group(2)
        slug = (match.group(3) or "").strip()

        title = ""
        for attr in ("title", "aria-label", "data-title"):
            value = (anchor.get(attr) or "").strip()
            if not _is_generic(value):
                title = value
                break
        if not title:
            text = " ".join((anchor.get_text(" ") or "").split())
            if not _is_generic(text) and len(text) <= 300:
                title = text
        if not title:
            image = anchor.find("img")
            if image is not None:
                alt = (image.get("alt") or "").strip()
                if not _is_generic(alt):
                    title = alt
        if not title:
            title = _slug_title(slug, doc_id)

        seen = by_id.get(doc_id)
        if seen is not None:
            if len(title) > len(seen.title) and not _is_generic(title):
                seen.title = title
            if not seen.slug and slug:
                seen.slug = slug
            continue

        hit = SearchHit(doc_id=doc_id, kind=kind, slug=slug, title=title)
        by_id[doc_id] = hit
        hits.append(hit)
        if limit and len(hits) >= limit:
            break

    if not hits:
        hits = _results_from_json(html or "", limit=limit)
    return hits[:limit] if limit else hits


# `"documentId": 1234567890` / `"document_id":"1234567890"` next to a title.
_JSON_ID_RE = re.compile(
    r'"(?:document_?id|docId|contentId)"\s*:\s*"?(\d{3,})"?', re.I
)
_JSON_TITLE_RE = re.compile(r'"title"\s*:\s*"((?:[^"\\]|\\.){3,300})"')


def _results_from_json(html: str, *, limit: int = 0) -> list[SearchHit]:
    """Fallback for pages whose results only exist as inline JSON."""
    hits: list[SearchHit] = []
    seen: set[str] = set()
    for match in _JSON_ID_RE.finditer(html):
        doc_id = match.group(1)
        if doc_id in seen:
            continue
        window = html[match.start() : match.start() + 800]
        title_match = _JSON_TITLE_RE.search(window)
        title = ""
        if title_match:
            try:
                title = json.loads(f'"{title_match.group(1)}"')
            except Exception:
                title = title_match.group(1)
        title = " ".join((title or "").split()) or _slug_title("", doc_id)
        seen.add(doc_id)
        hits.append(SearchHit(doc_id=doc_id, title=title))
        if limit and len(hits) >= limit:
            break
    return hits


# --- real browser search ---------------------------------------------------
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

COUNT_LINKS_JS = """() => document.querySelectorAll('a[href*="/document/"]').length"""

# Close cookie/consent overlays so they do not cover the results grid.
BROWSER_DISMISS_JS = r"""
() => {
  const buttons = [
    '[class*="cookie"] button', '[class*="consent"] button',
    'button[aria-label="Close"]', 'button[aria-label="Dismiss"]',
    '[data-dismiss]',
  ];
  let clicked = 0;
  for (const selector of buttons) {
    try {
      document.querySelectorAll(selector).forEach((button) => {
        button.click();
        clicked += 1;
      });
    } catch (error) {}
  }
  return clicked;
}
"""

# Result grids are lazy: scroll to the bottom until the card count stops
# growing, then come back up.
BROWSER_SCROLL_JS = r"""
async (args) => {
  const {rounds, delayMs} = args;
  let last = -1;
  for (let i = 0; i < rounds; i++) {
    const count = document.querySelectorAll('a[href*="/document/"]').length;
    if (count === last) break;
    last = count;
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  window.scrollTo(0, 0);
  return {links: last};
}
"""

# Read document cards out of the live DOM. Titles are scored: an explicit
# title/aria-label beats card text, which beats a thumbnail alt.
BROWSER_EXTRACT_JS = r"""
() => {
  const HREF = /\/(document|doc|presentation|spreadsheet|ebook|audiobook|magazine)\/(\d{3,})(?:\/([^/?#]*))?/i;
  const hits = new Map();

  const add = (href, title, score) => {
    const match = String(href || '').match(HREF);
    if (!match) return;
    const rawKind = match[1].toLowerCase();
    const kind = rawKind === 'doc' ? 'document' : rawKind;
    const docId = match[2];
    const slug = match[3] || '';
    const clean = String(title || '').replace(/\s+/g, ' ').trim();
    if (!hits.has(docId)) hits.set(docId, {doc_id: docId, kind, slug, title: '', score: -1});
    const hit = hits.get(docId);
    if (clean.length >= 3 && (score > hit.score || (score === hit.score && clean.length > hit.title.length))) {
      hit.title = clean.length > 200 ? clean.slice(0, 200) : clean;
      hit.score = score;
    }
    if (!hit.slug && slug) hit.slug = slug;
  };

  for (const anchor of document.querySelectorAll('a[href]')) {
    const image = anchor.querySelector('img');
    const titleAttr = (anchor.getAttribute('title') || '').trim();
    const aria = (anchor.getAttribute('aria-label') || '').trim();
    const text = (anchor.innerText || '').replace(/\s+/g, ' ').trim();
    const alt = image ? (image.getAttribute('alt') || '').trim() : '';
    let score = 0;
    if (titleAttr) score = 4;
    else if (aria && aria.toLowerCase() !== 'save') score = 3;
    else if (text && text.length <= 200) score = 2;
    else if (alt) score = 1;
    add(anchor.getAttribute('href'), titleAttr || aria || text || alt, score);
  }

  // Some cards expose the id on the container instead of a link.
  for (const node of document.querySelectorAll('[data-document-id], [data-doc-id]')) {
    const id = node.getAttribute('data-document-id') || node.getAttribute('data-doc-id');
    const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
    add(`/document/${id}/`, text, 2);
  }

  return Array.from(hits.values()).map(({doc_id, kind, slug, title}) => (
    {doc_id, kind, slug, title}
  ));
}
"""


def _hits_from_raw(raw) -> list[SearchHit]:
    hits: list[SearchHit] = []
    seen: set[str] = set()
    for item in raw or []:
        try:
            doc_id = str(item.get("doc_id") or "").strip()
        except AttributeError:
            continue
        if not doc_id or doc_id in seen:
            continue
        seen.add(doc_id)
        title = " ".join(str(item.get("title") or "").split())
        slug = str(item.get("slug") or "")
        hits.append(
            SearchHit(
                doc_id=doc_id,
                kind=str(item.get("kind") or "document"),
                slug=slug,
                title=title or _slug_title(slug, doc_id),
            )
        )
    return hits


async def browser_search(
    cookies: dict | None,
    query: str,
    *,
    limit: int = 5,
    pages: int = 3,
    debug_dir=None,
    log=print,
    headless: bool = True,
) -> list[SearchHit]:
    """Search Scribd in headless Chromium and return up to ``limit`` documents.

    This is the route that works: the search page is client-rendered, so the
    HTTP response has no result links. No login is needed (the user's cookies
    are used when available). Nothing found → returns ``[]`` and leaves a
    screenshot + HTML dump behind for diagnosis.
    """
    try:
        from playwright.async_api import async_playwright  # type: ignore
    except Exception:
        log(
            "search: playwright is not installed, cannot search in a browser "
            "(pip install playwright && playwright install chromium)"
        )
        return []

    query_text = (query or "").strip()
    if not query_text:
        return []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=headless,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
        )
        try:
            context = await browser.new_context(
                viewport={"width": 1440, "height": 1600},
                user_agent=BROWSER_UA,
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

            for variant in SEARCH_VARIANTS:
                url = variant.format(query=quote_plus(query_text), page=1)
                log(f"search: browser → {url}")
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
                except Exception as exc:
                    log(f"search: browser navigation failed ({type(exc).__name__})")
                    continue
                try:
                    await page.evaluate(BROWSER_DISMISS_JS)
                except Exception:
                    pass

                hits = await _collect_results(
                    page, query_text, variant, limit=limit, pages=pages, log=log
                )
                if hits:
                    log(f"search: browser found {len(hits)} document(s)")
                    return hits[:limit]

                title = ""
                try:
                    title = await page.title()
                except Exception:
                    pass
                log(f"search: browser saw no results on that URL (page title: {title!r})")

            await _dump_search_page(page, query_text, debug_dir, log)
            return []
        finally:
            await browser.close()


async def _collect_results(
    page,
    query_text: str,
    variant: str,
    *,
    limit: int,
    pages: int,
    log,
) -> list[SearchHit]:
    """Wait for the result grid, load more, and read the cards."""
    # The SPA can take a few seconds to paint the first results.
    links = 0
    for attempt in range(30):
        try:
            links = int(await page.evaluate(COUNT_LINKS_JS) or 0)
        except Exception:
            links = 0
        if links:
            break
        await page.wait_for_timeout(500)
    if not links:
        return []

    try:
        await page.evaluate(BROWSER_SCROLL_JS, {"rounds": 8, "delayMs": 400})
    except Exception:
        pass

    hits = _hits_from_raw(await page.evaluate(BROWSER_EXTRACT_JS) or [])
    if len(hits) < limit and pages > 1:
        for page_number in range(2, pages + 1):
            url = variant.format(query=quote_plus(query_text), page=page_number)
            log(f"search: browser → page {page_number}")
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
            except Exception:
                break
            await page.wait_for_timeout(1200)
            try:
                await page.evaluate(BROWSER_SCROLL_JS, {"rounds": 4, "delayMs": 300})
            except Exception:
                pass
            more = _hits_from_raw(await page.evaluate(BROWSER_EXTRACT_JS) or [])
            seen = {hit.doc_id for hit in hits}
            fresh = [hit for hit in more if hit.doc_id not in seen]
            if not fresh:
                break
            hits.extend(fresh)
            if len(hits) >= limit:
                break
    return hits[:limit]


async def _dump_search_page(page, query_text: str, debug_dir, log) -> None:
    """Save what the browser saw (HTML + screenshot) when nothing was found."""
    if debug_dir is None:
        return
    try:
        from pathlib import Path

        folder = Path(debug_dir)
        folder.mkdir(parents=True, exist_ok=True)
        stem = re.sub(r"[^A-Za-z0-9]+", "-", query_text).strip("-") or "query"
        html_path = folder / f"search-{stem}-browser.html"
        html_path.write_text(await page.content(), encoding="utf-8", errors="ignore")
        shot_path = folder / f"search-{stem}-browser.png"
        await page.screenshot(path=str(shot_path), full_page=True)
        log(f"search: saved the page to {html_path} and {shot_path}")
    except Exception as exc:
        log(f"search: could not save the page ({type(exc).__name__})")


async def find_documents(
    fetcher,
    query: str,
    *,
    limit: int = 5,
    pages: int = 3,
    debug_dir=None,
    log=print,
) -> list[SearchHit]:
    """Search Scribd for ``query`` and return up to ``limit`` documents.

    Walks the result pages (``pages`` is an upper bound) until ``limit`` hits
    are collected. Raises whatever the fetcher raises (e.g. a bot-wall); the
    caller reports it — an empty list means "Scribd returned nothing usable".
    """
    found: list[SearchHit] = []
    seen: set[str] = set()
    for page_number in range(1, max(1, int(pages)) + 1):
        if len(found) >= limit:
            break
        url = search_url(query, page_number)
        response = await fetcher.get(url)
        html = getattr(response, "text", "") or ""
        results = parse_search_results(html, limit=0)
        fresh = [hit for hit in results if hit.doc_id not in seen]
        for hit in fresh:
            seen.add(hit.doc_id)
            found.append(hit)
        log(
            f"search: {query!r} page {page_number} → {len(results)} result(s), "
            f"{len(fresh)} new"
        )
        if not fresh:
            # Nothing parsable: keep the page so the markup can be inspected
            # instead of guessing why the search "found nothing".
            if debug_dir is not None:
                path = _dump_static_search_page(debug_dir, query, page_number, html)
                if path:
                    log(
                        f"search: no usable results on page {page_number}; "
                        f"saved the raw page to {path}"
                    )
            break
    return found[:limit]


def _dump_static_search_page(debug_dir, query: str, page: int, html: str):
    """Write a search response to disk (never contains cookies)."""
    try:
        from pathlib import Path

        folder = Path(debug_dir)
        folder.mkdir(parents=True, exist_ok=True)
        stem = re.sub(r"[^A-Za-z0-9]+", "-", (query or "query")).strip("-") or "query"
        path = folder / f"search-{stem}-p{page}.html"
        path.write_text(html or "", encoding="utf-8", errors="ignore")
        return path
    except Exception:
        return None
