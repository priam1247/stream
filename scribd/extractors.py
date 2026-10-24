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
CONTENT_URL_RE = re.compile(
    r"https://html\.scribdassets\.com/[A-Za-z0-9_\-./]+?/pages/[A-Za-z0-9_\-]+\.(?:jsonp|json)"
)
PAGE_IN_PATH_RE = re.compile(r"/pages/(\d+)-")
IMAGE_URL_RE = re.compile(
    r"https://(?:imgv2[^/\"]*|html[^/\"]*)\.scribdassets\.com/"
    r"[A-Za-z0-9_\-./]+?\.(?:jpe?g|png|webp)"
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


def extract_state(html: str) -> dict[str, Any]:
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
    meta.page_count = first_int(state, PAGE_COUNT_KEYS)
    meta.language = first_str(state, LANG_KEYS) or _og(html, "og:locale")
    meta.thumbnail = first_str(state, THUMB_KEYS) or _og(html, "og:image")
    return meta


def extract_content_urls(html: str) -> dict[int, str]:
    """Map page number -> asset URL, from raw HTML and any embedded JSON."""
    found: dict[int, str] = {}

    def consider(u: str) -> None:
        m = PAGE_IN_PATH_RE.search(u)
        if not m:
            return
        n = int(m.group(1))
        found.setdefault(n, u.replace("\\/", "/"))

    for u in CONTENT_URL_RE.findall(html):
        consider(u)

    state = extract_state(html)
    if state:
        for u in CONTENT_URL_RE.findall(json.dumps(state)):
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
    for u in IMAGE_URL_RE.findall(html):
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
