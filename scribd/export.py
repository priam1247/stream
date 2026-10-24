from __future__ import annotations

import html as htmllib
import json
from pathlib import Path

from .models import ScrapedDocument
from .utils import slugify


def _base(doc: ScrapedDocument, out_dir: Path) -> Path:
    stem = f"{doc.meta.doc_id}_{slugify(doc.meta.title)}"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / stem


def export_txt(doc: ScrapedDocument, out_dir: Path) -> Path:
    path = _base(doc, out_dir).with_suffix(".txt")
    chunks = [doc.meta.title, "=" * len(doc.meta.title), ""]
    if doc.meta.author:
        chunks.append(f"Author: {doc.meta.author}")
    chunks.append(f"Source: {doc.meta.url}")
    chunks.append("")
    for p in doc.pages:
        chunks += [f"--- page {p.number} ---", p.text, ""]
    path.write_text("\n".join(chunks), encoding="utf-8")
    return path


def export_md(doc: ScrapedDocument, out_dir: Path) -> Path:
    path = _base(doc, out_dir).with_suffix(".md")
    chunks = [f"# {doc.meta.title}", ""]
    if doc.meta.author:
        chunks += [f"*{doc.meta.author}*", ""]
    chunks += [f"<{doc.meta.url}>", ""]
    for p in doc.pages:
        chunks += [f"<!-- page {p.number} -->", p.text, ""]
    path.write_text("\n".join(chunks), encoding="utf-8")
    return path


def export_json(doc: ScrapedDocument, out_dir: Path) -> Path:
    path = _base(doc, out_dir).with_suffix(".json")
    path.write_text(json.dumps(doc.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def export_html(doc: ScrapedDocument, out_dir: Path) -> Path:
    path = _base(doc, out_dir).with_suffix(".html")
    parts = [
        "<!doctype html><meta charset='utf-8'>",
        f"<title>{htmllib.escape(doc.meta.title)}</title>",
        "<style>body{max-width:46rem;margin:2rem auto;font:16px/1.6 Georgia,serif}"
        ".page{border-top:1px solid #ddd;padding-top:1rem;margin-top:2rem}"
        ".pn{color:#999;font-size:.8rem}</style>",
        f"<h1>{htmllib.escape(doc.meta.title)}</h1>",
    ]
    if doc.meta.author:
        parts.append(f"<p><em>{htmllib.escape(doc.meta.author)}</em></p>")
    for p in doc.pages:
        parts.append(f"<div class='page'><div class='pn'>page {p.number}</div>")
        # Always escape: page text is untrusted scraped content.
        parts.append(_para(p.text))
        parts.append("</div>")
    path.write_text("\n".join(parts), encoding="utf-8")
    return path


def _para(text: str) -> str:
    return "".join(
        f"<p>{htmllib.escape(line)}</p>" for line in text.split("\n") if line.strip()
    )


def export_pdf_bytes(doc: ScrapedDocument, out_dir: Path) -> Path | None:
    if not doc.pdf:
        return None
    path = _base(doc, out_dir).with_suffix(".pdf")
    path.write_bytes(doc.pdf)
    return path


def export_epub(doc: ScrapedDocument, out_dir: Path) -> Path | None:
    try:
        from ebooklib import epub
    except ImportError:
        return None
    if not doc.pages:
        return None
    book = epub.EpubBook()
    book.set_identifier(f"scribd-{doc.meta.doc_id}")
    book.set_title(doc.meta.title)
    book.set_language(doc.meta.language or "en")
    if doc.meta.author:
        book.add_author(doc.meta.author)
    chapters = []
    for p in doc.pages:
        ch = epub.EpubHtml(title=f"Page {p.number}", file_name=f"p{p.number}.xhtml")
        body = "".join(
            f"<p>{htmllib.escape(l)}</p>" for l in p.text.split("\n") if l.strip()
        )
        ch.content = f"<h2>Page {p.number}</h2>{body}"
        book.add_item(ch)
        chapters.append(ch)
    book.toc = chapters
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav", *chapters]
    path = _base(doc, out_dir).with_suffix(".epub")
    epub.write_epub(str(path), book)
    return path


WRITERS = {
    "txt": export_txt,
    "md": export_md,
    "json": export_json,
    "html": export_html,
    "epub": export_epub,
    "pdf": export_pdf_bytes,
}


def write_all(doc: ScrapedDocument, out_dir: Path, formats: list[str]) -> list[Path]:
    written = []
    for fmt in formats:
        writer = WRITERS.get(fmt)
        if not writer:
            continue
        try:
            path = writer(doc, out_dir)
        except Exception:
            path = None
        if path:
            written.append(path)
    return written
