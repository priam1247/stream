from __future__ import annotations

import asyncio
from typing import Callable

from .extractors import parse_doc_url
from .fetch import DEFAULT_STRATEGIES, ScrapeContext, Strategy
from .http import Fetcher
from .models import ScrapedDocument


class ScrapeError(RuntimeError):
    """Raised when every strategy fails for a document.

    NOTE: ``scribd/__init__.py`` does
    ``from .scraper import ScrapeError, ScribdScraper`` — if this class
    is missing/renamed here (e.g. a truncated copy of this file), that
    import fails with exactly:
        ImportError: cannot import name 'ScrapeError' from 'scribd.scraper'
    """


class ScribdScraper:
    def __init__(
        self,
        fetcher: Fetcher,
        *,
        strategies: list[Strategy] | None = None,
        markdown: bool = False,
        want_images: bool = False,
        keep_images: bool = False,
        images_dir: str = "",
        log: Callable[[str], None] = print,
    ) -> None:
        self.fetcher = fetcher
        self.strategies = strategies or DEFAULT_STRATEGIES
        self.markdown = markdown
        self.want_images = want_images
        self.keep_images = keep_images
        self.images_dir = images_dir
        self.log = log

    async def scrape(self, url: str) -> ScrapedDocument:
        kind, doc_id = parse_doc_url(url)
        ctx = ScrapeContext(
            doc_id=doc_id,
            url=url,
            kind=kind,
            markdown=self.markdown,
            want_images=self.want_images,
            keep_images=self.keep_images,
            images_dir=self.images_dir,
            log=self.log,
        )
        errors: list[str] = []
        best: ScrapedDocument | None = None
        for strategy in self.strategies:
            self.log(f"[{doc_id}] strategy: {strategy.name}")
            try:
                doc = await strategy.run(ctx, self.fetcher)
            except Exception as exc:
                errors.append(f"{strategy.name}: {type(exc).__name__}: {exc}")
                continue
            if not doc or not (doc.pages or doc.pdf):
                errors.append(f"{strategy.name}: no result")
                continue
            if best is None or doc.quality() > best.quality():
                best = doc
            if doc.complete:
                self.log(f"[{doc_id}] OK via {strategy.name}")
                return doc
            # Partial: keep it, but let a fuller strategy (the PDF
            # download, or page images merged into a PDF) try to do better.
            errors.append(
                f"{strategy.name}: partial ({len(doc.pages)}/{doc.meta.page_count} pages)"
            )
        if best is not None:
            self.log(
                f"[{doc_id}] best available via {best.strategy} "
                f"({len(best.pages)} pages{' + pdf' if best.pdf else ''}, partial)"
            )
            return best
        raise ScrapeError(f"{url} — all strategies failed: " + "; ".join(errors))

    async def scrape_many(self, urls: list[str]) -> list[ScrapedDocument | Exception]:
        return list(await asyncio.gather(*(self.scrape(u) for u in urls), return_exceptions=True))
