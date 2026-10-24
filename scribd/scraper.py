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
        log: Callable[[str], None] = print,
    ) -> None:
        self.fetcher = fetcher
        self.strategies = strategies or DEFAULT_STRATEGIES
        self.markdown = markdown
        self.want_images = want_images
        self.log = log

    async def scrape(self, url: str) -> ScrapedDocument:
        kind, doc_id = parse_doc_url(url)
        ctx = ScrapeContext(
            doc_id=doc_id,
            url=url,
            kind=kind,
            markdown=self.markdown,
            want_images=self.want_images,
            log=self.log,
        )
        errors: list[str] = []
        for strategy in self.strategies:
            self.log(f"[{doc_id}] strategy: {strategy.name}")
            try:
                doc = await strategy.run(ctx, self.fetcher)
            except Exception as exc:
                errors.append(f"{strategy.name}: {type(exc).__name__}: {exc}")
                continue
            if doc and (doc.pages or doc.pdf):
                self.log(f"[{doc_id}] OK via {strategy.name}")
                return doc
            errors.append(f"{strategy.name}: no result")
        raise ScrapeError(f"{url} — all strategies failed: " + "; ".join(errors))

    async def scrape_many(self, urls: list[str]) -> list[ScrapedDocument | Exception]:
        return list(await asyncio.gather(*(self.scrape(u) for u in urls), return_exceptions=True))
