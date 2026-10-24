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

    @property
    def text(self) -> str:
        return "\n\n".join(p.text for p in self.pages if p.text.strip())

    def to_dict(self) -> dict[str, Any]:
        return {
            "meta": self.meta.to_dict(),
            "strategy": self.strategy,
            "page_count": len(self.pages),
            "has_pdf": self.pdf is not None,
            "pages": [p.to_dict() for p in self.pages],
        }
