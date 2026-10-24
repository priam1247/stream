"""Find Scribd documents from a keyword — no link required.

The download chain needs a document URL, so this module turns

    excel

into real document URLs:

1. ``GET https://www.scribd.com/search?query=excel&page=1`` (with the user's
   cookies, through the same :class:`~scribd.http.Fetcher`, so the TLS
   fingerprint and session are the ones that work for downloads too).
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


async def find_documents(
    fetcher,
    query: str,
    *,
    limit: int = 5,
    pages: int = 3,
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
            break
    return found[:limit]
