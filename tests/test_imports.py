"""Offline tests — no network. Guards the screenshot's ImportError and
the core parsing insights (brace matcher, JSONP strip, page template)."""
import asyncio
import io
import json
import os
import pathlib
import zipfile

import pytest


def test_package_imports():
    # The exact failing line from the screenshot:
    from scribd import ScrapeError, ScribdScraper  # noqa: F401
    from scribd.scraper import ScrapeError as SE2, ScribdScraper as SS2  # noqa: F401
    assert issubclass(ScrapeError, RuntimeError)


def test_brace_matcher_handles_nested_and_script_close():
    from scribd.utils import extract_json_after

    html = 'window.__PRELOADED_STATE__ = {"a": {"b": "</script> {"}, "c": [1, {"d": 2}]}; var x=1;'
    blob = extract_json_after(html, html.find("window.__PRELOADED_STATE__"))
    data = json.loads(blob)
    assert data["a"]["b"] == "</script> {"
    assert data["c"][1]["d"] == 2


def test_parse_doc_url():
    from scribd.extractors import parse_doc_url

    assert parse_doc_url("https://www.scribd.com/document/123456789/Some-Book") == ("document", "123456789")
    assert parse_doc_url("https://www.scribd.com/book/42/X")[0] == "book"
    with pytest.raises(ValueError):
        parse_doc_url("https://example.com/nope")


def test_build_page_template_synthesises_pages():
    from scribd.extractors import build_page_template, extract_content_urls

    html = (
        '<script>window.page1 = {"contentUrl": '
        '"https://html.scribdassets.com/abc/pages/1-deadbeef.jsonp"};</script>'
    )
    urls = extract_content_urls(html)
    # raw-HTML regex path finds it even without valid preloaded state
    assert urls.get(1, "").endswith("pages/1-deadbeef.jsonp")
    tmpl = build_page_template(urls)
    assert tmpl is not None
    assert tmpl.format(n=7) == "https://html.scribdassets.com/abc/pages/7-deadbeef.jsonp"


def test_jsonp_payload_is_stripped():
    from scribd.fetch import _parse_payload, _payload_body

    payload = _parse_payload('window.page3 = {"content": "<p>Hello <b>world</b></p>"};')
    assert payload is not None
    assert _payload_body(payload) == "<p>Hello <b>world</b></p>"


def test_html_to_text_and_markdown():
    from scribd.render import html_to_text

    assert html_to_text("<p>one</p><p>two</p>") == "one\n\ntwo"


class _FakeResp:
    def __init__(self, text, status=200, headers=None, content=None):
        self.text = text
        self.status_code = status
        self.headers = headers or {}
        self.content = content if content is not None else text.encode()


class _FakeFetcher:
    """Serves a 2-page document entirely from memory."""

    PAGE = "https://html.scribdassets.com/abc/pages/{n}-deadbeef.jsonp"
    DOC = "https://www.scribd.com/document/99/Test"

    async def get(self, url, **kw):
        if url == self.DOC or "embeds/99" in url:
            return _FakeResp(
                '<meta property="og:title" content="Test Doc">'
                '<script>window.__PRELOADED_STATE__ = '
                '{"title": "Test Doc", "pageCount": 2};</script>'
                f'<a href="{self.PAGE.format(n=1)}">p1</a>'
            )
        if "oembed" in url:
            return _FakeResp("{}", headers={})
        for n in (1, 2):
            if url == self.PAGE.format(n=n):
                return _FakeResp(
                    f'window.page{n} = {{"content": "<p>page {n} text</p>"}};'
                )
        return _FakeResp("nope", status=404)


def test_scrape_end_to_end_offline():
    from scribd import ScribdScraper

    async def go():
        scraper = ScribdScraper(_FakeFetcher(), log=lambda m: None)
        return await scraper.scrape(_FakeFetcher.DOC)

    doc = asyncio.run(go())
    assert doc.strategy == "jsonp-pages"
    assert doc.meta.title == "Test Doc"
    assert [p.text for p in doc.pages] == ["page 1 text", "page 2 text"]
    assert doc.text == "page 1 text\n\npage 2 text"


def test_cli_format_flag_is_not_a_file(tmp_path):
    # Regression: `-f txt,md,json` must parse as formats, not a filename.
    from scribd.cli import build_parser, collect_urls

    args = build_parser().parse_args(["https://www.scribd.com/document/1/X", "-f", "txt,md"])
    assert args.format == "txt,md"
    assert args.file is None
    assert collect_urls(args) == ["https://www.scribd.com/document/1/X"]

    lst = tmp_path / "urls.txt"
    lst.write_text("# comment\nhttps://www.scribd.com/document/2/Y\n")
    args = build_parser().parse_args(["--file", str(lst)])
    assert collect_urls(args) == ["https://www.scribd.com/document/2/Y"]


def test_cli_missing_urls_file_is_clean_error_not_traceback():
    # Regression from real terminal use: `--file urls.txt` with no such
    # file used to crash with an unhandled FileNotFoundError traceback.
    from scribd.cli import build_parser, run

    args = build_parser().parse_args(["--file", "urls-that-does-not-exist.txt"])
    assert asyncio.run(run(args)) == 2

    args = build_parser().parse_args(
        ["https://www.scribd.com/document/1/X", "--cookies-file", "nope.txt"]
    )
    assert asyncio.run(run(args)) == 2


def test_netscape_loader_keeps_httponly_session_cookies(tmp_path):
    # Regression: exporters mark HttpOnly cookies "#HttpOnly_...".
    # Skipping every "#..." line dropped the actual login session.
    from scribd.cli import _load_netscape

    f = tmp_path / "cookies.txt"
    f.write_text(
        "# Netscape HTTP Cookie File\n"
        "#HttpOnly_www.scribd.com\tTRUE\t/\tTRUE\t1893456000\t_scribd_session\tSECRET\n"
        "www.scribd.com\tFALSE\t/\tFALSE\t1893456000\tlocale\ten\n",
        encoding="utf-8",
    )
    jar = _load_netscape(str(f))
    assert jar["_scribd_session"] == "SECRET"
    assert jar["locale"] == "en"


def test_escaped_json_slashes_are_extracted():
    # Live Scribd embeds the config as JSON, which escapes slashes:
    # "https:\/\/html.scribdassets.com\/…". The old regexes matched
    # nothing here, and every strategy reported "no result" on documents
    # that had loaded fine — the exact failure seen on a real doc.
    from scribd.extractors import build_page_template, extract_content_urls

    html = (
        '<script>window.__PRELOADED_STATE__ = {"pageParams": {'
        '"contentUrl":"https:\\/\\/html.scribdassets.com\\/8l4pg2od2i5wj2e\\/pages\\/1-abc123def456.jsonp",'
        '"pageCount": 95}};</script>'
    )
    urls = extract_content_urls(html)
    assert urls, "escaped-slash content URL was not found"
    tmpl = build_page_template(urls)
    assert tmpl == "https://html.scribdassets.com/8l4pg2od2i5wj2e/pages/{n}-abc123def456.jsonp"


def test_alternative_asset_host_is_extracted():
    from scribd.extractors import build_page_template, extract_content_urls

    html = '<a href="https://html1.scribdassets.com/xyz/pages/1-q9w8e7.jsonp">p1</a>'
    tmpl = build_page_template(extract_content_urls(html))
    assert tmpl == "https://html1.scribdassets.com/xyz/pages/{n}-q9w8e7.jsonp"


def test_html_escaped_slashes_are_extracted():
    from scribd.extractors import extract_content_urls

    html = "https:&#x2F;&#x2F;html.scribdassets.com&#x2F;abc&#x2F;pages&#x2F;1-h4sh.jsonp"
    assert 1 in extract_content_urls(html)


EMBED_HTML = """
<html><body>
<div id="document_scroller">
  <div class="newpage" id="page1">
    <img class="absimg" src="https://html.scribdassets.com/6ysb4bcr7kdognn0/images/1-abc.png">
    <div class="text_layer"><div class="text">1 | P a g e</div>
      <div class="text">UPDATED BOOK LIST</div></div>
  </div>
  <div class="newpage" id="page2">
    <img class="absimg" src="https://html.scribdassets.com/6ysb4bcr7kdognn0/images/2-def.jpg">
    <div class="text_layer"><div class="text">Table of Contents</div></div>
  </div>
  <div class="newpage" id="page3">
    <div class="text_layer"><div class="text">AGRICULTURE</div></div>
  </div>
</div></body></html>
"""


def test_embed_strategy_extracts_pages():
    # Modern Scribd docs render pages as images and expose no
    # /pages/1-*.jsonp asset — the embed page carries the text layer.
    from scribd.fetch import ScrapeContext, build_from_embed

    ctx = ScrapeContext(doc_id="804179430", url="https://www.scribd.com/document/804179430/X")
    doc = build_from_embed(ctx, EMBED_HTML)
    assert doc is not None
    assert doc.strategy == "embed-text"
    assert len(doc.pages) == 3
    assert "UPDATED BOOK LIST" in doc.pages[0].text
    assert "Table of Contents" in doc.pages[1].text
    assert doc.pages[0].image_url.endswith("/images/1-abc.png")
    assert doc.pages[2].image_url is None


def test_embed_strategy_falls_back_to_merged_page():
    from scribd.fetch import ScrapeContext, build_from_embed

    ctx = ScrapeContext(doc_id="1", url="https://www.scribd.com/document/1/X")
    body = "<p>" + ("real document text in one block " * 20) + "</p>"
    doc = build_from_embed(ctx, f"<html><body>{body}</body></html>")
    assert doc is not None and len(doc.pages) == 1
    assert "real document text" in doc.pages[0].text


def test_embed_strategy_is_first_and_scrape_succeeds_with_it():
    from scribd import ScribdScraper
    from scribd.fetch import DEFAULT_STRATEGIES

    names = [s.name for s in DEFAULT_STRATEGIES]
    # jsonp-pages first: it is the only route that returns EVERY page
    assert names[0] == "jsonp-pages"
    assert "embed-text" in names and "pdf-download" in names

    class F:
        async def get(self, url, **kw):
            class R:
                status_code = 200
                headers = {"content-type": "text/html"}
                text = EMBED_HTML
                content = EMBED_HTML.encode()

                def json(self):
                    return {}

            return R()

    async def go():
        return await ScribdScraper(F(), log=lambda m: None).scrape(
            "https://www.scribd.com/document/804179430/X"
        )

    doc = asyncio.run(go())
    assert len(doc.pages) == 3
    assert "AGRICULTURE" in doc.text


CHALLENGE_HTML = """
<!DOCTYPE html><html><head><title>Client Challenge</title></head>
<body><div><h1>Client Challenge</h1>
<p>A required part of this site couldn’t load. This may be due to a browser
extension, network issues, or browser settings. Please check your connection,
disable any ad blockers, or try using a different browser.</p></div></body></html>
"""


def test_challenge_page_is_detected():
    from scribd.blockers import is_substantive, looks_challenged

    assert looks_challenged(CHALLENGE_HTML)
    assert not is_substantive(CHALLENGE_HTML)
    assert not looks_challenged("<html><body><p>real document text</p></body></html>")


def test_embed_strategy_rejects_challenge_page():
    # The reported bug: a challenge page was saved as a 1-page "document"
    # and reported as success ("OK Client Challenge — 1 pages").
    from scribd.blockers import ChallengeError
    from scribd.fetch import ScrapeContext, build_from_embed

    ctx = ScrapeContext(doc_id="1", url="https://www.scribd.com/document/1/X")

    async def go():
        from scribd.fetch import EmbedTextStrategy

        class F:
            async def get(self, url, **kw):
                class R:
                    status_code = 200
                    headers = {"content-type": "text/html"}
                    text = CHALLENGE_HTML
                    content = CHALLENGE_HTML.encode()

                return R()

        return await EmbedTextStrategy().run(ctx, F())

    with pytest.raises(ChallengeError):
        asyncio.run(go())


def test_short_error_page_is_not_a_document():
    from scribd.fetch import ScrapeContext, build_from_embed

    ctx = ScrapeContext(doc_id="1", url="https://www.scribd.com/document/1/X")
    assert build_from_embed(ctx, "<html><body><p>Not found</p></body></html>") is None


def test_fetcher_retries_then_raises_on_challenge():
    from scribd.blockers import ChallengeError
    from scribd.http import Fetcher

    class Resp:
        status_code = 200
        headers = {"content-type": "text/html; charset=utf-8"}
        text = CHALLENGE_HTML
        content = CHALLENGE_HTML.encode()
        request = None

    class Client:
        calls = 0

        async def get(self, url, headers=None):
            Client.calls += 1
            return Resp()

    async def go():
        f = Fetcher(cache_dir=None, retries=2, impersonate=None)
        f._client = Client()
        try:
            await f.get("https://www.scribd.com/document/1/X")
        finally:
            pass

    with pytest.raises(ChallengeError):
        asyncio.run(go())
    assert Client.calls == 3  # 1 try + 2 retries, never treated as success


def test_scrape_error_raised_when_all_strategies_fail():
    from scribd import ScrapeError, ScribdScraper

    class Empty:
        name = "empty"

        async def run(self, ctx, fetcher):
            return None

    async def go():
        scraper = ScribdScraper(object(), strategies=[Empty()], log=lambda m: None)
        await scraper.scrape("https://www.scribd.com/document/1/X")

    with pytest.raises(ScrapeError):
        asyncio.run(go())


# ---------------------------------------------------------------------------
# Full-document PDF from page images
# ---------------------------------------------------------------------------
DOC_PAGE_HTML = """
<html><head><meta property="og:title" content="Scribd"></head><body>
<script>window.__PRELOADED_STATE__ = {"pageParams": {"pageCount": 5}};</script>
<img src="https://html.scribdassets.com/6ysb4bcr7kdognn0/images/1-10b1c7fecb.png?token=T">
<img src="https://html.scribdassets.com/6ysb4bcr7kdognn0/images/2-40c83ec18c.jpg?token=T">
<img src="https://screenshots.scribd.com/Scribd/252_100_85/356/804179430/1.jpeg">
<img src="https://screenshots.scribd.com/Scribd/252_100_85/356/804179430/2.jpeg">
</body></html>
"""


def test_page_image_urls_and_template():
    from scribd.extractors import (
        build_screenshot_template,
        extract_page_image_urls,
        extract_screenshot_urls,
    )

    urls = extract_page_image_urls(DOC_PAGE_HTML)
    assert 1 in urls and 2 in urls
    assert "images/1-10b1c7fecb.png" in urls[1]
    tmpl = build_screenshot_template(extract_screenshot_urls(DOC_PAGE_HTML))
    # The uniform screenshots pattern is what fills in the missing pages.
    assert tmpl == "https://screenshots.scribd.com/Scribd/252_100_85/356/804179430/{n}.jpeg"


def _fake_png(color, size=(60, 80)):
    from io import BytesIO

    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def test_images_merge_into_a_valid_pdf():
    from scribd.fetch import _images_to_pdf

    blobs = [_fake_png("red"), _fake_png("green"), _fake_png("blue")]
    pdf = _images_to_pdf(blobs)
    assert pdf and pdf.startswith(b"%PDF")
    assert pdf.count(b"/Type /Page") >= 3 or pdf.count(b"/Type/Page") >= 3


def test_page_images_strategy_builds_full_pdf():
    """The reported request: 95-page doc must come out as one full PDF."""
    from scribd.fetch import PageImagesPdfStrategy, ScrapeContext

    html = DOC_PAGE_HTML.replace('"pageCount": 5', '"pageCount": 5')

    class Resp:
        def __init__(self, content=b"", ctype="text/html", status=200):
            self.content = content
            self.status_code = status
            self.headers = {"content-type": ctype}
            self.text = content.decode("latin-1", "ignore")

        def json(self):
            import json as _json

            return _json.loads(self.text)

    class F:
        calls = []

        async def get(self, url, **kw):
            F.calls.append(url)
            if "oembed" in url:
                return Resp(b'{"title":"Malawi Book List","author_name":"cherished568"}',
                            "application/json")
            if url.startswith("https://screenshots.scribd.com") or "images/" in url:
                return Resp(_fake_png("white"), "image/png")
            return Resp(html.encode())

    F.calls = []
    ctx = ScrapeContext(doc_id="804179430", url="https://www.scribd.com/document/804179430/X")
    doc = asyncio.run(PageImagesPdfStrategy().run(ctx, F()))
    assert doc is not None
    assert doc.pdf and doc.pdf.startswith(b"%PDF")
    assert doc.complete, "5 of 5 pages should be complete"
    assert len(doc.pages) == 5
    assert doc.meta.title == "Malawi Book List"   # not the literal "Scribd"
    # pages missing from HTML were filled in from the screenshot template
    assert any("screenshots.scribd.com" in u for u in [c for c in F.calls])


def test_partial_result_does_not_stop_the_chain():
    from scribd import ScribdScraper
    from scribd.fetch import Strategy
    from scribd.models import DocumentMeta, Page, ScrapedDocument

    class Partial(Strategy):
        name = "embed-text"

        async def run(self, ctx, fetcher):
            return ScrapedDocument(
                meta=DocumentMeta(doc_id="1", url=ctx.url, page_count=95),
                pages=[Page(number=i, text=f"page {i}") for i in (1, 2, 3)],
                strategy=self.name,
                complete=False,
            )

    class Full(Strategy):
        name = "page-images-pdf"

        async def run(self, ctx, fetcher):
            return ScrapedDocument(
                meta=DocumentMeta(doc_id="1", url=ctx.url, page_count=95),
                strategy=self.name,
                pdf=b"%PDF-1.4 full",
            )

    async def go():
        return await ScribdScraper(
            object(), strategies=[Partial(), Full()], log=lambda m: None
        ).scrape("https://www.scribd.com/document/1/X")

    doc = asyncio.run(go())
    assert doc.strategy == "page-images-pdf" and doc.pdf


def test_pdf_is_exported_even_without_text_pages(tmp_path):
    from scribd.export import write_all
    from scribd.models import DocumentMeta, Page, ScrapedDocument

    doc = ScrapedDocument(
        meta=DocumentMeta(doc_id="1", url="u", title="Full Book", page_count=5),
        pages=[Page(number=i, image_url="x") for i in range(1, 6)],
        strategy="page-images-pdf",
        pdf=b"%PDF-1.4 x",
    )
    written = write_all(doc, tmp_path, ["txt", "pdf"])
    pdfs = [p for p in written if p.suffix == ".pdf"]
    assert pdfs and pdfs[0].read_bytes().startswith(b"%PDF")


# ---------------------------------------------------------------------------
# Regressions from the run that reported "OK — 3 pages" for a 95-page book
# ---------------------------------------------------------------------------
def test_page_count_fallbacks():
    from scribd.extractors import extract_page_count

    assert extract_page_count('<script>{"pageCount": 95}</script>') == 95
    assert extract_page_count("<span>1K views</span><span>95 pages</span>") == 95
    # token payload on page images: {"page_min":1,"page_max":95}
    assert extract_page_count('token=abc"page_max":95,"enforce":true') == 95
    assert extract_page_count("<div>nothing</div>") == 0


def test_embed_partial_detected_from_document_page():
    """The embed page states no total; the document page does. Without
    reading it, 3-of-95 looked complete and the PDF route never ran."""
    from scribd.fetch import EmbedTextStrategy, ScrapeContext

    class Resp:
        def __init__(self, text, ctype="text/html"):
            self.text = text
            self.content = text.encode()
            self.status_code = 200
            self.headers = {"content-type": ctype}

        def json(self):
            import json as _j

            return _j.loads(self.text)

    class F:
        async def get(self, url, **kw):
            if "oembed" in url:
                return Resp('{"title":"Malawi Book List"}', "application/json")
            if "embeds" in url:
                return Resp(EMBED_HTML)          # only 3 pages of markup
            return Resp("<html><body><span>1K views</span> 95 pages</body></html>")

    ctx = ScrapeContext(doc_id="804179430", url="https://www.scribd.com/document/804179430/X")
    doc = asyncio.run(EmbedTextStrategy().run(ctx, F()))
    assert doc is not None
    assert doc.meta.page_count == 95
    assert doc.complete is False, "3 of 95 pages must not be reported as complete"


def test_no_output_files_is_not_a_success(tmp_path):
    """`-f pdf` on a text-only result wrote nothing yet printed '1/1 succeeded'."""
    import argparse

    from scribd import cli

    class FakeScraper:
        def __init__(self, *a, **kw):
            pass

        async def scrape(self, url):
            from scribd.models import DocumentMeta, Page, ScrapedDocument

            return ScrapedDocument(
                meta=DocumentMeta(doc_id="1", url=url, title="T", page_count=95),
                pages=[Page(number=1, text="x")],
                strategy="embed-text",
                complete=False,
            )

    args = argparse.Namespace(
        urls=["https://www.scribd.com/document/1/X"],
        file=None,
        out=str(tmp_path),
        format="pdf",
        markdown=False,
        images=False,
        keep_images=False,
        concurrency=1,
        rate=1000,
        timeout=1,
        retries=0,
        no_cache=True,
        cache_dir=None,
        cookie=None,
        cookies_file=None,
        proxy=None,
        impersonate="none",
        diagnose=False,
    )
    orig_scraper, orig_fetcher = cli.ScribdScraper, cli.Fetcher
    cli.ScribdScraper = FakeScraper
    cli.Fetcher = lambda *a, **kw: _NullFetcher()
    try:
        rc = asyncio.run(cli.run(args))
    finally:
        cli.ScribdScraper, cli.Fetcher = orig_scraper, orig_fetcher
    assert rc == 1, "no files written must exit non-zero"
    assert not list(tmp_path.glob("*.pdf"))


class _NullFetcher:
    backend = "test"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None


def test_page_count_from_image_token_jwt():
    """The token on page images hides {"page_max":95} in base64."""
    from scribd.extractors import extract_page_count

    tok = (
        "eyJhbGciOiJIUzI1NiJ9."
        "eyJleHAiOjE3OTUzOTkwMjMsInBhZ2VfbWluIjoxLCJwYWdlX21heCI6OTUsImVuZm9yY2UiOnRydWV9"
        ".sig12345"
    )
    assert extract_page_count(f'<img src="https://html.scribdassets.com/x/images/1-a.jpg?token={tok}">') == 95


def test_image_strategy_uses_document_total_not_visible_pages():
    """Only 2 image URLs in the markup must not mean a 2-page document."""
    from scribd.fetch import PageImagesPdfStrategy, ScrapeContext

    tok = (
        "eyJhbGciOiJIUzI1NiJ9."
        "eyJwYWdlX21pbiI6MSwicGFnZV9tYXgiOjYwfQ"
        ".sig12345"
    )
    embed = (
        f'<html><body><img src="https://html.scribdassets.com/u/images/1-a.jpg?token={tok}">'
        '<img src="https://screenshots.scribd.com/Scribd/a_b_c/d/9/1.jpeg"></body></html>'
    )
    doc_page = "<html><body><span>60 pages</span></body></html>"

    class Resp:
        def __init__(self, c=b"", ct="text/html", st=200):
            self.content = c
            self.status_code = st
            self.headers = {"content-type": ct}
            self.text = c.decode("latin-1", "ignore")

        def json(self):
            return {}

    class F:
        async def get(self, url, **kw):
            if "embeds" in url:
                return Resp(embed.encode())
            if "oembed" in url:
                return Resp(b"{}", "application/json")
            if "screenshots.scribd.com" in url or "images/" in url:
                return Resp(_fake_png("white"), "image/png")
            return Resp(doc_page.encode())

    ctx = ScrapeContext(doc_id="9", url="https://www.scribd.com/document/9/X")
    doc = asyncio.run(PageImagesPdfStrategy().run(ctx, F()))
    assert doc is not None and doc.pdf
    assert len(doc.pages) == 60, f"expected 60 pages, got {len(doc.pages)}"
    assert doc.complete


# ---------------------------------------------------------------------------
# Verified against a real diagnostic dump (2024 Updated Book List, 95 pages):
# the document page lists all 95 /pages/N-<hash>.jsonp URLs, each page with
# its OWN hash — so a single template built from page 1 404s for the rest.
# ---------------------------------------------------------------------------
def _real_doc_html(pages: int = 95) -> str:
    imgs = "".join(
        f'<img src="https://html.scribdassets.com/6ysb4bcr7kdognn0/pages/{n}-{1000 + n:x}.jsonp">'
        for n in range(1, pages + 1)
    )
    return (
        '<html><head><meta property="og:title" content="Malawi Secondary School Textbooks Guide">'
        '<script>window.docManager = {"id": 804179430};</script></head>'
        f"<body><span>1K views</span> <span>{pages} pages</span>{imgs}</body></html>"
    )


class _RealDocFetcher:
    """Serves the doc page, every per-page JSONP asset, and oEmbed."""

    def __init__(self, pages: int = 95, fail: tuple[int, ...] = ()):
        self.pages = pages
        self.fail = set(fail)
        self.fetched: list[str] = []

    async def get(self, url: str, **kw):
        self.fetched.append(url)

        class R:
            def __init__(self, text: str, ctype="text/html", status=200):
                self.text = text
                self.content = text.encode()
                self.status_code = status
                self.headers = {"content-type": ctype}

            def json(self):
                import json as _j

                return _j.loads(self.text)

        if "oembed" in url:
            return R('{"title":"Malawi Secondary School Textbooks Guide",'
                     '"author_name":"cherished568"}', "application/json")
        m = __import__("re").search(r"/pages/(\d+)-", url)
        if m:
            n = int(m.group(1))
            if n in self.fail:
                return R("nope", status=404)
            if n > self.pages:
                return R("nope", status=404)
            return R(
                f'window.page{n} = {{"content": "<p>page {n} content</p>"}};',
                "application/javascript",
            )
        return R(_real_doc_html(self.pages))


def test_jsonp_pages_uses_each_pages_own_hash():
    from scribd.fetch import JsonpPagesStrategy, ScrapeContext

    f = _RealDocFetcher()
    ctx = ScrapeContext(doc_id="804179430", url="https://www.scribd.com/document/804179430/X")
    doc = asyncio.run(JsonpPagesStrategy().run(ctx, f))
    assert doc is not None, "jsonp-pages must work on the real page shape"
    assert len(doc.pages) == 95, f"expected 95 pages, got {len(doc.pages)}"
    assert doc.complete
    assert doc.meta.page_count == 95
    assert doc.meta.title == "Malawi Secondary School Textbooks Guide"
    assert "page 47 content" in doc.pages[46].text
    # every page URL carried its own hash (no template synthesis)
    got = [u for u in f.fetched if "/pages/" in u]
    assert len(set(got)) == 95


def test_scraper_picks_jsonp_first_and_returns_full_text():
    from scribd import ScribdScraper

    f = _RealDocFetcher()
    doc = asyncio.run(
        ScribdScraper(f, log=lambda m: None).scrape(
            "https://www.scribd.com/document/804179430/X"
        )
    )
    assert doc.strategy == "jsonp-pages"
    assert len(doc.pages) == 95
    assert doc.complete
    assert "page 95 content" in doc.text


def test_jsonp_partial_when_some_pages_fail():
    from scribd.fetch import JsonpPagesStrategy, ScrapeContext

    f = _RealDocFetcher(fail=(2, 3, 4, 5))
    ctx = ScrapeContext(doc_id="1", url="https://www.scribd.com/document/1/X")
    doc = asyncio.run(JsonpPagesStrategy().run(ctx, f))
    assert doc is not None and len(doc.pages) == 91
    assert doc.complete is False, "91 of 95 pages must be flagged partial"


def test_embed_uses_outer_page_containers():
    """The real embed markup uses div.outer_page (95x), not div.newpage."""
    from scribd.fetch import ScrapeContext, build_from_embed

    html = "<html><body><span>95 pages</span>" + "".join(
        f'<div class="outer_page"><div class="text_layer">'
        f'<div class="text">page {n} text</div></div></div>'
        for n in range(1, 96)
    ) + "</body></html>"
    ctx = ScrapeContext(doc_id="1", url="https://www.scribd.com/document/1/X")
    doc = build_from_embed(ctx, html)
    assert doc is not None and len(doc.pages) == 95


def test_jsonp_failures_are_reported_not_swallowed(capsys):
    """The real run said '95 explicit page URLs' then nothing at all —
    every page failed silently, so there was no way to know why."""
    from scribd.fetch import JsonpPagesStrategy, ScrapeContext

    html = (
        "<html><body><span>3 pages</span>"
        '<img src="https://html.scribdassets.com/u/pages/1-abc.jsonp">'
        '<img src="https://html.scribdassets.com/u/pages/2-def.jsonp">'
        '<img src="https://html.scribdassets.com/u/pages/3-ghi.jsonp"></body></html>'
    )

    class R:
        def __init__(self, t="", st=403, ct="text/html"):
            self.text = t
            self.content = t.encode()
            self.status_code = st
            self.headers = {"content-type": ct}

        def json(self):
            return {}

    class F:
        async def get(self, url, **kw):
            if "/pages/" in url:
                return R("Access Denied", 403)
            return R(html, 200)

    logs: list[str] = []
    ctx = ScrapeContext(doc_id="9", url="https://www.scribd.com/document/9/X", log=logs.append)
    assert asyncio.run(JsonpPagesStrategy().run(ctx, F())) is None
    joined = " ".join(logs)
    assert "http:403 x3" in joined, joined


def test_jsonp_sends_referer_to_asset_cdn():
    from scribd.fetch import JsonpPagesStrategy, ScrapeContext

    seen = {}

    class R:
        def __init__(self, t, st=200):
            self.text = t
            self.content = t.encode()
            self.status_code = st
            self.headers = {"content-type": "application/javascript"}

        def json(self):
            return {}

    class F:
        async def get(self, url, **kw):
            if "/pages/" in url:
                seen["referer"] = (kw.get("headers") or {}).get("Referer")
                return R('window.page1 = {"content": "<p>hi</p>"};')
            return R('<html><body><span>1 pages</span>'
                     '<img src="https://html.scribdassets.com/u/pages/1-abc.jsonp"></body></html>')

    ctx = ScrapeContext(doc_id="1", url="https://www.scribd.com/document/1/X")
    doc = asyncio.run(JsonpPagesStrategy().run(ctx, F()))
    assert doc is not None
    assert seen["referer"] == "https://www.scribd.com/document/1/X"


# ---------------------------------------------------------------------------
# Regressions from the real --diagnose crash and the pasted patch review
# ---------------------------------------------------------------------------
def test_diagnose_does_not_crash_when_sections_fail(tmp_path):
    """UnboundLocalError killed the report before the decisive probe."""
    from scribd.diagnose import diagnose

    page = (
        "<html><body>95 pages"
        '<img src="https://html.scribdassets.com/u/pages/1-abc.jsonp">'
        '<img src="https://html.scribdassets.com/u/pages/95-xyz.jsonp"></body></html>'
    )

    class R:
        def __init__(self, t="", st=200, ct="text/html"):
            self.text = t
            self.content = t.encode()
            self.status_code = st
            self.headers = {"content-type": ct}

        def json(self):
            return {}

    class F:
        async def get(self, url, **kw):
            if "/pages/" in url:
                return R('window.page1 = {"content":"<p>hi</p>"}', 200, "application/javascript")
            if "oembed" in url:
                return R("{}", 200, "application/json")
            return R(page)

    rc = asyncio.run(diagnose(F(), "https://www.scribd.com/document/9/X", save_dir=tmp_path))
    assert rc == 0


def test_diagnose_reports_jsonp_probe_results(capsys, tmp_path):
    """The report must state what the page assets actually return."""
    from scribd.diagnose import diagnose

    page = ('<html><body>95 pages'
            '<img src="https://html.scribdassets.com/u/pages/1-abc.jsonp"></body></html>')

    class R:
        def __init__(self, t="", st=200, ct="text/html"):
            self.text = t
            self.content = t.encode()
            self.status_code = st
            self.headers = {"content-type": ct}

        def json(self):
            return {}

    class F:
        async def get(self, url, **kw):
            if "/pages/" in url:
                return R("<html>denied</html>", 403)
            if "oembed" in url:
                return R("{}", 200, "application/json")
            return R(page)

    asyncio.run(diagnose(F(), "https://www.scribd.com/document/9/X", save_dir=tmp_path))
    out = capsys.readouterr().out
    assert "jsonp page assets to probe: 1" in out
    assert "HTTP 403" in out


def test_images_to_pdf_skips_corrupt_blobs():
    """One bad chunk must not destroy the whole PDF."""
    from scribd.fetch import _images_to_pdf

    good = _fake_png("red")
    skipped: list[int] = []
    pdf = _images_to_pdf([good, b"not an image", b"", _fake_png("blue")], skipped=skipped)
    assert pdf and pdf.startswith(b"%PDF")
    assert skipped == [2, 3]


def test_image_strategy_isolates_fetch_failures():
    from scribd.fetch import PageImagesPdfStrategy, ScrapeContext

    html = (
        "<html><body>4 pages"
        '<img src="https://screenshots.scribd.com/Scribd/a_b/c/9/1.jpeg">'
        "</body></html>"
    )

    class R:
        def __init__(self, c=b"", ct="image/png", st=200):
            self.content = c
            self.text = c.decode("latin-1", "ignore")
            self.status_code = st
            self.headers = {"content-type": ct}

        def json(self):
            return {}

    class F:
        calls = 0

        async def get(self, url, **kw):
            if "screenshots.scribd.com" in url:
                F.calls += 1
                n = int(url.rsplit("/", 1)[-1].split(".")[0])
                if n == 2:
                    raise RuntimeError("network hiccup")
                return R(_fake_png("white"))
            if "oembed" in url:
                return R(b"{}", "application/json")
            return R(html.encode())

    logs: list[str] = []
    ctx = ScrapeContext(doc_id="9", url="https://www.scribd.com/document/9/X", log=logs.append)
    doc = asyncio.run(PageImagesPdfStrategy().run(ctx, F()))
    assert doc is not None and doc.pdf, "a single failed page must not abort the build"
    assert len(doc.pages) == 3, f"expected 3 of 4 pages, got {len(doc.pages)}"
    assert any("failures" in m for m in logs), logs


# ---------------------------------------------------------------------------
# The 403 cause: signed page-asset URLs were truncated at ".jsonp",
# dropping "?token=..." — every fetch was then unauthorised.
# ---------------------------------------------------------------------------
def test_jsonp_urls_keep_their_token_query():
    from scribd.extractors import build_page_template, extract_content_urls

    html = (
        '<img src="https://html.scribdassets.com/6ysb4bcr7kdognn0/pages/1-10b1c7.jsonp'
        '?token=eyJhbGciOiJIUzI1NiJ9.eyJwYWdlX21heCI6OTV9.sig123">'
    )
    urls = extract_content_urls(html)
    assert urls[1].endswith("?token=eyJhbGciOiJIUzI1NiJ9.eyJwYWdlX21heCI6OTV9.sig123")
    assert "?token=" in build_page_template(urls)


def test_wildcard_cdn_subdomains_and_webp():
    from scribd.extractors import extract_content_urls, extract_page_image_urls

    html = (
        '<img src="https://html1.scribdassets.com/u/pages/2-abc.jsonp">'
        '<img src="https://html.scribdassets.com/u/images/1-x.webp">'
        '<img src="https://imgv2-1.scribdassets.com/u/images/2-y.jpg?x=1">'
    )
    assert 2 in extract_content_urls(html)
    assert set(extract_page_image_urls(html)) == {1, 2}


def test_screenshot_regex_stays_on_its_own_host():
    """A *.scribd.com wildcard would match unrelated URLs as 'pages'."""
    from scribd.extractors import extract_page_image_urls

    html = (
        '<img src="https://screenshots.scribd.com/Scribd/a_b_c/d/9/7.jpeg">'
        '<a href="https://www.scribd.com/document/123/Some-3">x</a>'
    )
    assert set(extract_page_image_urls(html)) == {7}


def test_browser_strategy_is_last_and_degrades_quietly(monkeypatch):
    import sys

    from scribd.fetch import DEFAULT_STRATEGIES, ScrapeContext
    from scribd.browser import BrowserStrategy, clean_pages

    assert DEFAULT_STRATEGIES[-1].name == "browser"

    logs: list[str] = []
    ctx = ScrapeContext(doc_id="1", url="https://www.scribd.com/document/1/X", log=logs.append)
    monkeypatch.setitem(sys.modules, "playwright", None)
    monkeypatch.setitem(sys.modules, "playwright.async_api", None)
    assert asyncio.run(BrowserStrategy().run(ctx, object())) is None
    assert any("playwright not installed" in m for m in logs), logs

    pages = clean_pages(["  page one  ", "", "x", "page two "], min_words=2)
    assert [p.number for p in pages] == [1, 2]
    assert pages[0].text == "page one"


# ---------------------------------------------------------------------------
# Browser route: lazy-loaded pages only appear after scrolling
# ---------------------------------------------------------------------------
def test_dedupe_entries_collapses_duplicate_containers():
    """The real DOM had 124 containers for a 95-page document."""
    from scribd.browser import dedupe_entries, entries_to_pages

    entries = [
        {"text": "page one", "image": "u1"},
        {"text": "page one", "image": "u1"},          # wrapper duplicate
        {"text": "", "image": "u2", "screenshot": b"png"},   # image-only kept
        {"text": " ", "image": ""},                    # empty -> dropped
        {"text": "third page here", "image": "u3"},
    ]
    kept = dedupe_entries(entries)
    assert len(kept) == 3
    pages = entries_to_pages(kept)
    assert [p.number for p in pages] == [1, 2, 3]
    assert pages[1].image_url == "u2"
    assert pages[2].text == "third page here"


def _fake_playwright(monkeypatch, *, containers=12, unique=8, fail_shots=0):
    """Install a fake playwright module; returns the capture log."""
    import sys
    import types

    from scribd.browser import PAGE_INFO_JS

    log = {"scrolled": [], "collected": False, "cookies": None}

    class FakeLocator:
        def __init__(self, i):
            self.i = i

        async def scroll_into_view_if_needed(self, timeout=None):
            log["scrolled"].append(self.i)

        def locator(self, sel):
            return FakeLocator(self.i)

        @property
        def first(self):
            return self

        async def evaluate(self, script, arg=None):
            if "Promise" in str(script):
                return True
            return {
                "text": f"page {(self.i % unique) + 1} text",
                "image": f"https://html.scribdassets.com/u/images/{(self.i % unique) + 1}-a.jpg",
                "imageReady": True,
            }

        async def screenshot(self, **kw):
            if self.i < fail_shots:
                raise RuntimeError("screenshot failed")
            return _fake_png("white")

    class FakeLocators:
        def __init__(self, n):
            self.n = n

        async def count(self):
            return self.n

        def nth(self, i):
            return FakeLocator(i)

    class FakePage:
        async def goto(self, *a, **kw):
            return None

        async def wait_for_selector(self, *a, **kw):
            return None

        async def wait_for_timeout(self, ms):
            return None

        def locator(self, sel):
            return FakeLocators(containers)

        async def evaluate(self, *a, **kw):
            log["collected"] = True
            return {}

        async def content(self):
            return f"<html><body><span>{unique} pages</span></body></html>"

        async def pdf(self, **kw):
            return b"%PDF-printed"

    class FakeContext:
        async def add_cookies(self, cookies):
            log["cookies"] = cookies

        async def new_page(self):
            return FakePage()

    class FakeBrowser:
        async def new_context(self, **kw):
            return FakeContext()

        async def close(self):
            return None

    class FakePW:
        class chromium:
            @staticmethod
            async def launch(headless=True):
                return FakeBrowser()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    fake = types.ModuleType("playwright.async_api")
    fake.async_playwright = lambda: FakePW()
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.async_api", fake)
    assert PAGE_INFO_JS
    return log


def test_browser_captures_every_page_one_by_one(monkeypatch):
    """Regression: the old strategy scrolled the window 4 steps and got 15/95."""
    from scribd.browser import BrowserStrategy
    from scribd.fetch import ScrapeContext

    log = _fake_playwright(monkeypatch, containers=12, unique=8)

    class Fetcher:
        cookies = {"_scribd_session": "SECRET"}

        async def get(self, url, **kw):
            class R:
                status_code = 200

                def json(self):
                    return {"title": "Real Title", "author_name": "someone"}

            return R()

    logs: list[str] = []
    ctx = ScrapeContext(doc_id="9", url="https://www.scribd.com/document/9/X", log=logs.append)
    doc = asyncio.run(BrowserStrategy().run(ctx, Fetcher()))

    # every container was visited individually (not one window scroll);
    # the print pass re-scrolls each page, so only the first 12 must match.
    assert log["scrolled"][:12] == list(range(12)), log["scrolled"]
    assert log["cookies"][0]["name"] == "_scribd_session"
    assert doc is not None and doc.pdf and doc.pdf.startswith(b"%PDF")
    # 12 containers collapse to 8 unique pages
    assert len(doc.pages) == 8, len(doc.pages)
    assert doc.meta.title == "Real Title"
    assert doc.strategy == "browser"
    assert any("screenshots" in m for m in logs), logs


def test_browser_survives_failed_screenshots(monkeypatch):
    from scribd.browser import BrowserStrategy
    from scribd.fetch import ScrapeContext

    _fake_playwright(monkeypatch, containers=6, unique=6, fail_shots=2)

    class Fetcher:
        cookies = {}

        async def get(self, url, **kw):
            class R:
                status_code = 200

                def json(self):
                    return {}

            return R()

    logs: list[str] = []
    ctx = ScrapeContext(doc_id="9", url="https://www.scribd.com/document/9/X", log=logs.append)
    doc = asyncio.run(BrowserStrategy().run(ctx, Fetcher()))
    assert doc is not None
    assert doc.pages, "text is still captured when a screenshot fails"
    assert doc.pdf is not None  # falls back to the browser print


# ---------------------------------------------------------------------------
# Ported from Phoenix124/scribd-downloader and youngpiu/scribd-pdf-downloader
# ---------------------------------------------------------------------------
def test_callback_array_payload_form():
    """Scribd's page assets use window.pageN_callback(["<html>"]).

    Our parser only understood window.pageN = {...}, so real pages came back
    as 'unparsed-payload' and every page failed.
    """
    from scribd.fetch import _parse_payload, _payload_body

    text = 'window.page12_callback(["<div><span class=\'a\'>Hello</span></div>"]);'
    payload = _parse_payload(text)
    assert isinstance(payload, list)
    assert "Hello" in _payload_body(payload)

    # the object form must keep working too
    assert _payload_body(_parse_payload('window.page3 = {"content": "<p>x</p>"};')) == "<p>x</p>"


def test_text_spans_extraction():
    from scribd.fetch import _text_spans

    html = (
        '<div class="text_layer">'
        '<span class="a">line one</span><span class="a">line two</span>'
        '<span class="b">ignore</span></div>'
    )
    assert _text_spans(html) == "line one\nline two"


def test_jsonp_to_image_url():
    from scribd.extractors import jsonp_to_image_url

    assert jsonp_to_image_url(
        "https://html.scribdassets.com/u/pages/12-abc.jsonp?token=T"
    ) == "https://html.scribdassets.com/u/images/12-abc.jpg?token=T"
    assert jsonp_to_image_url("https://example.com/nope") is None


def test_orig_attribute_beats_lazy_src():
    """src is a placeholder (answers with HTML); orig is the real asset."""
    from scribd.extractors import extract_page_image_urls

    html = (
        '<img class="absimg" src="/static/placeholder.gif" '
        'orig="https://imgv2-1-f.scribdassets.com/u/pages/5-x.jpg">'
    )
    urls = extract_page_image_urls(html)
    assert urls[5] == "https://imgv2-1-f.scribdassets.com/u/pages/5-x.jpg"


def test_jsonp_strategy_uses_spans_and_derives_image():
    from scribd.fetch import JsonpPagesStrategy, ScrapeContext

    html = (
        '<html><body><span>2 pages</span>'
        '<img src="https://html.scribdassets.com/u/pages/1-aaa.jsonp">'
        '<img src="https://html.scribdassets.com/u/pages/2-bbb.jsonp"></body></html>'
    )

    class R:
        def __init__(self, t, st=200, ct="text/html"):
            self.text = t
            self.content = t.encode()
            self.status_code = st
            self.headers = {"content-type": ct}

        def json(self):
            return {}

    class F:
        async def get(self, url, **kw):
            if "/pages/1-" in url:
                return R('window.page1_callback(["<span class=\'a\'>alpha</span>"]);')
            if "/pages/2-" in url:
                return R('window.page2_callback(["<span class=\'a\'>beta</span>"]);')
            if "oembed" in url:
                return R('{"title":"T"}', 200, "application/json")
            return R(html)

    ctx = ScrapeContext(doc_id="9", url="https://www.scribd.com/document/9/X")
    doc = asyncio.run(JsonpPagesStrategy().run(ctx, F()))
    assert doc is not None
    assert [p.text for p in doc.pages] == ["alpha", "beta"]
    assert doc.pages[0].image_url and "/images/1-aaa.jpg" in doc.pages[0].image_url


def test_browser_scroll_pass_and_print_pdf(monkeypatch):
    """Scroll pass forces pages into the DOM; print gives a real PDF."""
    from scribd.browser import BrowserStrategy, PRINT_JS, SCROLL_PAGES_JS
    from scribd.fetch import ScrapeContext

    seen = {"scroll": False, "print_css": False, "pdf_kwargs": None}

    class Locator:
        def __init__(self, i):
            self.i = i

        async def scroll_into_view_if_needed(self, timeout=None):
            return None

        def locator(self, sel):
            return self

        @property
        def first(self):
            return self

        async def evaluate(self, script, arg=None):
            return {"text": f"page {self.i} text", "image": ""}

        async def screenshot(self, **kw):
            return b""

    class Locators:
        def __init__(self, n):
            self.n = n

        async def count(self):
            return self.n

        def nth(self, i):
            return Locator(i)

    class Page:
        async def goto(self, *a, **kw):
            return None

        async def wait_for_selector(self, *a, **kw):
            return None

        async def wait_for_timeout(self, ms):
            return None

        def locator(self, sel):
            return Locators(3)

        async def evaluate(self, script, arg=None):
            if script == SCROLL_PAGES_JS:
                seen["scroll"] = True
                return {"selector": "div.outer_page", "pages": 3, "rounds": 2}
            if script == PRINT_JS:
                seen["print_css"] = True
                return {"widthIn": 7.5, "heightIn": 10.0}
            return {}

        async def content(self):
            return "<html><body><span>3 pages</span></body></html>"

        async def pdf(self, **kw):
            seen["pdf_kwargs"] = kw
            return b"%PDF-official"

    class Context:
        async def add_cookies(self, c):
            return None

        async def new_page(self):
            return Page()

    class Browser:
        async def new_context(self, **kw):
            return Context()

        async def close(self):
            return None

    class PW:
        class chromium:
            @staticmethod
            async def launch(headless=True):
                return Browser()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    import sys, types
    fake = types.ModuleType("playwright.async_api")
    fake.async_playwright = lambda: PW()
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.async_api", fake)

    class Fetcher:
        cookies = {}

        async def get(self, url, **kw):
            class R:
                status_code = 200

                def json(self):
                    return {"title": "Printed Doc"}

            return R()

    ctx = ScrapeContext(doc_id="9", url="https://www.scribd.com/document/9/X")
    doc = asyncio.run(BrowserStrategy(screenshot=False).run(ctx, Fetcher()))

    assert seen["scroll"], "the scroll pass must run before capture"
    assert seen["print_css"], "print CSS must be injected"
    assert seen["pdf_kwargs"]["prefer_css_page_size"] is True
    assert doc is not None and doc.pdf == b"%PDF-official"
    assert len(doc.pages) == 3


# ---------------------------------------------------------------------------
# "It is still taking screenshots of the whole page, not just the book page"
# Ported from themrsami/scribd-downloader (one page per sheet, sized to the
# page) and xDatx/Studocu-Scribd-Helper (isolate the viewer, hide the UI).
# ---------------------------------------------------------------------------
def _one_page_pdf(width_pt: float, height_pt: float) -> bytes:
    from io import BytesIO

    from pypdf import PdfWriter

    w = PdfWriter()
    w.add_blank_page(width=width_pt, height=height_pt)
    out = BytesIO()
    w.write(out)
    return out.getvalue()


def test_px_to_inches():
    from scribd.pdfprint import px_to_inches

    assert px_to_inches(96) == 1.0
    assert px_to_inches(816) == 8.5      # US Letter width in CSS px
    assert px_to_inches(1056) == 11.0


def test_merge_pdfs_keeps_order_and_sizes():
    from scribd.pdfprint import count_pages, merge_pdfs

    parts = [
        _one_page_pdf(612, 792),   # letter
        _one_page_pdf(595, 842),   # A4
        _one_page_pdf(400, 600),   # odd size
    ]
    merged = merge_pdfs(parts)
    assert merged and merged.startswith(b"%PDF")
    assert count_pages(merged) == 3

    from io import BytesIO

    from pypdf import PdfReader

    sizes = [
        (round(float(p.mediabox.width)), round(float(p.mediabox.height)))
        for p in PdfReader(BytesIO(merged)).pages
    ]
    assert sizes == [(612, 792), (595, 842), (400, 600)]


def test_merge_pdfs_skips_junk():
    from scribd.pdfprint import count_pages, merge_pdfs

    merged = merge_pdfs([_one_page_pdf(100, 100), b"<html>not a pdf</html>", b""])
    assert merged and count_pages(merged) == 1
    assert merge_pdfs([b"junk"]) is None


def test_isolation_js_and_cleanup_js_are_valid():
    import shutil
    import subprocess

    node = shutil.which("node")
    from scribd.pdfprint import CLEANUP_JS, ISOLATE_PAGE_JS

    if not node:  # pragma: no cover - sandbox without node
        pytest.skip("node not available")
    for name, script in (("ISOLATE_PAGE_JS", ISOLATE_PAGE_JS), ("CLEANUP_JS", CLEANUP_JS)):
        proc = subprocess.run(
            [node, "-e", f"new Function('return ' + {script!r}); console.log('ok')"],
            capture_output=True,
            text=True,
        )
        assert proc.returncode == 0, f"{name} is not valid JS: {proc.stderr}"
    # the sheet must be sized by CSS @page and anchored to the paper, not the
    # scrolled viewport, and the viewer must be hidden outright
    assert "@page { size:" in ISOLATE_PAGE_JS
    assert "position: fixed" in ISOLATE_PAGE_JS
    assert "cloneNode(true)" in ISOLATE_PAGE_JS
    assert "display: none !important" in ISOLATE_PAGE_JS
    assert "getComputedStyle(target)" in ISOLATE_PAGE_JS


def test_isolate_js_one_page_per_sheet_in_mock_dom():
    """Run ISOLATE_PAGE_JS/CLEANUP_JS against a fake Scribd DOM (node).

    Three pages, inline ``width: 100%`` (the value that used to be parsed as
    a 100px-wide sheet), a scaled viewer rect, and toolbars around them.
    """
    import json
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:  # pragma: no cover - sandbox without node
        pytest.skip("node not available")
    from scribd.embedprint import ISOLATE_PAGE_JS as EMBED_ISOLATE_JS
    from scribd.pdfprint import CLEANUP_JS, ISOLATE_PAGE_JS

    script = pathlib.Path(__file__).with_name("mock_dom.js")
    proc = subprocess.run(
        [node, str(script)],
        input=json.dumps(
            {
                "isolate": ISOLATE_PAGE_JS,
                "cleanup": CLEANUP_JS,
                "embedIsolate": EMBED_ISOLATE_JS,
            }
        ),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout


def test_browser_prints_one_sheet_per_page(monkeypatch):
    """Each document page becomes exactly one PDF sheet of its own size."""
    import sys
    import types

    from scribd.browser import BrowserStrategy
    from scribd.fetch import ScrapeContext
    from scribd.pdfprint import ISOLATE_PAGE_JS, count_pages

    # 3 pages of different sizes; each print returns a 1-sheet PDF of that size.
    sizes_px = [(816, 1056), (612, 792), (700, 900)]
    printed: list[dict] = []

    class Locator:
        def __init__(self, i):
            self.i = i

        async def scroll_into_view_if_needed(self, timeout=None):
            return None

        def locator(self, sel):
            return self

        @property
        def first(self):
            return self

        async def evaluate(self, script, arg=None):
            return {"text": f"page {self.i} text", "image": ""}

        async def screenshot(self, **kw):
            return b""

    class Locators:
        def __init__(self, n):
            self.n = n

        async def count(self):
            return self.n

        def nth(self, i):
            return Locator(i)

    class Page:
        async def goto(self, *a, **kw):
            return None

        async def wait_for_selector(self, *a, **kw):
            return None

        async def wait_for_timeout(self, ms):
            return None

        def locator(self, sel):
            return Locators(len(sizes_px))

        async def evaluate(self, script, arg=None):
            if script == ISOLATE_PAGE_JS:
                w, h = sizes_px[arg["index"]]
                # mirror the real ISOLATE_PAGE_JS: @page gets a 4px pad
                return {"width": w, "height": h, "pageWidth": w + 4, "pageHeight": h + 4}
            if "synthetic-pages" in str(script):
                return {"selector": "div.outer_page", "pages": 3, "rounds": 1}
            return {}

        async def content(self):
            return "<html><body><span>3 pages</span></body></html>"

        async def pdf(self, **kw):
            printed.append(kw)
            w = float(str(kw["width"]).rstrip("in")) * 72
            h = float(str(kw["height"]).rstrip("in")) * 72
            return _one_page_pdf(w, h)

    class Context:
        async def add_cookies(self, c):
            return None

        async def new_page(self):
            return Page()

    class Browser:
        async def new_context(self, **kw):
            return Context()

        async def close(self):
            return None

    class PW:
        class chromium:
            @staticmethod
            async def launch(headless=True):
                return Browser()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    fake = types.ModuleType("playwright.async_api")
    fake.async_playwright = lambda: PW()
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.async_api", fake)

    class Fetcher:
        cookies = {}

        async def get(self, url, **kw):
            class R:
                status_code = 200

                def json(self):
                    return {"title": "Sheet Per Page"}

            return R()

    logs: list[str] = []
    ctx = ScrapeContext(doc_id="9", url="https://www.scribd.com/document/9/X", log=logs.append)
    doc = asyncio.run(BrowserStrategy(screenshot=False).run(ctx, Fetcher()))

    # one print call per document page, never one print of the whole window
    assert len(printed) == 3, printed
    assert all(p.get("prefer_css_page_size") is True for p in printed)
    # belt and braces: pageRanges "1" caps every print at one sheet
    assert all(p.get("page_ranges") == "1" for p in printed)
    assert all(p["margin"] == {"top": "0", "bottom": "0", "left": "0", "right": "0"}
               for p in printed)
    # sizes converted 96px -> inches, plus the 4px pad
    assert abs(float(str(printed[0]["width"]).rstrip("in")) - (816 + 4) / 96) < 0.001

    assert doc is not None and doc.pdf
    assert count_pages(doc.pdf) == 3, count_pages(doc.pdf)
    assert any("one sheet each" in m for m in logs), logs
    assert any("page 1 -> 1 sheet" in m for m in logs), logs


def test_image_to_pdf_and_pdf_page_sizes():
    """The raster fallback makes a one-sheet PDF sized to the image."""
    from scribd.pdfprint import count_pages, image_to_pdf, pdf_page_sizes

    pdf = image_to_pdf(_fake_png("white", size=(192, 288)))
    assert pdf and pdf.startswith(b"%PDF")
    assert count_pages(pdf) == 1
    # 192x288 px at 96 dpi = 2x3 in = 144x216 pt
    w, h = pdf_page_sizes(pdf)[0]
    assert abs(w - 144) <= 1 and abs(h - 216) <= 1, (w, h)
    assert image_to_pdf(b"") is None
    assert image_to_pdf(b"not an image") is None
    assert pdf_page_sizes(b"junk") == []


def test_print_failure_falls_back_to_a_single_image_sheet(monkeypatch):
    """If a page prints as 2 sheets, keep one raster sheet instead of 2."""
    import sys
    import types

    from scribd.browser import BrowserStrategy
    from scribd.fetch import ScrapeContext
    from scribd.pdfprint import ISOLATE_PAGE_JS, count_pages

    printed: list[dict] = []

    class Locator:
        def __init__(self, i):
            self.i = i

        async def scroll_into_view_if_needed(self, timeout=None):
            return None

        def locator(self, sel):
            return self

        @property
        def first(self):
            return self

        async def evaluate(self, script, arg=None):
            return {"text": f"page {self.i} text", "image": ""}

        async def screenshot(self, **kw):
            return _fake_png("white")

    class Locators:
        def __init__(self, n):
            self.n = n

        async def count(self):
            return self.n

        def nth(self, i):
            return Locator(i)

        async def screenshot(self, **kw):
            return _fake_png("white", size=(300, 400))

    class Page:
        async def goto(self, *a, **kw):
            return None

        async def wait_for_selector(self, *a, **kw):
            return None

        async def wait_for_timeout(self, ms):
            return None

        def locator(self, sel):
            return Locators(2)

        async def evaluate(self, script, arg=None):
            if script == ISOLATE_PAGE_JS:
                return {"width": 300, "height": 400, "pageWidth": 304, "pageHeight": 404}
            return {}

        async def content(self):
            return "<html><body><span>2 pages</span></body></html>"

        async def pdf(self, **kw):
            printed.append(kw)
            # every print overflows into two sheets -> must not be trusted
            from io import BytesIO

            from pypdf import PdfWriter

            w = PdfWriter()
            w.add_blank_page(width=200, height=300)
            w.add_blank_page(width=200, height=300)
            out = BytesIO()
            w.write(out)
            return out.getvalue()

    class Context:
        async def add_cookies(self, c):
            return None

        async def new_page(self):
            return Page()

    class Browser:
        async def new_context(self, **kw):
            return Context()

        async def close(self):
            return None

    class PW:
        class chromium:
            @staticmethod
            async def launch(headless=True):
                return Browser()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    fake = types.ModuleType("playwright.async_api")
    fake.async_playwright = lambda: PW()
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.async_api", fake)

    class Fetcher:
        cookies = {}

        async def get(self, url, **kw):
            class R:
                status_code = 200

                def json(self):
                    return {"title": "Fallback Doc"}

            return R()

    logs: list[str] = []
    ctx = ScrapeContext(doc_id="9", url="https://www.scribd.com/document/9/X", log=logs.append)
    doc = asyncio.run(BrowserStrategy(screenshot=False).run(ctx, Fetcher()))

    assert doc is not None and doc.pdf
    # 2 pages -> 2 sheets, even though the printer produced 4
    assert count_pages(doc.pdf) == 2, count_pages(doc.pdf)
    assert sum("printed as image" in m for m in logs) == 2, logs


# ---------------------------------------------------------------------------
# themrsami/scribd-downloader's export path: embed viewer + docManager page
# loading + CDP Page.printToPDF per page + pypdf merge.
# ---------------------------------------------------------------------------
def test_embed_url_conversion():
    from scribd.embedprint import embed_url

    assert embed_url(doc_id="804179430") == (
        "https://www.scribd.com/embeds/804179430/content"
    )
    assert embed_url(
        url="https://www.scribd.com/document/804179430/2024-Updated-Book-List"
    ) == "https://www.scribd.com/embeds/804179430/content"
    # legacy /doc/ URLs
    assert embed_url(url="https://www.scribd.com/doc/12345/Title") == (
        "https://www.scribd.com/embeds/12345/content"
    )
    assert embed_url(url="https://example.com/document/1/x") == ""
    assert embed_url() == ""


def test_embedprint_scripts_are_valid_js():
    import shutil
    import subprocess

    node = shutil.which("node")
    from scribd import embedprint

    scripts = {
        "LOAD_ALL_PAGES_JS": embedprint.LOAD_ALL_PAGES_JS,
        "LOAD_PAGE_BATCH_JS": embedprint.LOAD_PAGE_BATCH_JS,
        "RELEASE_PAGE_BATCH_JS": embedprint.RELEASE_PAGE_BATCH_JS,
        "PREPARE_JS": embedprint.PREPARE_JS,
        "HIDE_COOKIES_JS": embedprint.HIDE_COOKIES_JS,
        "PRINT_CSS_JS": embedprint.PRINT_CSS_JS,
        "WAIT_SETTLE_JS": embedprint.WAIT_SETTLE_JS,
        "MEASURE_PAPER_JS": embedprint.MEASURE_PAPER_JS,
        "ISOLATE_PAGE_JS": embedprint.ISOLATE_PAGE_JS,
    }
    if not node:  # pragma: no cover - sandbox without node
        pytest.skip("node not available")
    for name, script in scripts.items():
        proc = subprocess.run(
            [node, "-e", f"new Function('return ' + {script!r}); console.log('ok')"],
            capture_output=True,
            text=True,
        )
        assert proc.returncode == 0, f"{name} is not valid JS: {proc.stderr}"
    # the exported sheet must be capped at one page and sized from CSS
    import inspect

    printer = inspect.getsource(embedprint.EmbedPrintStrategy._print_one)
    assert '"pageRanges": "1"' in printer, printer
    assert '"preferCSSPageSize": True' in printer, printer
    assert '"scale": 1' in printer, printer
    assert "@page" in embedprint.ISOLATE_PAGE_JS
    assert "window.docManager" in embedprint.LOAD_ALL_PAGES_JS
    # a page that is a direct child of <body> must not be caught by the
    # "hide site chrome" rule (it would beat the target rule on specificity)
    assert "body > *:not(.outer_page):not(:has(" in embedprint.PRINT_CSS_JS


def test_embedprint_exports_one_sheet_per_page(monkeypatch):
    """3 pages -> 3 CDP printToPDF calls, one sheet each, merged in order."""
    import base64
    import sys
    import types

    from scribd import embedprint
    from scribd.fetch import ScrapeContext
    from scribd.pdfprint import count_pages, pdf_page_sizes

    sizes_px = [(816, 1056), (612, 792), (700, 900)]
    printed: list[dict] = []
    batches: list[list[int]] = []
    released: list[list[int]] = []
    visited: list[str] = []
    tabs: list[object] = []

    class CDP:
        async def send(self, method, params=None):
            if method == "Page.printToPDF":
                printed.append(params or {})
                w = float(params["paperWidth"]) * 72
                h = float(params["paperHeight"]) * 72
                return {"data": base64.b64encode(_one_page_pdf(w, h)).decode("ascii")}
            return {}

    class Page:
        async def goto(self, url, **kw):
            visited.append(url)

        async def wait_for_selector(self, *a, **kw):
            return None

        def locator(self, sel):
            class L:
                async def count(self):
                    return len(sizes_px)

            return L()

        async def content(self):
            return "<html><head><title>Embed Title</title></head><body></body></html>"

        async def evaluate(self, script, arg=None):
            if script == embedprint.COUNT_PAGES_JS:
                return {"supported": True, "fromManager": 3, "fromDom": 3, "count": 3}
            if script == embedprint.PREPARE_JS:
                return {"toolbarTop": True, "toolbarBottom": True, "containers": 1}
            if script == embedprint.HIDE_COOKIES_JS:
                return 2
            if script == embedprint.PRINT_CSS_JS:
                return True
            if script == embedprint.WAIT_SETTLE_JS:
                return {"timedOut": False}
            if script == embedprint.LOAD_PAGE_BATCH_JS:
                batches.append(list(arg["pageNumbers"]))
                return {"supported": True, "failed": []}
            if script == embedprint.RELEASE_PAGE_BATCH_JS:
                released.append(list(arg))
                return len(arg)
            if script == embedprint.ISOLATE_PAGE_JS:
                w, h = sizes_px[arg]
                return {"width": w, "height": h, "text": f"page {arg + 1} text",
                        "images": 1, "ready": 1}
            return {}

    class Context:
        async def add_cookies(self, cookies):
            return None

        async def new_page(self):
            page = Page()
            tabs.append(page)
            return page

        async def new_cdp_session(self, page):
            return CDP()

    class Browser:
        async def new_context(self, **kw):
            return Context()

        async def close(self):
            return None

    class PW:
        class chromium:
            @staticmethod
            async def launch(headless=True, args=None):
                return Browser()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    fake = types.ModuleType("playwright.async_api")
    fake.async_playwright = lambda: PW()
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.async_api", fake)

    class Fetcher:
        cookies = {"_scribd_session": "SECRET"}

        async def get(self, url, **kw):
            class R:
                status_code = 200

                def json(self):
                    return {"title": "Embed Title"}

            return R()

    logs: list[str] = []
    ctx = ScrapeContext(
        doc_id="804179430",
        url="https://www.scribd.com/document/804179430/Title",
        log=logs.append,
    )
    doc = asyncio.run(
        embedprint.EmbedPrintStrategy(batch_size=2, workers=2).run(ctx, Fetcher())
    )

    # the bare embed viewer, not the full document page (one tab per worker)
    assert visited and set(visited) == {
        "https://www.scribd.com/embeds/804179430/content"
    }, visited
    assert len(tabs) == 2, len(tabs)

    # one CDP print per document page, each capped to a single sheet
    assert len(printed) == 3, printed
    assert all(p.get("pageRanges") == "1" for p in printed)
    assert all(p.get("preferCSSPageSize") is True for p in printed)
    assert all(p.get("scale") == 1 for p in printed)
    assert all(
        p.get("marginTop") == p.get("marginBottom") == 0
        and p.get("marginLeft") == p.get("marginRight") == 0
        for p in printed
    )
    # paper size = measured px / 96, exactly like the upstream script
    widths = sorted(round(p["paperWidth"] * 96) for p in printed)
    assert widths == [612, 700, 816], widths

    # pages are loaded and released in bounded batches, split between tabs
    assert sorted(batches) == [[1, 2], [3]], batches
    assert sorted(released) == [[1, 2], [3]], released

    assert doc is not None and doc.pdf
    assert count_pages(doc.pdf) == 3, count_pages(doc.pdf)
    assert pdf_page_sizes(doc.pdf) == [(612, 792), (459, 594), (525, 675)]
    assert doc.strategy == "embed-print"
    assert [p.text for p in doc.pages] == ["page 1 text", "page 2 text", "page 3 text"]
    assert doc.meta.title == "Embed Title"
    assert doc.meta.page_count == 3
    assert doc.complete is True
    assert any("viewer knows 3 pages" in m for m in logs), logs
    assert any("printing with 2 tabs in parallel" in m for m in logs), logs
    assert any("pages/s" in m for m in logs), logs
    assert any("merged 3 page PDFs -> 3 sheets" in m for m in logs), logs


def test_split_range_covers_every_page_once():
    from scribd.embedprint import _split_range

    for count, workers in ((95, 1), (95, 2), (95, 4), (7, 3), (3, 8), (1, 2)):
        chunks = _split_range(count, workers)
        flat = [i for chunk in chunks for i in chunk]
        assert flat == list(range(count)), (count, workers, chunks)
        # contiguous, in order, and no worker is empty
        assert all(chunk for chunk in chunks)
        assert len(chunks) == min(workers, count)


# ---------------------------------------------------------------------------
# Search without a link: keyword -> document URLs -> downloads.
# ---------------------------------------------------------------------------
SEARCH_HTML = """
<html><body>
  <nav><a href="/about">About</a><a href="/search?query=excel">Search</a></nav>
  <div class="search_result_item">
    <a href="/document/1234567/Excel-Basics"><img alt="Excel Basics" src="x.jpg"></a>
    <a href="/document/1234567/Excel-Basics" title="Excel Basics for Beginners">
      Excel Basics for Beginners
    </a>
    <a href="/document/1234567/Excel-Basics" aria-label="Save">Save</a>
  </div>
  <div class="search_result_item">
    <a href="https://www.scribd.com/presentation/7654321/Excel-Dashboard">Excel Dashboard</a>
  </div>
  <a href="/doc/999/Excel-Legacy">Excel Legacy Doc</a>
  <a href="/spreadsheet/555/Excel-Template"></a>
  <a href="/document/1234567/Excel-Basics">Excel Basics for Beginners</a>
</body></html>
"""


def test_search_url_encoding():
    from scribd.search import search_url

    assert search_url("excel") == (
        "https://www.scribd.com/search?query=excel&page=1"
    )
    assert search_url("excel formulas", page=2) == (
        "https://www.scribd.com/search?query=excel+formulas&page=2"
    )
    assert search_url("  pivot tables ").endswith("query=pivot+tables&page=1")


def test_parse_search_results_orders_and_dedupes():
    from scribd.search import parse_search_results

    hits = parse_search_results(SEARCH_HTML)
    ids = [h.doc_id for h in hits]
    assert ids == ["1234567", "7654321", "999", "555"], hits
    assert hits[0].kind == "document"
    assert hits[1].kind == "presentation"
    assert hits[2].kind == "document"  # legacy /doc/ alias
    assert hits[3].kind == "spreadsheet"

    # the thumbnail anchor is upgraded to the real title
    assert hits[0].title == "Excel Basics for Beginners"
    assert hits[1].title == "Excel Dashboard"
    assert hits[3].title == "Excel Template"  # from the slug
    # a usable canonical URL for the download chain
    assert hits[0].url == (
        "https://www.scribd.com/document/1234567/Excel-Basics"
    )
    # no nav links, no duplicates
    assert len(hits) == 4


def test_parse_search_results_respects_limit():
    from scribd.search import parse_search_results

    assert [h.doc_id for h in parse_search_results(SEARCH_HTML, limit=2)] == [
        "1234567",
        "7654321",
    ]


def test_parse_search_results_from_inline_json():
    """Some views ship the results as JSON only."""
    from scribd.search import parse_search_results

    html = (
        "<html><body><script>window.__DATA__ = "
        '{"results":[{"documentId":1111111,"title":"Excel Pivot Tables"},'
        '{"documentId":2222222,"title":"Excel Formulas"}]}'
        "</script></body></html>"
    )
    hits = parse_search_results(html)
    assert [(h.doc_id, h.title) for h in hits] == [
        ("1111111", "Excel Pivot Tables"),
        ("2222222", "Excel Formulas"),
    ]
    assert hits[0].url.startswith("https://www.scribd.com/document/1111111/")


def test_parse_search_results_ignores_non_documents():
    from scribd.search import parse_search_results

    assert parse_search_results("<a href='/about'>About</a>") == []
    assert parse_search_results("") == []


def test_find_documents_walks_pages_until_limit():
    import asyncio as _asyncio

    from scribd.search import find_documents, search_url

    page1 = """
      <a href="/document/111/Excel-1">Excel One</a>
      <a href="/document/222/Excel-2">Excel Two</a>
      <a href="/document/111/Excel-1">Excel One again</a>
    """
    page2 = """
      <a href="/document/333/Excel-3">Excel Three</a>
      <a href="/document/444/Excel-4">Excel Four</a>
    """

    class Response:
        def __init__(self, text):
            self.text = text
            self.status_code = 200

    class Fetcher:
        def __init__(self):
            self.urls = []

        async def get(self, url, **kw):
            self.urls.append(url)
            if url == search_url("excel", 1):
                return Response(page1)
            if url == search_url("excel", 2):
                return Response(page2)
            return Response("")

    logs: list[str] = []
    fetcher = Fetcher()
    hits = _asyncio.run(
        find_documents(fetcher, "excel", limit=3, pages=5, log=logs.append)
    )

    assert [h.doc_id for h in hits] == ["111", "222", "333"], hits
    assert fetcher.urls == [search_url("excel", 1), search_url("excel", 2)]
    assert any("page 1" in m and "2 new" in m for m in logs), logs


def test_cli_search_downloads_five_without_any_link(monkeypatch, tmp_path):
    """`--search "excel"` with no URL argument downloads 5 documents."""
    import asyncio as _asyncio

    import scribd.cli as cli
    from scribd.models import DocumentMeta, Page, ScrapedDocument
    from scribd.search import search_url

    html = "".join(
        f'<a href="/document/{1000 + n}/Excel-Doc-{n}">Excel Document {n}</a>'
        for n in range(1, 6)
    )

    class Response:
        status_code = 200

        def __init__(self, text):
            self.text = text

    class FakeFetcher:
        backend = "fake"
        cookies = {}

        def __init__(self, **kw):
            self.kw = kw
            self.requested: list[str] = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def get(self, url, **kw):
            self.requested.append(url)
            return Response(html if "search" in url else "")

    class FakeScraper:
        attempted: list[str] = []

        def __init__(self, *a, **kw):
            pass

        async def scrape(self, url):
            FakeScraper.attempted.append(url)
            doc_id = url.split("/")[4]
            return ScrapedDocument(
                meta=DocumentMeta(
                    doc_id=doc_id, url=url, title=f"Excel Document {doc_id}",
                    page_count=1,
                ),
                pages=[Page(number=1, text="hello")],
                strategy="embed-print",
                pdf=_one_page_pdf(300, 400),
                complete=True,
            )

    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "ScribdScraper", FakeScraper)

    args = cli.build_parser().parse_args(
        [
            "--search", "excel",
            "--limit", "5",
            "-o", str(tmp_path),
            "-f", "pdf",
        ]
    )
    rc = _asyncio.run(cli.run(args))

    assert rc == 0
    assert len(FakeScraper.attempted) == 5, FakeScraper.attempted
    # every download came from the search result, not from the command line
    assert all(u.startswith("https://www.scribd.com/document/") for u in FakeScraper.attempted)
    assert sorted(
        u.rsplit("/", 2)[-2] for u in FakeScraper.attempted
    ) == ["1001", "1002", "1003", "1004", "1005"]
    files = sorted(p.name for p in tmp_path.glob("*.pdf"))
    assert len(files) == 5, files
    assert any("1001_" in name for name in files), files


def test_cli_without_urls_or_search_exits_2(capsys):
    import asyncio as _asyncio

    import scribd.cli as cli

    args = cli.build_parser().parse_args([])
    assert _asyncio.run(cli.run(args)) == 2
    out = capsys.readouterr().out
    assert "--search" in out


def test_find_documents_dumps_unparsable_page(tmp_path):
    """A search page with no parsable results is kept for inspection."""
    import asyncio as _asyncio

    from scribd.search import find_documents

    class Response:
        status_code = 200
        text = "<html><body><div>nothing here</div></body></html>"

    class Fetcher:
        async def get(self, url, **kw):
            return Response()

    logs: list[str] = []
    hits = _asyncio.run(
        find_documents(
            Fetcher(),
            "excel formulas",
            limit=5,
            pages=3,
            debug_dir=tmp_path,
            log=logs.append,
        )
    )
    assert hits == []
    dumped = list(tmp_path.glob("search-*.html"))
    assert dumped and dumped[0].name == "search-excel-formulas-p1.html", dumped
    assert "nothing here" in dumped[0].read_text()
    assert any("no usable results" in m for m in logs), logs


# ---------------------------------------------------------------------------
# Search in a real browser: Scribd's search page is client-rendered, so the
# HTTP response has no result links (the "0 result(s)" report).
# ---------------------------------------------------------------------------
def test_browser_extract_js_reads_a_result_grid():
    """The live-DOM extractor keeps order, dedupes and prefers real titles."""
    import json
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:  # pragma: no cover - sandbox without node
        pytest.skip("node not available")
    from scribd.search import BROWSER_EXTRACT_JS

    script = pathlib.Path(__file__).with_name("mock_search_dom.js")
    proc = subprocess.run(
        [node, str(script)],
        input=json.dumps({"extract": BROWSER_EXTRACT_JS}),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout


def _fake_search_browser(monkeypatch, *, links_per_url, hits, viewed):
    import sys
    import types

    from scribd import search as search_mod

    class Page:
        async def goto(self, url, **kw):
            viewed.append(url)

        async def wait_for_timeout(self, ms):
            return None

        async def title(self):
            return "Scribd Search"

        async def content(self):
            return "<html><body>search shell</body></html>"

        async def screenshot(self, path=None, **kw):
            if path:
                pathlib.Path(path).write_bytes(_fake_png("white", size=(20, 20)))
            return b""

        async def evaluate(self, script, arg=None):
            if script == search_mod.COUNT_LINKS_JS:
                for marker, count in links_per_url.items():
                    if marker in (viewed[-1] if viewed else ""):
                        return count
                return 0
            if script == search_mod.BROWSER_EXTRACT_JS:
                return list(hits)
            if script == search_mod.BROWSER_SCROLL_JS:
                return {"links": len(hits)}
            return 0

    class Context:
        async def add_cookies(self, cookies):
            return None

        async def new_page(self):
            return Page()

    class Browser:
        async def new_context(self, **kw):
            return Context()

        async def close(self):
            return None

    class PW:
        class chromium:
            @staticmethod
            async def launch(headless=True, args=None):
                return Browser()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    fake = types.ModuleType("playwright.async_api")
    fake.async_playwright = lambda: PW()
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.async_api", fake)


def test_browser_search_uses_the_url_shape_that_renders(monkeypatch, tmp_path):
    """The first URL renders nothing; the next one yields the cards."""
    import asyncio as _asyncio

    from scribd.search import SEARCH_VARIANTS, browser_search

    raw = [
        {"doc_id": "1001", "kind": "document", "slug": "Excel-One", "title": "Excel One"},
        {"doc_id": "1002", "kind": "document", "slug": "Excel-Two", "title": "Excel Two"},
        {"doc_id": "1003", "kind": "presentation", "slug": "Excel-Three", "title": ""},
    ]
    viewed: list[str] = []
    second = SEARCH_VARIANTS[1].split("?")[0] + "?query=excel&content_type"
    _fake_search_browser(
        monkeypatch, links_per_url={second: 12, SEARCH_VARIANTS[2]: 12}, hits=raw,
        viewed=viewed,
    )

    logs: list[str] = []
    hits = _asyncio.run(
        browser_search(
            {"_scribd_session": "x"},
            "excel",
            limit=5,
            pages=1,
            debug_dir=tmp_path,
            log=logs.append,
        )
    )

    assert [h.doc_id for h in hits] == ["1001", "1002", "1003"], hits
    # the slug-only card still gets a usable title
    assert hits[2].title == "Excel Three"
    assert len(viewed) >= 2, viewed
    assert "query=excel" in viewed[0]
    assert any("browser found 3 document(s)" in m for m in logs), logs
    # nothing was dumped: results were found
    assert list(tmp_path.glob("search-*")) == []


def test_browser_search_dumps_the_page_when_nothing_renders(monkeypatch, tmp_path):
    """All URL shapes empty → save HTML + screenshot and say so."""
    import asyncio as _asyncio

    from scribd.search import browser_search

    viewed: list[str] = []
    _fake_search_browser(monkeypatch, links_per_url={}, hits=[], viewed=viewed)

    logs: list[str] = []
    hits = _asyncio.run(
        browser_search(None, "excel", limit=5, pages=1, debug_dir=tmp_path, log=logs.append)
    )

    assert hits == []
    dumped_html = list(tmp_path.glob("search-excel-browser.html"))
    dumped_png = list(tmp_path.glob("search-excel-browser.png"))
    assert dumped_html and dumped_png, list(tmp_path.iterdir())
    assert "search shell" in dumped_html[0].read_text()
    assert any("saved the page" in m for m in logs), logs


def test_cli_searches_in_a_browser_when_the_http_page_has_no_links(monkeypatch, tmp_path):
    """End to end: HTTP search empty -> browser search -> 5 downloads, no URL."""
    import asyncio as _asyncio

    import scribd.cli as cli
    import scribd.search as search_mod
    from scribd.models import DocumentMeta, Page, ScrapedDocument

    class Response:
        status_code = 200
        text = "<html><body>search shell, no links</body></html>"

    class FakeFetcher:
        backend = "fake"
        cookies = {}

        def __init__(self, **kw):
            self.requested: list[str] = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def get(self, url, **kw):
            self.requested.append(url)
            return Response()

    class FakeScraper:
        attempted: list[str] = []

        def __init__(self, *a, **kw):
            pass

        async def scrape(self, url):
            FakeScraper.attempted.append(url)
            doc_id = url.split("/")[4]
            return ScrapedDocument(
                meta=DocumentMeta(
                    doc_id=doc_id, url=url, title=f"Excel Doc {doc_id}", page_count=1
                ),
                pages=[Page(number=1, text="x")],
                strategy="embed-print",
                pdf=_one_page_pdf(300, 400),
                complete=True,
            )

    async def fake_browser_search(cookies, query, *, limit=5, pages=3, debug_dir=None, log=print):
        return [
            search_mod.SearchHit(
                doc_id=str(2000 + n), kind="document", slug=f"Excel-{n}",
                title=f"Excel Browser {n}",
            )
            for n in range(1, limit + 1)
        ]

    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "ScribdScraper", FakeScraper)
    monkeypatch.setattr(search_mod, "browser_search", fake_browser_search)

    args = cli.build_parser().parse_args(
        ["--search", "excel", "--limit", "5", "--jobs", "1", "-o", str(tmp_path), "-f", "pdf"]
    )
    rc = _asyncio.run(cli.run(args))

    assert rc == 0
    assert len(FakeScraper.attempted) == 5, FakeScraper.attempted
    assert sorted(u.rsplit("/", 2)[-2] for u in FakeScraper.attempted) == [
        "2001", "2002", "2003", "2004", "2005",
    ]
    assert len(list(tmp_path.glob("*.pdf"))) == 5


def test_cli_search_only_lists_without_downloading(monkeypatch, tmp_path):
    """`--search-only` proves the search works and downloads nothing."""
    import asyncio as _asyncio

    import scribd.cli as cli
    import scribd.search as search_mod

    class Response:
        status_code = 200
        text = "<html><body>shell</body></html>"

    class FakeFetcher:
        backend = "fake"
        cookies = {}

        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def get(self, url, **kw):
            return Response()

    class FakeScraper:
        attempted: list[str] = []

        def __init__(self, *a, **kw):
            pass

        async def scrape(self, url):  # pragma: no cover - must not be called
            FakeScraper.attempted.append(url)
            raise AssertionError("--search-only must not download anything")

    async def fake_browser_search(cookies, query, *, limit=5, pages=3, debug_dir=None, log=print):
        return [
            search_mod.SearchHit(doc_id="3001", title="Excel One"),
            search_mod.SearchHit(doc_id="3002", title="Excel Two"),
        ]

    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "ScribdScraper", FakeScraper)
    monkeypatch.setattr(search_mod, "browser_search", fake_browser_search)

    args = cli.build_parser().parse_args(
        ["--search", "excel", "--limit", "5", "--search-only", "-o", str(tmp_path), "-f", "pdf"]
    )
    assert _asyncio.run(cli.run(args)) == 0
    assert FakeScraper.attempted == []
    assert list(tmp_path.glob("*.pdf")) == []


def test_parse_picks():
    from scribd.cli import parse_picks

    assert parse_picks("1,3,7") == {1, 3, 7}
    assert parse_picks(" 1, 3 , 7 ") == {1, 3, 7}
    assert parse_picks("3,3,0,-2,x,") == {3}
    assert parse_picks(None) == set()
    assert parse_picks("") == set()


def _cli_search_env(monkeypatch, hits, *, scraped):
    """Shared fakes: HTTP search empty, browser search returns ``hits``."""
    import scribd.cli as cli
    import scribd.search as search_mod
    from scribd.models import DocumentMeta, Page, ScrapedDocument

    class Response:
        status_code = 200
        text = "<html><body>shell</body></html>"

    class FakeFetcher:
        backend = "fake"
        cookies = {}

        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def get(self, url, **kw):
            return Response()

    class FakeScraper:
        def __init__(self, *a, **kw):
            pass

        async def scrape(self, url):
            scraped.append(url)
            doc_id = url.split("/")[4]
            return ScrapedDocument(
                meta=DocumentMeta(
                    doc_id=doc_id, url=url, title=f"Doc {doc_id}", page_count=1
                ),
                pages=[Page(number=1, text="x")],
                strategy="embed-print",
                pdf=_one_page_pdf(300, 400),
                complete=True,
            )

    async def fake_browser_search(cookies, query, *, limit=5, pages=3, debug_dir=None, log=print):
        # limit 0 means "everything" everywhere in this project
        return list(hits)[:limit] if limit else list(hits)

    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "ScribdScraper", FakeScraper)
    monkeypatch.setattr(search_mod, "browser_search", fake_browser_search)
    return cli, search_mod


def test_cli_pick_downloads_only_the_chosen_results(monkeypatch, tmp_path):
    """`--pick 2,4` downloads exactly those two from the printed list."""
    import asyncio as _asyncio

    import scribd.search as search_mod

    hits = [
        search_mod.SearchHit(doc_id=str(4000 + n), title=f"Excel {n}", slug=f"Excel-{n}")
        for n in range(1, 6)
    ]
    scraped: list[str] = []
    cli, _ = _cli_search_env(monkeypatch, hits, scraped=scraped)

    args = cli.build_parser().parse_args(
        [
            "--search", "excel",
            "--limit", "5",
            "--pick", "2,4",
            "--jobs", "1",
            "-o", str(tmp_path),
            "-f", "pdf",
        ]
    )
    rc = _asyncio.run(cli.run(args))

    assert rc == 0
    assert scraped == [hits[1].url, hits[3].url], scraped
    assert len(list(tmp_path.glob("*.pdf"))) == 2
    saved = sorted(tmp_path.glob("search-*.txt"))
    assert saved, list(tmp_path.iterdir())
    lines = [line for line in saved[0].read_text().splitlines() if line.strip()]
    assert lines == [hits[1].url, hits[3].url], lines


def test_cli_search_only_saves_the_url_list(monkeypatch, tmp_path):
    """`--search-only` writes what it found so it can be edited and reused."""
    import asyncio as _asyncio

    import scribd.search as search_mod

    hits = [
        search_mod.SearchHit(doc_id="5001", title="First", slug="First"),
        search_mod.SearchHit(doc_id="5002", title="Second", slug="Second"),
    ]
    scraped: list[str] = []
    cli, _ = _cli_search_env(monkeypatch, hits, scraped=scraped)

    args = cli.build_parser().parse_args(
        ["--search", "excel and succeed", "--limit", "5", "--search-only", "-o", str(tmp_path)]
    )
    assert _asyncio.run(cli.run(args)) == 0

    assert scraped == []
    txt = tmp_path / "search-excel_and_succeed.txt"
    js = tmp_path / "search-excel_and_succeed.json"
    assert txt.exists() and js.exists(), list(tmp_path.iterdir())
    assert [line for line in txt.read_text().splitlines() if line] == [
        hits[0].url,
        hits[1].url,
    ]
    payload = json.loads(js.read_text())
    assert payload["query"] == "excel and succeed"
    assert payload["count"] == 2
    assert [item["doc_id"] for item in payload["results"]] == ["5001", "5002"]


# ---------------------------------------------------------------------------
# Bulk downloads: --limit 0 (everything), resume/skip, manifest, exit codes.
# ---------------------------------------------------------------------------
def test_existing_pdf_and_manifest_helpers(tmp_path):
    from scribd.cli import append_manifest, doc_id_of, existing_pdf

    assert doc_id_of("https://www.scribd.com/document/599073587/Std-5-8") == "599073587"
    assert doc_id_of("https://www.scribd.com/doc/123/Title") == "123"
    assert doc_id_of("https://www.scribd.com/presentation/555/X") == "555"
    assert doc_id_of("https://example.com/nope") == ""

    target = tmp_path / "599073587_Std_5_8.pdf"
    target.write_bytes(b"%PDF-1.4" + b"0" * 2048)
    assert existing_pdf(tmp_path, "https://www.scribd.com/document/599073587/x") == target

    empty = tmp_path / "777_Empty.pdf"
    empty.write_bytes(b"")
    assert existing_pdf(tmp_path, "https://www.scribd.com/document/777/x") is None
    truncated = tmp_path / "777_Truncated.pdf"
    truncated.write_bytes(b"<html>not a pdf</html>")
    assert existing_pdf(tmp_path, "https://www.scribd.com/document/777/x") is None
    assert existing_pdf(tmp_path, "https://example.com/nope") is None

    append_manifest(tmp_path, {"url": "u1", "status": "ok", "pages": 3})
    append_manifest(tmp_path, {"url": "u2", "status": "failed", "error": "boom"})
    lines = [
        json.loads(line)
        for line in (tmp_path / "manifest.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert [line["url"] for line in lines] == ["u1", "u2"]
    assert lines[1]["status"] == "failed" and lines[1]["error"] == "boom"
    assert all("at" in line for line in lines)


def test_cli_limit_zero_downloads_everything_found(monkeypatch, tmp_path):
    import asyncio as _asyncio

    import scribd.search as search_mod

    hits = [
        search_mod.SearchHit(doc_id=str(6000 + n), title=f"Doc {n}", slug=f"Doc-{n}")
        for n in range(1, 5)
    ]
    scraped: list[str] = []
    seen_limits: list[int] = []
    cli, _ = _cli_search_env(monkeypatch, hits, scraped=scraped)

    original = search_mod.browser_search

    async def spy(cookies, query, *, limit=5, pages=3, debug_dir=None, log=print):
        seen_limits.append(limit)
        return await original(cookies, query, limit=limit, pages=pages, debug_dir=debug_dir, log=log)

    monkeypatch.setattr(search_mod, "browser_search", spy)

    args = cli.build_parser().parse_args(
        ["--search", "excel", "--limit", "0", "--jobs", "1", "-o", str(tmp_path), "-f", "pdf"]
    )
    assert _asyncio.run(cli.run(args)) == 0

    assert seen_limits == [0], seen_limits  # "all", not the default 5
    assert len(scraped) == len(hits), scraped
    assert len(list(tmp_path.glob("*.pdf"))) == len(hits)


def test_cli_skips_existing_and_overwrite_redownloads(monkeypatch, tmp_path):
    import asyncio as _asyncio

    import scribd.search as search_mod

    hits = [
        search_mod.SearchHit(doc_id=str(7000 + n), title=f"Doc {n}", slug=f"Doc-{n}")
        for n in range(1, 3)
    ]
    scraped: list[str] = []
    cli, _ = _cli_search_env(monkeypatch, hits, scraped=scraped)
    argv = ["--search", "excel", "--limit", "2", "--jobs", "1", "-o", str(tmp_path), "-f", "pdf"]

    assert _asyncio.run(cli.run(cli.build_parser().parse_args(argv))) == 0
    assert len(scraped) == 2

    # second run: everything is already there, nothing is fetched again
    scraped.clear()
    assert _asyncio.run(cli.run(cli.build_parser().parse_args(argv))) == 0
    assert scraped == []
    assert len(list(tmp_path.glob("*.pdf"))) == 2

    entries = [
        json.loads(line)
        for line in (tmp_path / "manifest.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert [e["status"] for e in entries] == ["ok", "ok", "skipped", "skipped"], entries

    # --overwrite forces a fresh download
    scraped.clear()
    overwrite = argv + ["--overwrite"]
    assert _asyncio.run(cli.run(cli.build_parser().parse_args(overwrite))) == 0
    assert len(scraped) == 2


def test_cli_exit_code_is_nonzero_when_something_failed(monkeypatch, tmp_path):
    import asyncio as _asyncio

    import scribd.cli as cli
    import scribd.search as search_mod
    from scribd.models import DocumentMeta, Page, ScrapedDocument

    hits = [
        search_mod.SearchHit(doc_id="8001", title="Good", slug="Good"),
        search_mod.SearchHit(doc_id="8002", title="Bad", slug="Bad"),
    ]

    class Response:
        status_code = 200
        text = "<html><body>shell</body></html>"

    class FakeFetcher:
        backend = "fake"
        cookies = {}

        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def get(self, url, **kw):
            return Response()

    class FakeScraper:
        def __init__(self, *a, **kw):
            pass

        async def scrape(self, url):
            if "8002" in url:
                raise RuntimeError("boom")
            return ScrapedDocument(
                meta=DocumentMeta(doc_id="8001", url=url, title="Good", page_count=1),
                pages=[Page(number=1, text="x")],
                strategy="embed-print",
                pdf=_one_page_pdf(300, 400),
                complete=True,
            )

    async def fake_browser_search(cookies, query, *, limit=5, pages=3, debug_dir=None, log=print):
        return hits

    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "ScribdScraper", FakeScraper)
    monkeypatch.setattr(search_mod, "browser_search", fake_browser_search)

    args = cli.build_parser().parse_args(
        ["--search", "excel", "--limit", "2", "--jobs", "1", "-o", str(tmp_path), "-f", "pdf"]
    )
    assert _asyncio.run(cli.run(args)) == 1
    entries = [
        json.loads(line)
        for line in (tmp_path / "manifest.jsonl").read_text().splitlines()
        if line.strip()
    ]
    statuses = sorted(entry["status"] for entry in entries)
    assert statuses == ["failed", "ok"], entries


# ---------------------------------------------------------------------------
# Web front-end: search -> pick -> batch download, as jobs.
# ---------------------------------------------------------------------------
def _webapp(tmp_path, monkeypatch):
    """Fresh webapp module state, pointed at tmp_path, no worker threads."""
    import importlib
    import importlib.util

    import scribd.webapp as webapp

    importlib.reload(webapp)  # reset JOBS/QUEUE between tests
    monkeypatch.setattr(webapp, "DATA_DIR", tmp_path)
    monkeypatch.setattr(webapp, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(webapp, "OUT_DIR", tmp_path / "out")
    monkeypatch.setattr(webapp, "ensure_workers", lambda: None)
    (tmp_path / "out").mkdir(parents=True, exist_ok=True)
    webapp.app.config.update(TESTING=True)
    return webapp


def test_webapp_health_and_page(tmp_path, monkeypatch):
    webapp = _webapp(tmp_path, monkeypatch)
    client = webapp.app.test_client()

    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.get_json()["ok"] is True

    page = client.get("/")
    assert page.status_code == 200
    assert b"Scribd search" in page.data
    assert b"/api/jobs" in page.data


def test_webapp_auth_when_configured(tmp_path, monkeypatch):
    webapp = _webapp(tmp_path, monkeypatch)
    monkeypatch.setenv("SCRIBD_WEB_USER", "me")
    monkeypatch.setenv("SCRIBD_WEB_PASS", "secret")
    client = webapp.app.test_client()

    assert client.get("/api/jobs").status_code == 401
    assert client.get("/api/health").status_code == 200  # health stays open

    import base64

    token = base64.b64encode(b"me:secret").decode()
    ok = client.get("/api/jobs", headers={"Authorization": f"Basic {token}"})
    assert ok.status_code == 200


def test_webapp_search_job_returns_hits(tmp_path, monkeypatch):
    import json as _json

    webapp = _webapp(tmp_path, monkeypatch)

    def fake_process(job):
        job.status = "running"
        job.started_at = webapp._now()
        (webapp.OUT_DIR / f"search-{webapp._slug(job.query)}.json").write_text(
            _json.dumps(
                {
                    "query": job.query,
                    "count": 2,
                    "results": [
                        {"doc_id": "111", "title": "Excel One",
                         "url": "https://www.scribd.com/document/111/Excel-One",
                         "kind": "document"},
                        {"doc_id": "222", "title": "Excel Two",
                         "url": "https://www.scribd.com/document/222/Excel-Two",
                         "kind": "document"},
                    ],
                }
            ),
            encoding="utf-8",
        )
        job.status = "done"
        job.returncode = 0
        job.finished_at = webapp._now()

    monkeypatch.setattr(webapp, "process_job", fake_process)
    client = webapp.app.test_client()

    created = client.post("/api/jobs", json={"mode": "search", "query": "excel", "limit": 50})
    assert created.status_code == 202, created.data
    job = created.get_json()

    # run the queued job synchronously instead of waiting on a thread
    webapp.process_job(webapp.JOBS[job["id"]])

    status = client.get(f"/api/jobs/{job['id']}").get_json()
    assert status["status"] == "done"
    assert [hit["doc_id"] for hit in status["results"]] == ["111", "222"]
    assert status["pdf_count"] == 0


def test_webapp_download_job_files_and_zip(tmp_path, monkeypatch):
    import json as _json

    webapp = _webapp(tmp_path, monkeypatch)
    captured: dict = {}

    def fake_process(job):
        captured["command"] = webapp.build_command(job)
        pdf = webapp.OUT_DIR / "111_Excel_One.pdf"
        pdf.write_bytes(_one_page_pdf(300, 400))
        (webapp.OUT_DIR / "manifest.jsonl").write_text(
            _json.dumps(
                {
                    "url": "https://www.scribd.com/document/111/Excel-One",
                    "doc_id": "111",
                    "status": "ok",
                    "files": [pdf.name],
                }
            )
            + "\n",
            encoding="utf-8",
        )
        job.status = "done"
        job.returncode = 0
        job.finished_at = webapp._now()

    monkeypatch.setattr(webapp, "process_job", fake_process)
    client = webapp.app.test_client()

    created = client.post(
        "/api/jobs",
        json={
            "mode": "download",
            "query": "excel",
            "urls": ["https://www.scribd.com/document/111/Excel-One"],
        },
    )
    assert created.status_code == 202, created.data
    job = created.get_json()
    webapp.process_job(webapp.JOBS[job["id"]])

    # the CLI is called with the URL list, not a live search
    command = captured["command"]
    assert "--file" in command, command
    listing = pathlib.Path(command[command.index("--file") + 1])
    assert listing.read_text().strip() == "https://www.scribd.com/document/111/Excel-One"

    status = client.get(f"/api/jobs/{job['id']}").get_json()
    assert status["pdf_count"] == 1
    assert status["files"] == ["111_Excel_One.pdf"]
    assert status["manifest"]["counts"]["ok"] == 1

    file_response = client.get(f"/api/jobs/{job['id']}/file/111_Excel_One.pdf")
    assert file_response.status_code == 200
    assert file_response.data.startswith(b"%PDF")

    # traversal must not escape the output folder
    assert client.get(f"/api/jobs/{job['id']}/file/..%2F..%2Fetc%2Fpasswd").status_code in (400, 404)

    archive = client.get(f"/api/jobs/{job['id']}/zip")
    assert archive.status_code == 200
    with zipfile.ZipFile(io.BytesIO(archive.data)) as bundle:
        assert "111_Excel_One.pdf" in bundle.namelist()


def test_webapp_rejects_bad_requests(tmp_path, monkeypatch):
    webapp = _webapp(tmp_path, monkeypatch)
    client = webapp.app.test_client()

    assert client.post("/api/jobs", json={"mode": "search"}).status_code == 400
    assert client.post("/api/jobs", json={"mode": "download"}).status_code == 400
    assert client.post("/api/jobs", json={"mode": "nope"}).status_code == 400
    assert client.get("/api/jobs/doesnotexist").status_code == 404
    assert client.get("/api/jobs/doesnotexist/zip").status_code == 404


# ---------------------------------------------------------------------------
# Panel hosting (Pterodactyl runs exactly one file: bot.py)
# ---------------------------------------------------------------------------
def test_resolve_bind_prefers_panel_port(monkeypatch):
    import scribd.webapp as webapp

    monkeypatch.delenv("SCRIBD_WEB_PORT", raising=False)
    monkeypatch.setenv("SERVER_PORT", "25811")
    assert webapp.resolve_bind(None, None) == ("127.0.0.1", 25811)
    assert webapp.resolve_bind("0.0.0.0", None) == ("0.0.0.0", 25811)
    # an explicit argument still wins over the environment
    assert webapp.resolve_bind("0.0.0.0", 9000) == ("0.0.0.0", 9000)

    monkeypatch.setenv("SCRIBD_WEB_PORT", "8100")
    assert webapp.resolve_bind() == ("127.0.0.1", 8100)

    monkeypatch.setenv("SCRIBD_WEB_PORT", "not-a-number")
    monkeypatch.delenv("SERVER_PORT")
    assert webapp.resolve_bind()[1] == 8000


def test_ensure_auth_generates_password_for_public_host(monkeypatch):
    import scribd.webapp as webapp

    names = ("SCRIBD_WEB_USER", "SCRIBD_WEB_PASS", "SCRIBD_WEB_TOKEN")
    for name in names:
        monkeypatch.delenv(name, raising=False)
    try:
        # loopback stays open (local use)
        assert webapp.ensure_auth("127.0.0.1") == "open-loopback"
        assert not os.environ.get("SCRIBD_WEB_USER")

        # a public bind never ends up unauthenticated
        assert webapp.ensure_auth("0.0.0.0") == "generated"
        assert os.environ["SCRIBD_WEB_USER"] == "admin"
        assert len(os.environ["SCRIBD_WEB_PASS"]) >= 12
    finally:
        # ensure_auth writes to os.environ directly (it must survive for the
        # real server), so monkeypatch will not undo it
        for name in names:
            os.environ.pop(name, None)

    monkeypatch.setenv("SCRIBD_WEB_USER", "me")
    monkeypatch.setenv("SCRIBD_WEB_PASS", "mine")
    assert webapp.ensure_auth("0.0.0.0") == "configured"
    assert os.environ["SCRIBD_WEB_PASS"] == "mine"


def test_webapp_health_reports_browser_status(tmp_path, monkeypatch):
    webapp = _webapp(tmp_path, monkeypatch)
    payload = webapp.app.test_client().get("/api/health").get_json()
    assert payload["ok"] is True
    assert payload["version"].count(".") >= 1
    assert set(payload["browser"]) >= {"playwright", "chromium", "chromium_path"}
    assert isinstance(payload["browser"]["chromium"], bool)


def test_setup_job_runs_playwright_install(tmp_path, monkeypatch):
    webapp = _webapp(tmp_path, monkeypatch)
    client = webapp.app.test_client()

    created = client.post("/api/jobs", json={"mode": "setup"})
    assert created.status_code == 202, created.data
    job = webapp.JOBS[created.get_json()["id"]]
    command = webapp.build_command(job)
    assert command[1:] == ["-m", "playwright", "install", "chromium"], command


def test_bot_entry_point_is_importable(monkeypatch):
    """The panel runs `python bot.py`; importing it must not start a server."""
    import importlib

    import bot

    importlib.reload(bot)
    assert bot.ROOT.name == "stream"
    assert hasattr(bot, "main")

    # the auto-install hook is opt-in and does nothing without the env var
    monkeypatch.delenv("SCRIBD_WEB_AUTO_BROWSER", raising=False)
    bot.ensure_browser()


# ---------------------------------------------------------------------------
# .env: the panel has no variable editor
# ---------------------------------------------------------------------------
def test_parse_env_text_handles_quotes_comments_and_junk():
    from scribd.dotenv import parse_env_text

    values = parse_env_text(
        "\n".join(
            [
                "# a comment",
                "",
                "SCRIBD_WEB_USER=me",
                'SCRIBD_WEB_PASS="with spaces and #hash"',
                "export SCRIBD_WEB_COOKIES='/home/container/cookies.txt'",
                "TRAILING=value  # an inline comment",
                "not a pair",
                "=nameless",
                "EMPTY=",
            ]
        )
    )
    assert values["SCRIBD_WEB_USER"] == "me"
    assert values["SCRIBD_WEB_PASS"] == "with spaces and #hash"
    assert values["SCRIBD_WEB_COOKIES"] == "/home/container/cookies.txt"
    assert values["TRAILING"] == "value"
    assert values["EMPTY"] == ""
    assert "not a pair" not in values
    assert "" not in values


def test_load_env_file_does_not_override_real_variables(tmp_path, monkeypatch):
    from scribd.dotenv import load_env_file

    env = tmp_path / ".env"
    env.write_text("SCRIBD_WEB_USER=fromfile\nSCRIBD_WEB_PASS=fromfile\n", encoding="utf-8")

    monkeypatch.setenv("SCRIBD_WEB_USER", "frompanel")
    monkeypatch.delenv("SCRIBD_WEB_PASS", raising=False)
    applied = load_env_file(env)

    assert os.environ["SCRIBD_WEB_USER"] == "frompanel"   # the panel wins
    assert os.environ["SCRIBD_WEB_PASS"] == "fromfile"    # unset: file fills it
    assert set(applied) == {"SCRIBD_WEB_PASS"}


def test_load_env_file_missing_is_silent(tmp_path):
    from scribd.dotenv import load_env_file

    assert load_env_file(tmp_path / "nope.env") == {}


def test_webapp_reads_dotenv_and_finds_cookies(tmp_path, monkeypatch):
    import importlib

    import scribd.webapp as webapp

    (tmp_path / ".env").write_text(
        "SCRIBD_WEB_USER=me\nSCRIBD_WEB_PASS=secret\n", encoding="utf-8"
    )
    (tmp_path / "cookies.txt").write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
    monkeypatch.setenv("SCRIBD_WEB_ENV_FILE", str(tmp_path / ".env"))
    monkeypatch.setenv("SCRIBD_WEB_DATA", str(tmp_path))
    monkeypatch.delenv("SCRIBD_WEB_COOKIES", raising=False)
    monkeypatch.delenv("SCRIBD_WEB_USER", raising=False)
    monkeypatch.delenv("SCRIBD_WEB_PASS", raising=False)

    try:
        importlib.reload(webapp)  # reads .env at import, like a panel start
        assert webapp.ENV_FILE == tmp_path / ".env"
        assert os.environ["SCRIBD_WEB_USER"] == "me"
        assert os.environ["SCRIBD_WEB_PASS"] == "secret"
        # no SCRIBD_WEB_COOKIES: webdata/cookies.txt is picked up on its own
        assert webapp.cookies_file() == str(tmp_path / "cookies.txt")
        assert webapp._cookies_args() == ["--cookies-file", str(tmp_path / "cookies.txt")]
        assert webapp.app.test_client().get("/api/health").get_json()["cookies"] is True
    finally:
        monkeypatch.undo()
        importlib.reload(webapp)  # leave clean globals for the other tests
