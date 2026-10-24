"""Structural report for a live Scribd URL.

Why this exists: the sandbox that builds this project cannot reach
scribd.com, so fix/verify cycles have to run on the user's machine.
`--diagnose` prints only *shapes* (statuses, byte counts, which markers
are present, first few asset URLs) — never cookie values — and saves the
raw page for offline inspection.

Each section is isolated: one failing probe must never abort the report,
because the report is the evidence we need.
"""
from __future__ import annotations

import re
import traceback
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

from .config import DOWNLOAD_PDF_URL, EMBED_URL, OEMBED_URL, RENDER_META_URL
from .extractors import (
    build_screenshot_template,
    extract_content_urls,
    extract_page_count,
    extract_page_image_urls,
    extract_screenshot_urls,
    extract_state,
    parse_doc_url,
)

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
    "outer_page",
    "text_layer",
    "/images/1-",
)

TEXT_FIELDS = ("content", "html", "body", "text", "pageContent")


def _mask(u: str) -> str:
    """Keep the URL's shape, hide the random document hash."""
    return re.sub(r"\b[0-9a-f]{8,}\b", "<hash>", u)[:160]


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


async def _probe(fetcher, url: str, referer: str | None) -> tuple[str, object]:
    """GET with the same headers the downloader uses. Never raises."""
    headers = {"Referer": referer} if referer else None
    try:
        resp = await fetcher.get(url, headers=headers, use_cache=False)
    except Exception as exc:  # noqa: BLE001 - report, never crash
        return f"ERROR {type(exc).__name__}: {str(exc)[:80]}", None
    return "", resp


def _payload_summary(body: str) -> str:
    """Describe a page payload without depending on the parser working."""
    from .fetch import _parse_payload

    payload = _parse_payload(body)
    if not payload:
        return "NOT parseable as JSON"
    keys = sorted(payload)[:8]
    for k in TEXT_FIELDS:
        v = payload.get(k)
        if isinstance(v, str) and v.strip():
            return f"parsed OK, keys={keys}, {k}: {len(v)} chars"
    return f"parsed OK, keys={keys}, NO text field"


def _guess_jsonp_urls(page_html: str) -> dict[int, str]:
    """Last-resort extraction: any /pages/N-*.jsonp URL, any host.

    Independent of the production regexes so the report still tells us
    something even if those patterns are the thing that broke.
    """
    pat = re.compile(
        r'https?://[^"\'\s<>\\]*?/pages/(\d+)-[^"\'\s<>\\?]+\.jsonp', re.I
    )
    out: dict[int, str] = {}
    for m in pat.finditer(page_html.replace("\\/", "/")):
        out.setdefault(int(m.group(1)), m.group(0))
    return out


async def diagnose(fetcher, url: str, *, save_dir: str | Path = ".debug") -> int:
    out = Path(save_dir)
    try:
        out.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
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
        err, resp = await _probe(fetcher, ep, referer=url)
        if err:
            print(f"{label:16}: {err}")
            continue
        body = resp.content or b""
        ctype = str(resp.headers.get("content-type", "?")).split(";")[0]
        print(f"{label:16}: HTTP {resp.status_code}  {len(body):>9,} bytes  {ctype}")
        if label == "doc page" and resp.status_code == 200:
            page_html = resp.text

    if not page_html:
        print("\nNo document page retrieved — cookies likely rejected or blocked.")
        return 1

    tmp = out / f"page-{doc_id}.html"
    try:
        tmp.write_text(page_html, encoding="utf-8")
        print(f"\nraw page saved to: {tmp}")
    except OSError:
        pass

    # ---- sections below are each isolated: never abort the report ----
    try:
        print("\nmarkers present in page HTML:")
        for m in MARKERS:
            print(f"  {'yes' if m in page_html else ' no'}  {m}")
    except Exception:  # noqa: BLE001
        traceback.print_exc()

    try:
        keys = sorted(extract_state(page_html))[:25]
        print(f"\nstate keys found ({len(keys)} shown): {keys}")
    except Exception as exc:  # noqa: BLE001
        print(f"\nstate keys: ERROR {type(exc).__name__}: {exc}")

    urls: dict[int, str] = {}
    try:
        urls = extract_content_urls(page_html)
        print(f"\npage asset URLs extracted: {len(urls)}")
        for n in sorted(urls)[:3]:
            print(f"  p{n}: {_mask(urls[n])}")
    except Exception as exc:  # noqa: BLE001
        print(f"\npage asset URLs: ERROR {type(exc).__name__}: {exc}")

    if not urls:
        fallback = _guess_jsonp_urls(page_html)
        print(f"lax scan for any /pages/N-*.jsonp URL: {len(fallback)}")
        urls = fallback or urls

    # ---- THE decisive probe: do those page assets actually download? ----
    print(f"\njsonp page assets to probe: {len(urls)}")
    if urls:
        picks = sorted({1, max(urls) // 2, max(urls)} & set(urls))
        for n in picks:
            u = urls[n]
            err, resp = await _probe(fetcher, u, referer=url)
            if err:
                print(f"  page {n:>3}: {err}")
                continue
            body = resp.text or ""
            ctype = str(resp.headers.get("content-type", "?"))[:28]
            print(
                f"  page {n:>3}: HTTP {resp.status_code}  "
                f"{len(resp.content or b''):>8,} bytes  {ctype}"
            )
            print(f"            head: {body[:110]!r}")
            print(f"            {_payload_summary(body)}")
    else:
        print("  none found — this document has no JSONP page assets")

    # ---- embed structure ----
    emb_text = ""
    err, emb = await _probe(fetcher, EMBED_URL.format(doc_id=doc_id), referer=url)
    if err:
        print(f"\nembed: {err}")
    else:
        print(f"\nembed page: HTTP {emb.status_code}, {len(emb.content or b''):,} bytes")
        if emb.status_code == 200 and emb.text:
            emb_text = emb.text
            try:
                (out / f"embed-{doc_id}.html").write_text(emb.text, encoding="utf-8")
                print("embed class census (top 15):")
                print(_embed_structure(emb.text))
            except Exception as exc:  # noqa: BLE001
                print(f"  embed census failed: {type(exc).__name__}: {exc}")

    # ---- page-image route (PDF from images) ----
    try:
        total = extract_page_count(page_html) or extract_page_count(emb_text)
        imgs = extract_page_image_urls(page_html)
        shot = build_screenshot_template(extract_screenshot_urls(page_html))
        print(f"\npage count detected: {total or 'unknown'}")
        print(f"page image URLs: {len(imgs)}; screenshot template: {shot or 'none'}")

        def url_for(n: int) -> str | None:
            return imgs.get(n) or (shot.format(n=n) if shot else None)

        probes = [n for n in (1, 2, 3, (total or 4) // 2 or 1, total or 4) if url_for(n)]
        if not probes:
            print("no page image URLs — the image->PDF route cannot work here")
        for n in dict.fromkeys(probes):
            err, r = await _probe(fetcher, url_for(n), referer=url)
            if err:
                print(f"  page {n:>3}: {err}")
                continue
            head = (r.content or b"")[:4]
            kind = (
                "JPEG"
                if head[:3] == b"\xff\xd8\xff"
                else ("PNG" if head[:4] == b"\x89PNG" else "not an image")
            )
            print(
                f"  page {n:>3}: HTTP {r.status_code}  "
                f"{len(r.content or b''):>8,} bytes  "
                f"{str(r.headers.get('content-type', '?'))[:24]}  {kind}"
            )
    except Exception as exc:  # noqa: BLE001
        print(f"\npage-image probe failed: {type(exc).__name__}: {exc}")

    print(
        "\nSend this report back. It contains no cookie values; the saved HTML "
        "is the public document page but may include your account identifiers, "
        "so review it before sharing."
    )
    return 0
