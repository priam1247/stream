"""Public document metadata via Scribd's oEmbed route.

    https://www.scribd.com/services/oembed?url=<encoded document URL>&format=json

This is the one Scribd endpoint we can use without scraping and without
guessing: WordPress registers it as an oEmbed provider for both `/doc/` and
`/document/` URLs, and a request for a public document returns JSON with
`title`, `author_name`, `author_url`, `thumbnail_url`, dimensions and the embed
HTML (which names `/embeds/<id>/content`).

What that buys us here:

* a **real title and author** instead of the slug we fall back to when a search
  result's label is junk;
* the **canonical URL for a bare document id** — `document/<id>/<whatever>` has no
  meaning to Scribd, the redirect does;
* with `--require-public`, a **cheap refusal** for a URL that oEmbed cannot
  describe, which saves a whole browser session on a document that is not
  public.

What it does not do: it does not grant access to anything. A private or
restricted document simply does not produce metadata, and the rest of the chain
behaves exactly as before. Because the route is only *validated* for public
documents, a failure here is treated as "no metadata", never as proof that a
document is unavailable — unless the caller explicitly asks for that
(`require_public=True`).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from urllib.parse import quote

OEMBED_ENDPOINT = "https://www.scribd.com/services/oembed"
EMBED_URL = "https://www.scribd.com/embeds/{doc_id}/content"
DOC_ID_RE = re.compile(
    r"/(?:document|doc|presentation|spreadsheet|ebook|audiobook|magazine)/(\d+)", re.I
)
BARE_ID_RE = re.compile(r"^\d{5,}$")


def doc_id_of(url_or_id: str) -> str:
    """Document id from any Scribd URL shape, or from a bare id."""
    text = (url_or_id or "").strip()
    if BARE_ID_RE.match(text):
        return text
    match = DOC_ID_RE.search(text)
    return match.group(1) if match else ""


def canonical_url(url_or_id: str) -> str:
    """`https://www.scribd.com/document/<id>` — what oEmbed expects."""
    doc_id = doc_id_of(url_or_id)
    return f"https://www.scribd.com/document/{doc_id}" if doc_id else (url_or_id or "").strip()


def embed_url(url_or_id: str) -> str:
    doc_id = doc_id_of(url_or_id)
    return EMBED_URL.format(doc_id=doc_id) if doc_id else ""


def oembed_url(url_or_id: str, endpoint: str = OEMBED_ENDPOINT) -> str:
    return f"{endpoint}?url={quote(canonical_url(url_or_id), safe='')}&format=json"


@dataclass
class DocumentMeta:
    """What oEmbed said, normalised. `ok` means "the route described it"."""

    url: str = ""
    doc_id: str = ""
    title: str = ""
    author_name: str = ""
    author_url: str = ""
    thumbnail_url: str = ""
    html: str = ""
    width: int = 0
    height: int = 0
    kind: str = "rich"
    ok: bool = False
    status: int = 0
    reason: str = ""

    def as_dict(self) -> dict:
        return {
            "title": self.title,
            "author": self.author_name,
            "thumbnail": self.thumbnail_url,
            "ok": self.ok,
            "status": self.status,
            "reason": self.reason,
        }

    @property
    def embed(self) -> str:
        """The `/embeds/<id>/content` URL named by the payload (or built)."""
        match = re.search(r"/embeds/(\d+)/content", self.html or "")
        if match:
            return f"https://www.scribd.com/embeds/{match.group(1)}/content"
        return embed_url(self.doc_id or self.url)


def parse_oembed(payload: dict | str, url: str = "") -> DocumentMeta:
    """Normalise an oEmbed JSON body. Each field is optional, so never assume."""
    if isinstance(payload, (str, bytes)):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            return DocumentMeta(url=url, doc_id=doc_id_of(url), reason="not JSON")
    if not isinstance(payload, dict):
        return DocumentMeta(url=url, doc_id=doc_id_of(url), reason="not an object")

    def text(key: str) -> str:
        value = payload.get(key)
        return " ".join(str(value).split()) if isinstance(value, (str, int, float)) else ""

    def number(key: str) -> int:
        try:
            return int(payload.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    title = text("title")
    meta = DocumentMeta(
        url=url or text("url"),
        doc_id=doc_id_of(url) or doc_id_of(text("url")),
        title=title,
        author_name=text("author_name"),
        author_url=text("author_url"),
        thumbnail_url=text("thumbnail_url"),
        html=str(payload.get("html") or ""),
        width=number("width"),
        height=number("height"),
        kind=text("type") or "rich",
        status=200,
        ok=bool(title),
        reason="" if title else "no title in the response",
    )
    return meta


async def fetch_metadata(fetcher, url_or_id: str, *, log=None) -> DocumentMeta | None:
    """Ask oEmbed about one document. Returns None when the route is unusable.

    A non-200 answer is reported as `ok=False` with its status, so a caller can
    decide whether that is decisive (`--require-public`) or merely means "no
    metadata". Transport errors return None: the network, not the document.
    """
    target = oembed_url(url_or_id)
    if not doc_id_of(url_or_id):
        return None
    try:
        response = await fetcher.get(target, headers={"Accept": "application/json"})
    except Exception as exc:  # noqa: BLE001 - never break a batch over metadata
        if log:
            log(f"oembed: {type(exc).__name__}: {exc}")
        return None

    status = getattr(response, "status_code", 0) or 0
    if status != 200:
        meta = DocumentMeta(
            url=canonical_url(url_or_id),
            doc_id=doc_id_of(url_or_id),
            status=status,
            ok=False,
            reason=f"HTTP {status}",
        )
        if log:
            log(f"oembed: {meta.doc_id} → HTTP {status} (no public metadata)")
        return meta

    try:
        payload = response.json()
    except Exception:  # noqa: BLE001 - some clients only expose .text
        text = getattr(response, "text", "") or ""
        meta = parse_oembed(text, canonical_url(url_or_id))
        meta.status = 200
        if log and not meta.ok:
            log(f"oembed: {meta.doc_id} → unusable body ({meta.reason})")
        return meta

    meta = parse_oembed(payload, canonical_url(url_or_id))
    meta.status = 200
    if log:
        if meta.ok:
            log(f"oembed: {meta.doc_id} → {meta.title[:60]!r}"
                + (f" by {meta.author_name}" if meta.author_name else ""))
        else:
            log(f"oembed: {meta.doc_id} → unusable body ({meta.reason})")
    return meta
