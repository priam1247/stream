"""Structural report for a live Scribd URL.

Why this exists: the sandbox that builds this project cannot reach
scribd.com, so fix/verify cycles have to run on the user's machine.
`--diagnose` prints only *shapes* (statuses, byte counts, which markers
are present, first few asset URLs) — never cookie values — and saves the
raw page for offline inspection.
"""
from __future__ import annotations

import re
from pathlib import Path

from .config import DOWNLOAD_PDF_URL, EMBED_URL, OEMBED_URL, RENDER_META_URL
from .extractors import extract_content_urls, extract_state, parse_doc_url
from urllib.parse import quote

MARKERS = (
    "window.__PRELOADED_STATE__",
    "__NEXT_DATA__",
    "window.pageParams",
    "window.docManager",
    "window._pageData",
    "contentUrl",
    "content_url",
    "pageParams",
    "docManager",
    "access_key",
    "scribdassets.com",
    "/pages/1-",
    "isLoggedIn",
    '"user"',
    "og:title",
)


def _mask(u: str) -> str:
    """Keep the URL's shape, hide the random document hash."""
    return re.sub(r"\b[0-9a-f]{8,}\b", "<hash>", u)[:160]


async def diagnose(fetcher, url: str, *, save_dir: str | Path = ".debug") -> int:
    out = Path(save_dir)
    out.mkdir(parents=True, exist_ok=True)
    try:
        kind, doc_id = parse_doc_url(url)
    except ValueError as exc:
        print(f"  {exc}")
        return 2

    print(f"document id : {doc_id}  ({kind})")
    endpoints = [
        ("doc page", url),
        ("embed", EMBED_URL.format(doc_id=doc_id)),
        ("render-metadata", RENDER_META_URL.format(doc_id=doc_id)),
        ("oembed", OEMBED_URL.format(quoted=quote(url, safe=""))),
        ("pdf download", DOWNLOAD_PDF_URL.format(doc_id=doc_id)),
    ]

    page_html = ""
    for label, ep in endpoints:
        try:
            resp = await fetcher.get(ep, use_cache=False)
        except Exception as exc:
            print(f"{label:16}: ERROR {type(exc).__name__}")
            continue
        body = resp.content or b""
        ctype = resp.headers.get("content-type", "?").split(";")[0]
        print(
            f"{label:16}: HTTP {resp.status_code}  {len(body):>9,} bytes  {ctype}"
        )
        if label == "doc page" and resp.status_code == 200:
            page_html = resp.text

    if not page_html:
        print("\nNo document page retrieved — cookies likely rejected or blocked.")
        return 1

    tmp = out / f"page-{doc_id}.html"
    tmp.write_text(page_html, encoding="utf-8")
    print(f"\nraw page saved to: {tmp}")

    print("\nmarkers present in page HTML:")
    for m in MARKERS:
        print(f"  {'yes' if m in page_html else ' no'}  {m}")

    state_keys = sorted(extract_state(page_html))[:25]
    print(f"\nstate keys found ({len(state_keys)} shown): {state_keys}")

    urls = extract_content_urls(page_html)
    print(f"\npage asset URLs extracted: {len(urls)}")
    for n in sorted(urls)[:3]:
        print(f"  p{n}: {_mask(urls[n])}")

    shapes = sorted(
        {
            m.group(0)[:60]
            for m in re.finditer(r"https?://[a-z0-9.-]*scribdassets\.com/[^\"'\s<>\\]{0,40}", page_html)
        }
    )[:8]
    print("\nscribdassets URL shapes seen:")
    for s in shapes:
        print(f"  {_mask(s)}")
    if not shapes:
        print("  none — the page may be a JS shell; the HTML above is what we need.")

    print(
        "\nSend this report back. If the counts above are zero, also share the "
        "saved page HTML (it is the public document page, but it can contain "
        "your account identifiers — review before sharing)."
    )
    return 0
