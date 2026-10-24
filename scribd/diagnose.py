"""Structural report for a live Scribd URL.

Why this exists: the sandbox that builds this project cannot reach
scribd.com, so fix/verify cycles have to run on the user's machine.
`--diagnose` prints only *shapes* (statuses, byte counts, which markers
are present, first few asset URLs) — never cookie values — and saves the
raw page for offline inspection.
"""
from __future__ import annotations

import re
from collections import defaultdict
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
    # embed-page structure
    "newpage",
    "text_layer",
    "/images/1-",
)


def _embed_structure(html: str) -> str:
    """Compact class census of the embed HTML — enough to fix selectors."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "lxml")
    counts: dict[str, int] = defaultdict(int)
    for el in soup.find_all(True):
        for cls in el.get("class") or []:
            counts[cls] += 1
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:15]
    lines = [f"  {c:>5}x  .{cls}" for cls, c in top]
    imgs = [
        str(i["src"])
        for i in soup.find_all("img", src=True)
        if "scribdassets.com" in str(i["src"])
    ]
    lines.append(f"  page images: {len(imgs)}")
    if imgs:
        lines.append(f"  first image: {_mask(imgs[0])}")
    return "\n".join(lines)


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

    # The embed endpoint is the strategy that works on modern documents,
    # so report its structure too.
    emb_text = ""
    try:
        emb = await fetcher.get(
            EMBED_URL.format(doc_id=doc_id), headers={"Referer": url}, use_cache=False
        )
    except Exception as exc:
        print(f"\nembed: ERROR {type(exc).__name__}")
    else:
        print(
            f"\nembed page: HTTP {emb.status_code}, {len(emb.content or b''):,} bytes"
        )
        if emb.status_code == 200 and emb.text:
            emb_text = emb.text
            (out / f"embed-{doc_id}.html").write_text(emb.text, encoding="utf-8")
            print("embed class census (top 15):")
            print(_embed_structure(emb.text))
            print(f"  saved to: {out / f'embed-{doc_id}.html'}")

    # --- page-image probe: does the "merge images into a PDF" route work? ---
    from .extractors import (
        build_screenshot_template,
        extract_page_image_urls,
        extract_page_count,
        extract_screenshot_urls,
    )

    total = extract_page_count(page_html) or extract_page_count(emb_text)
    imgs = extract_page_image_urls(page_html)
    shot = build_screenshot_template(extract_screenshot_urls(page_html))
    print(f"\npage count detected: {total or 'unknown'}")
    print(f"page image URLs in HTML: {len(imgs)}; screenshot template: {shot or 'none'}")

    def url_for(n: int) -> str | None:
        return imgs.get(n) or (shot.format(n=n) if shot else None)

    probes = [n for n in (1, 2, 3, max(1, (total or 4) // 2), total or 4) if url_for(n)]
    if not probes:
        print("no page image URLs found — the image route cannot work on this page")
    for n in dict.fromkeys(probes):
        u = url_for(n)
        try:
            r = await fetcher.get(u, headers={"Referer": url}, use_cache=False)
        except Exception as exc:
            print(f"  page {n:>3}: ERROR {type(exc).__name__}")
            continue
        head = (r.content or b"")[:4]
        kind = "JPEG" if head[:3] == b"\xff\xd8\xff" else ("PNG" if head[:4] == b"\x89PNG" else "not an image")
        print(
            f"  page {n:>3}: HTTP {r.status_code}  {len(r.content or b''):>8,} bytes  "
            f"{r.headers.get('content-type','?')[:24]}  {kind}"
        )

    print(
        "\nSend this report back. If the counts above are zero, also share the "
        "saved page HTML (it is the public document page, but it can contain "
        "your account identifiers — review before sharing)."
    )
    return 0
