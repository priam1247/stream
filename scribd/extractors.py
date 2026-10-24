from __future__ import annotations

import json
import re
from typing import Any

from bs4 import BeautifulSoup

from .config import OEMBED_URL
from .models import DocumentMeta
from .utils import extract_json_after, first_int, first_str

DOC_URL_RE = re.compile(
    r"scribd\.com/(?:document|doc|book|presentation|read|embeds)/(\d+)", re.I
)
# NOTE: the query string is part of the URL. Page assets are often signed
# (?token=eyJ...); stripping it makes every fetch 401/403, which looked like
# "95 page URLs found, zero pages downloaded".
CONTENT_URL_RE = re.compile(
    r"https://(?:[A-Za-z0-9_-]+\.)*scribdassets\.com/[A-Za-z0-9_\-./]+?/pages/"
    r"[A-Za-z0-9_\-]+\.(?:jsonp|json)(?:\?[^\"'\s<>\\]*)?",
    re.I,
)
# Live pages embed the config as JSON, where slashes are escaped
# ("https:\/\/html.scribdassets.com\/..."), and some hosts differ
# (html1.scribdassets.com). This loose pattern catches those after
# _normalise() has unescaped the document.
LOOSE_CONTENT_URL_RE = re.compile(
    r"https?://[A-Za-z0-9_.-]*scribdassets\.com/[^\"'\s<>\\]*?/pages/\d+-[^\"'\s<>\\?]+"
    r"\.(?:jsonp|json)(?:\?[^\"'\s<>\\]*)?",
    re.I,
)
PAGE_IN_PATH_RE = re.compile(r"/pages/(\d+)-")
IMAGE_URL_RE = re.compile(
    r"https?://(?:[A-Za-z0-9_-]+\.)*scribdassets\.com/[A-Za-z0-9_\-./]+?\.(?:jpe?g|png|webp)",
    re.I,
)
TEMPLATE_RE = re.compile(
    r"^(?P<prefix>https?://.+/pages/)\d+-(?P<hash>[^/.?]+)\.(?P<ext>jsonp|json)(?P<query>\?.*)?$"
)

STATE_MARKERS = (
    "window.__PRELOADED_STATE__",
    "window._pageData",
    "__NEXT_DATA__",
    "window.pageParams",
    "window.docManager",
)

TITLE_KEYS = ("title", "docTitle", "doc_title", "displayTitle", "name")
AUTHOR_KEYS = ("author", "authorName", "author_name", "uploaderName", "creator", "owner")
PAGE_COUNT_KEYS = ("pageCount", "page_count", "numPages", "totalPages", "pageNumTotal")
DESC_KEYS = ("description", "summary", "excerpt")
LANG_KEYS = ("language", "lang")
THUMB_KEYS = ("thumbnailUrl", "thumbnail_url", "thumbnail")


def parse_doc_url(url: str) -> tuple[str, str]:
    m = DOC_URL_RE.search(url)
    if not m:
        raise ValueError(f"Not a recognisable Scribd URL: {url}")
    kind = "book" if "/book/" in url.lower() else "document"
    return kind, m.group(1)


def _normalise(html: str) -> str:
    """Undo the two escapes Scribd uses around asset URLs.

    JSON-embedded config writes "https:\\/\\/host\\/path", and some
    templates HTML-escape the slashes ("&#x2F;", "&#47;"). Without this
    the URL regexes below silently match nothing — which surfaced as
    "all strategies failed: no result" on real documents even though
    the page had loaded fine (HTTP 200).
    """
    if "\\/" in html:
        html = html.replace("\\/", "/")
    if "&#x2F;" in html or "&#47;" in html or "&#x2f;" in html:
        html = html.replace("&#x2F;", "/").replace("&#x2f;", "/").replace("&#47;", "/")
    return html


def extract_state(html: str) -> dict[str, Any]:
    html = _normalise(html)
    for marker in STATE_MARKERS:
        idx = html.find(marker)
        if idx == -1:
            continue
        blob = extract_json_after(html, idx)
        if not blob:
            continue
        try:
            data = json.loads(blob)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    return {}


def _og(html: str, prop: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    tag = soup.find("meta", attrs={"property": prop}) or soup.find(
        "meta", attrs={"name": prop}
    )
    if tag and tag.get("content"):
        return str(tag["content"]).strip()
    return ""


PAGE_COUNT_PATTERNS = (
    re.compile(r'"pageCount"\s*:\s*(\d+)'),
    re.compile(r'"page_count"\s*:\s*(\d+)'),
    re.compile(r'"numPages"\s*:\s*(\d+)'),
    re.compile(r'"totalPages"\s*:\s*(\d+)'),
    re.compile(r'"pageNumTotal"\s*:\s*(\d+)'),
    # Download-token payload on page images: {"page_min":1,"page_max":95}
    re.compile(r'"page_max"\s*:\s*(\d+)'),
    # Visible label: "1K views 95 pages" / "95 pages"
    re.compile(r'\b(\d{1,4})\s+pages?\b', re.I),
)


_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b")


def _decode_token_hints(html: str) -> int:
    """Page total hidden inside the JWT on page-image URLs.

    Page images carry ``?token=<JWT>`` and its payload includes
    ``{"page_min":1,"page_max":95,"enforce":true}`` — base64, so a plain
    regex over the HTML never sees it.
    """
    import base64
    import json as _json

    for tok in _JWT_RE.findall(html)[:5]:
        payload = tok.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        try:
            data = _json.loads(base64.urlsafe_b64decode(payload))
        except Exception:
            continue
        for key in ("page_max", "pageMax", "pageCount"):
            try:
                n = int(data.get(key) or 0)
            except (TypeError, ValueError):
                continue
            if 0 < n <= 5000:
                return n
    return 0


def extract_page_count(html: str) -> int:
    """Page total from any of the shapes Scribd puts it in.

    Needed because the *embed* page carries no page count at all: without
    it, "3 captured pages" looks complete and a partial download is
    reported as success.
    """
    html = _normalise(html)
    for pat in PAGE_COUNT_PATTERNS:
        for m in pat.finditer(html):
            n = int(m.group(1))
            if 0 < n <= 5000:
                return n
    return _decode_token_hints(html)


def extract_meta(html: str, url: str, doc_id: str, kind: str = "document") -> DocumentMeta:
    state = extract_state(html)
    title = (
        first_str(state, TITLE_KEYS)
        or _og(html, "og:title")
        or _og(html, "twitter:title")
    )
    if not title:
        soup = BeautifulSoup(html, "lxml")
        if soup.title and soup.title.string:
            title = soup.title.string.split("|")[0].strip()

    meta = DocumentMeta(doc_id=doc_id, url=url, kind=kind)
    meta.title = title or f"scribd_{doc_id}"
    meta.author = first_str(state, AUTHOR_KEYS) or _og(html, "og:author")
    meta.description = first_str(state, DESC_KEYS) or _og(html, "og:description")
    meta.page_count = first_int(state, PAGE_COUNT_KEYS) or extract_page_count(html)
    meta.language = first_str(state, LANG_KEYS) or _og(html, "og:locale")
    meta.thumbnail = first_str(state, THUMB_KEYS) or _og(html, "og:image")
    return meta


def extract_content_urls(html: str) -> dict[int, str]:
    """Map page number -> asset URL, from raw HTML and any embedded JSON."""
    found: dict[int, str] = {}
    html = _normalise(html)

    def consider(u: str) -> None:
        m = PAGE_IN_PATH_RE.search(u)
        if not m:
            return
        n = int(m.group(1))
        found.setdefault(n, u.replace("\\/", "/"))

    for u in CONTENT_URL_RE.findall(html):
        consider(u)
    if not found:
        # Escaped/alternate-host form (see _normalise / LOOSE_CONTENT_URL_RE).
        for u in LOOSE_CONTENT_URL_RE.findall(html):
            consider(u)

    state = extract_state(html)
    if state:
        for u in CONTENT_URL_RE.findall(json.dumps(state)) + LOOSE_CONTENT_URL_RE.findall(
            json.dumps(state)
        ):
            consider(u)

    return found


def build_page_template(urls: dict[int, str]) -> str | None:
    """Turn page-1's URL into a '{n}' template — the key insight."""
    if not urls:
        return None
    ref = urls.get(1) or urls[min(urls)]
    m = TEMPLATE_RE.match(ref)
    if not m:
        return None
    return f"{m['prefix']}{{n}}-{m['hash']}.{m['ext']}{m['query'] or ''}"


def extract_image_urls(html: str) -> dict[int, str]:
    out: dict[int, str] = {}
    for u in IMAGE_URL_RE.findall(_normalise(html)):
        u = u.replace("\\/", "/")
        m = PAGE_IN_PATH_RE.search(u) or re.search(r"/(\d+)-", u)
        if m:
            out.setdefault(int(m.group(1)), u)
    return out


async def fetch_oembed(fetcher, url: str) -> dict[str, Any]:
    from urllib.parse import quote

    try:
        resp = await fetcher.get(OEMBED_URL.format(quoted=quote(url, safe="")))
    except Exception:
        return {}
    if resp.status_code != 200:
        return {}
    try:
        data = resp.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------
# Page images — the route to a whole-document PDF
# ---------------------------------------------------------------------------
# Modern documents render each page as an image. Two shapes are served:
#   html.scribdassets.com/<format_uuid>/images/<n>-<hash>.jpg?token=...
#   screenshots.scribd.com/Scribd/<a>_<b>_<c>/<d>/<doc_id>/<n>.jpeg
# The first is the rendered page (higher quality, per-page hash); the second
# is uniform across the document — only the trailing page number changes —
# so it can be turned into a template for pages missing from the HTML.
PAGE_IMG_ASSET_RE = re.compile(
    r"https?://(?:[A-Za-z0-9_-]+\.)*scribdassets\.com/[A-Za-z0-9_\-]+/images/"
    r"(\d+)-[A-Za-z0-9]+\.(?:jpe?g|png|webp)(?:\?[^\"'\s<>\\]*)?",
    re.I,
)
# Locked to screenshots.scribd.com on purpose: a *.scribd.com wildcard would
# also match unrelated URLs (documents, avatars) and produce bogus pages.
PAGE_IMG_SHOT_RE = re.compile(
    r"https?://screenshots\.scribd\.com/Scribd/[^\"'\s<>\\]*?/(\d+)\.(?:jpe?g|png|webp)"
    r"(?:\?[^\"'\s<>\\]*)?",
    re.I,
)
SHOT_TEMPLATE_RE = re.compile(
    r"^(?P<prefix>https?://screenshots\.scribd\.com/Scribd/.+/)\d+\."
    r"(?P<ext>jpe?g|png|webp)(?P<q>\?.*)?$",
    re.I,
)


def extract_page_image_urls(html: str) -> dict[int, str]:
    """Map page number -> best page image URL (rendered page preferred)."""
    html = _normalise(html)
    out: dict[int, str] = {}
    for m in PAGE_IMG_ASSET_RE.finditer(html):
        out.setdefault(int(m.group(1)), m.group(0))
    for m in PAGE_IMG_SHOT_RE.finditer(html):
        out.setdefault(int(m.group(1)), m.group(0))
    return out


def extract_screenshot_urls(html: str) -> dict[int, str]:
    """Only the uniform screenshots.scribd.com URLs (any one gives us the
    template that covers every page)."""
    out: dict[int, str] = {}
    for m in PAGE_IMG_SHOT_RE.finditer(_normalise(html)):
        out.setdefault(int(m.group(1)), m.group(0))
    return out


def build_screenshot_template(urls: dict[int, str]) -> str | None:
    """Uniform screenshots.scribd.com URL -> '{n}' template (all pages)."""
    for url in urls.values():
        m = SHOT_TEMPLATE_RE.match(url)
        if m:
            return f"{m['prefix']}{{n}}.{m['ext']}{m['q'] or ''}"
    return None
