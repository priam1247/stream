"""Scribd search and document metadata for the screenshot-only panel.

There is exactly one search source: Scribd's own ``/search/query`` JSON. There
are no token hunts, search-engine fallbacks, scan ladders or browser-based
search. Scribd's ``pageCount`` in the search answer is authoritative.
"""

from __future__ import annotations

import html
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

try:
    from . import config
except ImportError:  # standalone folder run
    import config  # type: ignore[no-redef]

STOPWORDS = {
    "a", "an", "the", "of", "for", "and", "or", "in", "on", "to", "with",
    "by", "from", "pdf", "part",
}
CHALLENGE = (b"cf-chl", b"captcha", b"access denied", b"robot", b"challenge")
PAGE_COUNT_PATTERNS = (
    r'"page_count"\s*:\s*(\d+)',
    r'"pageCount"\s*:\s*(\d+)',
    r'"totalPages"\s*:\s*(\d+)',
    r'"pages_count"\s*:\s*(\d+)',
    r'data-page-count=["\'](\d+)',
    r'\bpage_count\s*[:=]\s*["\']?(\d+)',
    r'\bpageCount\s*[:=]\s*["\']?(\d+)',
)
URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.I)
DOC_ID_RE = re.compile(
    r"/(?:document|doc|embeds|presentation|book|article|document_downloads)/(\d+)",
    re.I,
)


@dataclass(frozen=True)
class FetchResult:
    status: int
    body: bytes
    error: str = ""


@dataclass(frozen=True)
class Document:
    url: str
    title: str = ""
    pages: int = 0
    id: str = ""
    author: str = ""
    views: str = ""


class HitCache:
    """Remember what the user found, so /run knows Scribd's page count."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_url: dict[str, Document] = {}
        self._by_id: dict[str, Document] = {}

    def remember(self, hits: list[dict]) -> None:
        with self._lock:
            for hit in hits:
                doc = document_from_hit(hit)
                if not doc.url:
                    continue
                self._by_url[doc.url] = doc
                if doc.id:
                    self._by_id[doc.id] = doc

    def lookup(self, url: str) -> Document | None:
        clean = clean_url(url)
        ident = doc_id_of(clean)
        with self._lock:
            return self._by_url.get(clean) or self._by_id.get(ident)

    def clear(self) -> None:
        with self._lock:
            self._by_url.clear()
            self._by_id.clear()


CACHE = HitCache()


def fetch(url: str, *, referer: str = config.FIND_REFERER, json_answer: bool = False) -> FetchResult:
    """One HTTPS request with the owner's Scribd cookies. No retries."""
    headers = {
        "User-Agent": config.USER_AGENT,
        "Accept": "application/json" if json_answer else "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Referer": referer,
    }
    if json_answer:
        headers["X-Requested-With"] = "XMLHttpRequest"
    cookie_header = config.cookie_header()
    if cookie_header:
        headers["Cookie"] = cookie_header
    request = urllib.request.Request(config.rebase(url), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=config.SEARCH_TIMEOUT_S) as answer:
            return FetchResult(answer.status, answer.read())
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read()
        except OSError:
            body = b""
        return FetchResult(exc.code, body, str(exc))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return FetchResult(0, b"", str(exc))


def is_scribd_url(raw: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(str(raw or "").strip())
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    return host == "scribd.com" or host.endswith(".scribd.com")


def doc_id_of(raw: str) -> str:
    text = str(raw or "")
    match = DOC_ID_RE.search(urllib.parse.urlsplit(text).path)
    if match:
        return match.group(1)
    digits = re.search(r"(\d{6,})", text)
    return digits.group(1) if digits else ""


def clean_url(raw: str) -> str:
    """A canonical Scribd URL with only access-key query values kept."""
    if not is_scribd_url(raw):
        return ""
    parsed = urllib.parse.urlsplit(str(raw).strip())
    ident = doc_id_of(parsed.geturl())
    if not ident:
        return ""
    host = (parsed.hostname or "www.scribd.com").lower()
    if host == "scribd.com":
        host = "www.scribd.com"
    kept = [
        (name, value)
        for name, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=False)
        if name in ("access_key", "secret_password")
    ]
    return urllib.parse.urlunsplit(
        ("https", host, parsed.path, urllib.parse.urlencode(kept), "")
    )


def document_url(ident: str) -> str:
    return config.DOCUMENT_URL.format(id=ident)


def embed_url(raw: str) -> str:
    """The one embed URL used for every capture."""
    ident = doc_id_of(raw)
    if not ident:
        return ""
    parsed = urllib.parse.urlsplit(clean_url(raw) or raw)
    query = {
        "start_page": "1",
        "view_mode": "scroll",
    }
    for name, value in urllib.parse.parse_qsl(parsed.query):
        if name in ("access_key", "secret_password"):
            query[name] = value
    return config.EMBED_URL.format(id=ident) + "?" + urllib.parse.urlencode(query)


def title_from_url(raw: str) -> str:
    parsed = urllib.parse.urlsplit(raw)
    parts = [part for part in parsed.path.split("/") if part]
    slug = parts[-1] if parts else ""
    slug = urllib.parse.unquote(slug)
    slug = re.sub(r"[-_]+", " ", slug).strip()
    if not slug or slug.isdigit():
        ident = doc_id_of(raw)
        return f"Document {ident}" if ident else "Scribd document"
    return " ".join(part[:1].upper() + part[1:] for part in slug.split())


def page_count_from_html(source: str) -> int:
    """Scribd's own page count from the embed/document HTML."""
    text = str(source or "")
    for pattern in PAGE_COUNT_PATTERNS:
        match = re.search(pattern, text, re.I)
        if match:
            try:
                count = int(match.group(1))
            except ValueError:
                continue
            if 0 < count <= config.MAX_PAGES:
                return count
    return 0


def oembed(raw: str) -> dict:
    """Title/author only; oEmbed does not carry a page count."""
    url = "https://www.scribd.com/services/oembed?" + urllib.parse.urlencode(
        {"url": clean_url(raw), "format": "json"}
    )
    got = fetch(url, referer=clean_url(raw), json_answer=True)
    if got.status != 200:
        return {}
    try:
        payload = json.loads(got.body.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def page_count_for(raw: str) -> int:
    """Fallback page count for direct legacy links, without token hunting."""
    targets = [embed_url(raw), document_url(doc_id_of(raw))]
    seen: set[str] = set()
    for target in targets:
        if not target or target in seen:
            continue
        seen.add(target)
        got = fetch(target, referer=clean_url(raw))
        if got.status == 200:
            count = page_count_from_html(got.body.decode("utf-8", "replace"))
            if count:
                return count
    return 0


def search_url(query: str, page: int = 1) -> str:
    params = {
        "query": " ".join(str(query or "").split()),
        "verbatim": "true",
        "ct_lang": "0",
    }
    if page > 1:
        params["page"] = str(page)
    return config.FIND_URL + "?" + urllib.parse.urlencode(params)


def documents_in(payload: object) -> list[dict]:
    """Find the result list wherever Scribd nests it in the JSON."""
    queue: list[object] = [payload]
    visited = 0
    while queue and visited < 20_000:
        node = queue.pop(0)
        visited += 1
        if isinstance(node, list):
            docs = [
                item for item in node
                if isinstance(item, dict)
                and ("reader_url" in item or "pageCount" in item or "downloadUrl" in item)
                and ("id" in item or "title" in item)
            ]
            if docs:
                return docs
            queue.extend(node)
        elif isinstance(node, dict):
            queue.extend(node.values())
    return []


def document_from_hit(hit: dict) -> Document:
    url = clean_url(hit.get("reader_url") or hit.get("url") or "")
    ident = str(hit.get("id") or doc_id_of(url) or "").strip()
    if not ident and not url:
        return Document("")
    if not url and ident.isdigit():
        url = clean_url(document_url(ident))
    try:
        pages = int(hit.get("pageCount") or hit.get("pages") or 0)
    except (TypeError, ValueError):
        pages = 0
    return Document(
        url=url,
        title=" ".join(str(hit.get("title") or "").split()) or title_from_url(url),
        pages=max(0, min(pages, config.MAX_PAGES)),
        id=ident,
        author=str(hit.get("author") or ""),
        views=str(hit.get("views") or ""),
    )


def hit_from(doc: dict) -> dict:
    url = clean_url(doc.get("reader_url") or doc.get("url") or "")
    ident = str(doc.get("id") or doc_id_of(url) or "").strip()
    if not ident.isdigit():
        return {}
    if not url:
        url = clean_url(document_url(ident))
    if not url:
        return {}
    try:
        pages = int(doc.get("pageCount") or 0)
    except (TypeError, ValueError):
        pages = 0
    author = ""
    authors = doc.get("authors")
    if isinstance(authors, list) and authors and isinstance(authors[0], dict):
        author = str(authors[0].get("name") or "").strip()
    if not author and isinstance(doc.get("author"), dict):
        author = str(doc["author"].get("name") or "").strip()
    title = " ".join(html.unescape(str(doc.get("title") or "")).split())
    return {
        "id": ident,
        "title": title or title_from_url(url),
        "url": url,
        "pages": max(0, min(pages, config.MAX_PAGES)),
        "views": str(doc.get("views") or "").strip(),
        "author": author,
    }


def query_words(query: str) -> list[str]:
    words = re.split(r"[^0-9a-z]+", str(query or "").lower())
    return list(dict.fromkeys(word for word in words if word and word not in STOPWORDS))


def rank_hits(hits: list[dict], query: str) -> list[dict]:
    """Keep Scribd's order but put exact word matches first."""
    words = query_words(query)
    phrase = " ".join(str(query or "").lower().split())
    marked: list[tuple[int, int, dict]] = []
    for order, source in enumerate(hits):
        hit = dict(source)
        title = str(hit.get("title") or "").lower()
        title_words = set(re.findall(r"[0-9a-z]+", title))
        matched = 0
        score = 0
        for word in words:
            if word in title_words:
                matched += 1
                score += 12
            elif any(candidate.startswith(word) for candidate in title_words):
                matched += 1
                score += 6
        if phrase and phrase in title:
            score += 100
        if words and matched == len(words):
            score += 20
        if hit.get("pages"):
            score += 1
        hit["score"] = score
        hit["match"] = (
            "all" if not words or matched == len(words)
            else "some" if matched else "none"
        )
        marked.append((score, order, hit))
    marked.sort(key=lambda row: (-row[0], row[1]))
    return [row[2] for row in marked]


def refusal_note(status: int, body: bytes, error: str = "") -> str:
    low = (body or b"").lower()
    if any(marker in low for marker in CHALLENGE):
        return "Scribd returned a browser challenge for this panel address."
    if status in (401, 403, 429, 503):
        return f"Scribd refused the search from this address (HTTP {status})."
    if not status:
        return f"Scribd search did not answer ({error or 'connection failed'})."
    return f"Scribd search returned HTTP {status}."


def count_in(payload: dict, key: str) -> int:
    try:
        value = int(payload.get(key) or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, min(value, 10_000_000))


def find_page(query: str, page: int = 1) -> dict:
    """Return the exact /find shape the dashboard already understands."""
    query = " ".join(str(query or "").split())
    try:
        page_number = max(1, min(int(page or 1), config.FIND_MAX_PAGE))
    except (TypeError, ValueError):
        page_number = 1
    empty = {
        "hits": [],
        "notes": [],
        "summary": "",
        "page": page_number,
        "total": 0,
        "documents": 0,
        "max_page": 1,
        "per_page": config.FIND_PER_PAGE,
    }
    if not query:
        empty["notes"] = ["Type a few words to search Scribd for."]
        empty["summary"] = "No search yet."
        return empty
    got = fetch(search_url(query, page_number), json_answer=True)
    if got.status != 200:
        empty["notes"] = [refusal_note(got.status, got.body, got.error)]
        empty["summary"] = empty["notes"][0]
        return empty
    try:
        payload = json.loads(got.body.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        empty["notes"] = ["Scribd's answer was not search JSON."]
        empty["summary"] = empty["notes"][0]
        return empty
    if not isinstance(payload, dict):
        empty["notes"] = ["Scribd's search answer had the wrong shape."]
        empty["summary"] = empty["notes"][0]
        return empty
    documents = documents_in(payload)
    hits: list[dict] = []
    seen: set[str] = set()
    for doc in documents:
        hit = hit_from(doc)
        if hit and hit["id"] not in seen:
            seen.add(hit["id"])
            hits.append(hit)
    hits = rank_hits(hits, query)
    CACHE.remember(hits)
    total = count_in(payload, "total_results_count")
    result_pages = count_in(payload, "page_count")
    if not result_pages and total:
        result_pages = (total + config.FIND_PER_PAGE - 1) // config.FIND_PER_PAGE
    max_page = max(1, min(result_pages or 1, config.FIND_MAX_PAGE))
    notes = [f"Scribd search page {page_number}: {len(documents)} result(s)."]
    if not hits:
        notes.append("No usable Scribd document links in that answer.")
    weak = sum(1 for hit in hits if hit["match"] == "none")
    if weak:
        notes.append(f"{weak} loosely related result(s) kept at the end.")
    return {
        "hits": hits,
        "notes": notes,
        "summary": (
            f"showing {len(hits)} of {total} match(es)" if total
            else f"{len(hits)} match(es) on page {page_number}"
        ),
        "page": page_number,
        "total": total,
        "documents": len(documents),
        "max_page": max_page,
        "per_page": config.FIND_PER_PAGE,
    }


def parse_links(raw: str) -> list[str]:
    found: list[str] = []
    for match in URL_RE.finditer(str(raw or "")):
        clean = clean_url(match.group(0).rstrip(".,);]"))
        if clean and clean not in found:
            found.append(clean)
    return found


def metadata_for(raw: str, hint: Document | None = None) -> Document:
    """Use ticked search metadata first; fetch only what is missing."""
    clean = clean_url(raw)
    if not clean:
        return Document("")
    cached = CACHE.lookup(clean)
    source = hint or cached or Document(clean)
    title = source.title or title_from_url(clean)
    ident = source.id or doc_id_of(clean)
    pages = source.pages
    if not pages and cached:
        pages = cached.pages
    if not pages:
        pages = page_count_for(clean)
    if not source.title and not cached:
        data = oembed(clean)
        title = " ".join(str(data.get("title") or "").split()) or title
    return Document(
        url=clean,
        title=title,
        pages=max(0, min(pages, config.MAX_PAGES)),
        id=ident,
        author=source.author,
        views=source.views,
    )


def normalise_documents(payload: dict) -> list[Document]:
    """Accept ticked hits, plain URLs, and legacy links. No paste-link UI."""
    wanted: list[Document] = []
    for item in payload.get("documents") or []:
        if isinstance(item, str):
            item = {"url": item}
        if not isinstance(item, dict):
            continue
        url = clean_url(item.get("url") or item.get("reader_url") or "")
        if not url:
            continue
        try:
            pages = int(item.get("pages") or 0)
        except (TypeError, ValueError):
            pages = 0
        wanted.append(
            Document(
                url=url,
                title=" ".join(str(item.get("title") or "").split()),
                pages=max(0, min(pages, config.MAX_PAGES)),
                id=str(item.get("id") or doc_id_of(url) or ""),
            )
        )
    raw_urls = list(payload.get("urls") or []) + parse_links(str(payload.get("links") or ""))
    for raw in raw_urls:
        url = clean_url(raw)
        if url:
            wanted.append(Document(url=url, id=doc_id_of(url)))
    unique: dict[str, Document] = {}
    for doc in wanted:
        key = doc.id or doc.url
        if key not in unique:
            unique[key] = doc
        elif doc.pages and not unique[key].pages:
            unique[key] = doc
    # The dashboard's search-first UI ticks hits and posts only their bare URLs
    # to /run ({urls, limit, text, jobs}). The authoritative page count, title
    # and author from the /find answer live in CACHE, so resolve them here rather
    # than re-fetching or letting the capture guess. This is a pure in-memory
    # lookup — no network — so /run stays instant.
    resolved: list[Document] = []
    for doc in unique.values():
        cached = CACHE.lookup(doc.url)
        if cached:
            doc = Document(
                url=doc.url,
                title=doc.title or cached.title,
                pages=doc.pages or cached.pages,
                id=doc.id or cached.id,
                author=doc.author or cached.author,
                views=doc.views or cached.views,
            )
        resolved.append(doc)
    return resolved[: config.MAX_DOCUMENTS]
