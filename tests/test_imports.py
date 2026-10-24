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
