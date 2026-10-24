from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from urllib.parse import unquote

from .config import DOWNLOAD_PDF_URL, EMBED_URL, RENDER_META_URL
from .extractors import (
    build_page_template,
    extract_content_urls,
    extract_image_urls,
    extract_meta,
    fetch_oembed,
)
from .models import DocumentMeta, Page, ScrapedDocument
from .render import html_to_markdown, html_to_text
from .utils import extract_json_after


@dataclass
class ScrapeContext:
    doc_id: str
    url: str
    kind: str = "document"
    markdown: bool = False
    want_images: bool = False
    max_pages: int = 5000
    log: object = print
    _probe_cache: dict = field(default_factory=dict)

    def note(self, msg: str) -> None:
        try:
            self.log(f"  [{self.doc_id}] {msg}")  # type: ignore[operator]
        except Exception:
            pass


def _parse_payload(text: str) -> dict | None:
    idx = text.find("{")
    if idx == -1:
        return None
    blob = extract_json_after(text, idx)
    if not blob:
        return None
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        return None


def _payload_body(payload: dict) -> str:
    for key in ("content", "html", "body", "text", "pageContent"):
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            return v
    return ""


class Strategy:
    name = "base"

    async def run(self, ctx: ScrapeContext, fetcher) -> ScrapedDocument | None:
        raise NotImplementedError


async def _asset_html(ctx: ScrapeContext, fetcher) -> str:
    """Try the doc page, then the embed endpoint, and keep whichever has assets."""
    candidates = [
        ctx.url,
        EMBED_URL.format(doc_id=ctx.doc_id),
    ]
    for i, url in enumerate(candidates):
        try:
            resp = await fetcher.get(url, headers={"Referer": ctx.url})
        except Exception as exc:
            ctx.note(f"{url} -> {type(exc).__name__}")
            continue
        if resp.status_code != 200:
            # Say why, so a dead/placeholder doc ID (404) doesn't look
            # like a mysterious "no result" from every strategy.
            ctx.note(f"{url} -> HTTP {resp.status_code}")
            continue
        text = resp.text
        # Accept any page that carries a document-config marker. The old
        # check only looked for "scribdassets.com"/"contentUrl" in the raw
        # string, which missed pages whose config is escaped or that use
        # a different state key — those fell through to "no result".
        if any(
            marker in text
            for marker in (
                "scribdassets.com",
                "contentUrl",
                "content_url",
                "/pages/1-",
                "pageParams",
                "docManager",
                "access_key",
            )
        ):
            if i > 0:
                ctx.note("using embed endpoint")
            return text
    return ""


class RenderMetadataStrategy(Strategy):
    """Sometimes exposes content URLs when the doc page is JS-only."""

    name = "render-metadata"

    async def run(self, ctx: ScrapeContext, fetcher) -> ScrapedDocument | None:
        try:
            resp = await fetcher.get(RENDER_META_URL.format(doc_id=ctx.doc_id))
        except Exception:
            return None
        if resp.status_code != 200 or "scribdassets" not in resp.text:
            return None
        return await _build_from_html(ctx, fetcher, resp.text, meta_html=resp.text)


class JsonpPagesStrategy(Strategy):
    """Primary path: page HTML -> contentUrl -> synthesise page N -> fetch -> strip JSONP."""

    name = "jsonp-pages"

    async def run(self, ctx: ScrapeContext, fetcher) -> ScrapedDocument | None:
        html = await _asset_html(ctx, fetcher)
        if not html:
            return None
        return await _build_from_html(ctx, fetcher, html, meta_html=html)


async def _build_from_html(
    ctx: ScrapeContext, fetcher, html: str, *, meta_html: str
) -> ScrapedDocument | None:
    meta = extract_meta(meta_html, ctx.url, ctx.doc_id, ctx.kind)
    oembed = await fetch_oembed(fetcher, ctx.url)
    if oembed:
        # extract_meta() falls back to "scribd_<id>", so only let oEmbed
        # fill/replace when we don't already have a real title.
        if not meta.title or meta.title == f"scribd_{ctx.doc_id}":
            meta.title = str(oembed.get("title") or meta.title)
        meta.author = meta.author or str(oembed.get("author_name") or "")
        meta.thumbnail = meta.thumbnail or str(oembed.get("thumbnail_url") or "")

    urls = extract_content_urls(html)
    template = build_page_template(urls)
    if not template:
        return None

    total = meta.page_count or (max(urls) if urls else 0)
    if total <= 0:
        total = await _probe_total(ctx, fetcher, template)
    if total <= 0:
        return None
    total = min(total, ctx.max_pages)
    meta.page_count = total

    sem = asyncio.Semaphore(8)

    async def get_page(n: int) -> Page | None:
        async with sem:
            try:
                resp = await fetcher.get(template.format(n=n))
            except Exception:
                return None
        if resp.status_code != 200:
            return None
        payload = _parse_payload(resp.text)
        if not payload:
            return None
        raw = _payload_body(payload)
        page = Page(number=n, html=raw)
        page.text = html_to_markdown(raw) if ctx.markdown else html_to_text(raw)
        img = payload.get("imageUrl") or payload.get("image_url")
        if isinstance(img, str):
            page.image_url = img.replace("\\/", "/")
        return page

    pages = [p for p in await asyncio.gather(*(get_page(n) for n in range(1, total + 1))) if p]
    if not pages:
        return None
    pages.sort(key=lambda p: p.number)

    if not any(p.text.strip() for p in pages) and ctx.want_images:
        imgs = extract_image_urls(html)
        for p in pages:
            p.image_url = p.image_url or imgs.get(p.number)

    doc = ScrapedDocument(meta=meta, pages=pages, strategy=JsonpPagesStrategy.name)
    if not any(p.text.strip() for p in doc.pages):
        ctx.note("pages returned but no text layer (likely scanned)")
    return doc


async def _probe_total(ctx: ScrapeContext, fetcher, template: str) -> int:
    async def ok(n: int) -> bool:
        try:
            r = await fetcher.get(template.format(n=n))
        except Exception:
            return False
        return r.status_code == 200 and len(r.text.strip()) > 20

    if not await ok(1):
        return 0
    lo, hi = 1, 2
    while hi <= ctx.max_pages and await ok(hi):
        lo, hi = hi, hi * 2
    hi = min(hi, ctx.max_pages + 1)
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if await ok(mid):
            lo = mid
        else:
            hi = mid
    ctx.note(f"probed page count: {lo}")
    return lo


class PdfDownloadStrategy(Strategy):
    """Full-fidelity fallback — often works without login."""

    name = "pdf-download"

    async def run(self, ctx: ScrapeContext, fetcher) -> ScrapedDocument | None:
        try:
            resp = await fetcher.get(DOWNLOAD_PDF_URL.format(doc_id=ctx.doc_id))
        except Exception:
            return None
        ctype = resp.headers.get("content-type", "").lower()
        if resp.status_code != 200 or "pdf" not in ctype or len(resp.content) < 5000:
            return None
        title = "document"
        cd = resp.headers.get("content-disposition", "")
        if "filename=" in cd:
            title = unquote(cd.split("filename=")[-1].strip().strip('";'))
        meta = DocumentMeta(doc_id=ctx.doc_id, url=ctx.url, title=title, kind=ctx.kind)
        ctx.note("got PDF via download endpoint")
        return ScrapedDocument(meta=meta, strategy=self.name, pdf=resp.content)


DEFAULT_STRATEGIES: list[Strategy] = [
    JsonpPagesStrategy(),
    RenderMetadataStrategy(),
    PdfDownloadStrategy(),
]
