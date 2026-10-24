"""Offline tests — no network. Guards the screenshot's ImportError and
the core parsing insights (brace matcher, JSONP strip, page template)."""
import asyncio
import json

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

    assert DEFAULT_STRATEGIES[0].name == "embed-text"

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
