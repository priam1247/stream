from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class DocumentMeta:
    doc_id: str
    url: str
    title: str = ""
    author: str = ""
    description: str = ""
    page_count: int = 0
    kind: str = "document"
    thumbnail: str = ""
    language: str = ""
    uploaded: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Page:
    number: int
    text: str = ""
    html: str = ""
    image_url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ScrapedDocument:
    meta: DocumentMeta
    pages: list[Page] = field(default_factory=list)
    strategy: str = ""
    pdf: bytes | None = None
    # False when the document is known to be longer than what we captured
    # (the embed page ships only the first pages of a 95-page document).
    # The scraper then keeps looking instead of stopping at a partial.
    complete: bool = True

    def quality(self) -> tuple[int, int]:
        """Higher is better: a real PDF beats many pages beats few pages."""
        if self.pdf:
            return (2, self.meta.page_count or 10**6)
        return (1, len(self.pages))

    @property
    def text(self) -> str:
        return "\n\n".join(p.text for p in self.pages if p.text.strip())

    def to_dict(self) -> dict[str, Any]:
        return {
            "meta": self.meta.to_dict(),
            "strategy": self.strategy,
            "page_count": len(self.pages),
            "has_pdf": self.pdf is not None,
            "complete": self.complete,
            "pages": [p.to_dict() for p in self.pages],
        }
