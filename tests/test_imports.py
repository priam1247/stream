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
