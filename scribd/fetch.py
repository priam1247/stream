from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from urllib.parse import unquote

from bs4 import BeautifulSoup

from .blockers import CHALLENGE_HINT, ChallengeError, looks_challenged
from .config import DOWNLOAD_PDF_URL, EMBED_URL, RENDER_META_URL
from .extractors import (
    build_page_template,
    build_screenshot_template,
    extract_page_image_urls,
    extract_screenshot_urls,
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
    keep_images: bool = False
    images_dir: str = ""
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
        if looks_challenged(text):
            raise ChallengeError(CHALLENGE_HINT)
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
            ctx.note(
                f"pdf-download: HTTP {resp.status_code}, {len(resp.content):,} bytes, "
                f"type {ctype or 'unknown'} — usually needs a subscriber download credit"
            )
            return None
        title = "document"
        cd = resp.headers.get("content-disposition", "")
        if "filename=" in cd:
            title = unquote(cd.split("filename=")[-1].strip().strip('";'))
        meta = DocumentMeta(doc_id=ctx.doc_id, url=ctx.url, title=title, kind=ctx.kind)
        await _fill_meta_from_oembed(ctx, fetcher, ScrapedDocument(meta=meta))
        ctx.note(f"pdf-download: got PDF ({len(resp.content):,} bytes)")
        return ScrapedDocument(meta=meta, strategy=self.name, pdf=resp.content)


class EmbedTextStrategy(Strategy):
    """Primary strategy on today's Scribd: the embed page ships the whole
    document's text layer in one HTML response.

    Why this comes first: modern documents render each page as an *image*
    (``.../images/1-abc.jpg``) and expose no ``/pages/1-*.jsonp`` asset at
    all, so the JSONP strategy cannot work on them. The embed endpoint
    (``/embeds/<id>/content?start_page=1&view_mode=scroll``) returns every
    page as ``div.newpage`` -> ``div.text_layer`` alongside those images —
    verified against a live 95-page document.
    """

    name = "embed-text"

    async def run(self, ctx: ScrapeContext, fetcher) -> ScrapedDocument | None:
        url = EMBED_URL.format(doc_id=ctx.doc_id)
        try:
            resp = await fetcher.get(url, headers={"Referer": ctx.url})
        except Exception as exc:
            ctx.note(f"embed -> {type(exc).__name__}")
            return None
        if resp.status_code != 200:
            ctx.note(f"embed -> HTTP {resp.status_code}")
            return None
        if looks_challenged(resp.text):
            # Belt and braces: Fetcher raises on challenges, but a stale
            # cached challenge page would otherwise be written out as a
            # "successful" one-paragraph document.
            ctx.note("embed -> anti-bot challenge page")
            raise ChallengeError(CHALLENGE_HINT)
        if len(resp.text) < 500:
            ctx.note(f"embed -> {len(resp.text)} bytes, too small")
            return None
        doc = build_from_embed(ctx, resp.text)
        if doc is None:
            return None
        await _fill_meta_from_oembed(ctx, fetcher, doc)
        if not doc.complete:
            ctx.note(
                f"embed-text: PARTIAL {len(doc.pages)}/{doc.meta.page_count} pages "
                "(the rest is lazy-loaded) — trying fuller strategies"
            )
        return doc


# Page containers, most specific first. Scribd's embed markup is
# ``div.newpage`` per page containing a ``div.text_layer``; the others are
# defensive fallbacks in case the class names change.
PAGE_SELECTORS = (
    "div.newpage",
    "div.page",
    "div[id^='page']",
    "div.text_layer",
)


def _page_containers(soup: BeautifulSoup) -> list:
    for sel in PAGE_SELECTORS:
        try:
            found = soup.select(sel)
        except Exception:
            continue
        found = [el for el in found if el.find("img") or el.get_text(strip=True)]
        if found:
            return found
    return []


def build_from_embed(ctx: ScrapeContext, html: str) -> ScrapedDocument | None:
    """Turn embed HTML into pages. Falls back to one merged page."""
    soup = BeautifulSoup(html, "lxml")
    for bad in soup(["script", "style", "noscript"]):
        bad.decompose()

    meta = extract_meta(html, ctx.url, ctx.doc_id, ctx.kind)
    containers = _page_containers(soup)
    pages: list[Page] = []

    if containers:
        for i, el in enumerate(containers, start=1):
            raw = str(el)
            text = html_to_markdown(raw) if ctx.markdown else html_to_text(raw)
            page = Page(number=i, html=raw, text=text)
            img = el.find("img", src=True)
            if img and "scribdassets.com" in str(img["src"]):
                page.image_url = str(img["src"])
            pages.append(page)
        ctx.note(f"embed-text: {len(pages)} page containers")
    else:
        body = soup.body or soup
        text = html_to_markdown(str(body)) if ctx.markdown else html_to_text(str(body))
        if not text.strip():
            return None
        pages = [Page(number=1, text=text)]
        ctx.note("embed-text: page structure not detected, merged into one page")

    # Drop empty trailing chunks (embed pages often carry spacer divs).
    while pages and not pages[-1].text.strip():
        pages.pop()
    if not pages or not any(p.text.strip() for p in pages):
        return None
    # A one-paragraph result is almost always an error page, not a document
    # (this is what let a "Client Challenge" page be saved as a 3-line txt).
    total_text = " ".join(p.text for p in pages)
    if not containers and len(total_text.split()) < 40:
        ctx.note(f"embed-text: only {len(total_text.split())} words — not a document")
        return None

    expected = meta.page_count or len(pages)
    complete = len(pages) >= expected * 0.9
    if not meta.page_count:
        meta.page_count = len(pages)
    return ScrapedDocument(
        meta=meta, pages=pages, strategy=EmbedTextStrategy.name, complete=complete
    )


async def _fill_meta_from_oembed(ctx: ScrapeContext, fetcher, doc: ScrapedDocument) -> None:
    """og:title on embed markup is often the literal "Scribd"; oEmbed isn't."""
    placeholder = doc.meta.title in ("", f"scribd_{ctx.doc_id}") or (
        doc.meta.title.strip().lower() == "scribd"
    )
    if not placeholder and doc.meta.author:
        return
    oembed = await fetch_oembed(fetcher, ctx.url)
    if placeholder and oembed.get("title"):
        doc.meta.title = str(oembed["title"])
    if not doc.meta.author and oembed.get("author_name"):
        doc.meta.author = str(oembed["author_name"])


class PageImagesPdfStrategy(Strategy):
    """Rebuild the whole document as a PDF from its page images.

    Modern Scribd documents are image-backed: each page is a JPEG/PNG. The
    embed endpoint only ships the first few pages of HTML, but the page
    image URLs cover every page — ``images/<n>-<hash>.jpg`` for pages that
    appear in the HTML, and the uniform
    ``screenshots.scribd.com/.../<doc_id>/<n>.jpeg`` pattern (only the
    number changes) for the rest. Download them all and merge into a PDF,
    which is what "download the whole file" actually means here.
    """

    name = "page-images-pdf"

    async def run(self, ctx: ScrapeContext, fetcher) -> ScrapedDocument | None:
        html = await _asset_html(ctx, fetcher)
        if not html:
            return None
        meta = extract_meta(html, ctx.url, ctx.doc_id, ctx.kind)
        urls = extract_page_image_urls(html)
        shot = build_screenshot_template(extract_screenshot_urls(html))
        if not urls and not shot:
            ctx.note("page-images: no page image URLs found")
            return None

        total = meta.page_count or (max(urls) if urls else 0)
        if total <= 0:
            return None
        total = min(total, ctx.max_pages)

        def url_for(n: int) -> str | None:
            return urls.get(n) or (shot.format(n=n) if shot else None)

        sem = asyncio.Semaphore(6)
        ctx.note(f"page-images: fetching {total} page images")

        async def fetch_image(n: int) -> tuple[int, bytes] | None:
            u = url_for(n)
            if not u:
                return None
            async with sem:
                try:
                    r = await fetcher.get(u, headers={"Referer": ctx.url})
                except Exception:
                    return None
            if r.status_code != 200 or not r.content:
                return None
            if looks_challenged(r.text if b"<html" in r.content[:200] else ""):
                return None
            return n, r.content

        results = [x for x in await asyncio.gather(*(fetch_image(n) for n in range(1, total + 1))) if x]
        if len(results) < 2:
            ctx.note(f"page-images: only {len(results)} images downloaded")
            return None
        got = len(results)
        ctx.note(f"page-images: {got}/{total} images downloaded")

        if ctx.keep_images and ctx.images_dir:
            from pathlib import Path as _Path

            d = _Path(ctx.images_dir)
            d.mkdir(parents=True, exist_ok=True)
            for n, data in results:
                ext = "jpg" if data[:3] == b"\xff\xd8\xff" else "png"
                (d / f"page-{n:03d}.{ext}").write_bytes(data)
            ctx.note(f"page-images: saved images to {d}")

        pdf = _images_to_pdf([data for _, data in results])
        if not pdf:
            ctx.note("page-images: PDF assembly failed (is Pillow installed?)")
            return None

        pages = [
            Page(number=n, image_url=url_for(n) or "", text="")
            for n, _ in results
        ]
        await _fill_meta_from_oembed(ctx, fetcher, ScrapedDocument(meta=meta, pages=pages))
        if not meta.page_count:
            meta.page_count = got
        return ScrapedDocument(
            meta=meta,
            pages=pages,
            strategy=self.name,
            pdf=pdf,
            complete=got >= total * 0.9,
        )


def _images_to_pdf(blobs: list[bytes]) -> bytes | None:
    """Merge page images into a single PDF (needs Pillow)."""
    try:
        from io import BytesIO

        from PIL import Image
    except Exception:
        return None
    frames = []
    try:
        for b in blobs:
            try:
                im = Image.open(BytesIO(b))
                im.load()
            except Exception:
                continue
            frames.append(im.convert("RGB"))
        if not frames:
            return None
        out = BytesIO()
        frames[0].save(
            out,
            format="PDF",
            save_all=True,
            append_images=frames[1:],
            resolution=150.0,
        )
        return out.getvalue()
    finally:
        for f in frames:
            try:
                f.close()
            except Exception:
                pass


DEFAULT_STRATEGIES: list[Strategy] = [
    EmbedTextStrategy(),
    PdfDownloadStrategy(),
    PageImagesPdfStrategy(),
    JsonpPagesStrategy(),
    RenderMetadataStrategy(),
]
