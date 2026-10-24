# scribd-scraper

Scrape text (and, when available, the original PDF) from Scribd documents,
with a strategy chain and graceful degradation instead of one brittle path.

> **The error in the screenshot, fixed:** `scribd/__init__.py` does
> `from .scraper import ScrapeError, ScribdScraper`, but the local
> `scribd/scraper.py` did not define `ScrapeError` (truncated / mismatched
> copy), so Python raised
> `ImportError: cannot import name 'ScrapeError' from 'scribd.scraper'`.
> Here `scraper.py` defines both names (see the note in that file), and
> `tests/test_imports.py` guards the regression. If you hit this on your
> own machine, compare your `scraper.py` against this repo's — the class
> must exist at module level, and stale `__pycache__` should be deleted.

## Why the typical attempt dies

1. `requests.get(url)` + regex on the visible HTML → you get page 1 only. The
   document body lives in separate per-page JSONP assets on
   `html.scribdassets.com`.
2. Regexing `window.__PRELOADED_STATE__ = \{.*?\}` non-greedily → truncated
   JSON (nested braces, `</script>` inside strings). Use the brace matcher
   in `scribd/utils.py`.
3. Assuming the `contentUrl` in the state is the whole document. It's page 1.
   Synthesise page-N URLs from it (`build_page_template`).
4. Not stripping the JSONP wrapper (`window.pageN = {...};`) before
   `json.loads`.
5. Firing 50 concurrent requests → 403/429 with no backoff or UA rotation.
6. Treating scanned/image-only documents as if they had a text layer.
7. Confusing Everand books (EPUB-backed) with documents (PDF-backed).

## Layout

```
scribd-scraper/
├── requirements.txt
├── README.md
├── tests/
│   └── test_imports.py   (+ offline unit tests, no network)
└── scribd/
    ├── __init__.py
    ├── __main__.py
    ├── config.py
    ├── models.py
    ├── utils.py
    ├── http.py
    ├── extractors.py
    ├── render.py
    ├── fetch.py
    ├── scraper.py
    ├── export.py
    └── cli.py
```

Python 3.10+.

## Usage

```bash
pip install -r requirements.txt

# single doc  (-f/--format selects output formats)
python -m scribd "https://www.scribd.com/document/123456789/Some-Book" -o out -f txt,md,json

# batch, polite, cached  (--file reads one URL per line)
python -m scribd --file urls.txt -o library -f txt,md,epub --concurrency 4 --rate 4

# logged-in cookies unlock more
python -m scribd URL --cookies-file cookies.txt -f pdf
```

> CLI fix vs. the original listing: `-f` used to be bound to `--file` while
> the examples used `-f txt,md,json` for formats, so every documented
> example crashed trying to open a file named `txt,md,json`. Now
> `-f/--format` = formats and `--file` = URL-list file; both documented
> forms above work.

Python API:

```python
import asyncio
from scribd import ScribdScraper
from scribd.http import Fetcher

async def main():
    async with Fetcher(concurrency=6) as f:
        doc = await ScribdScraper(f).scrape("https://www.scribd.com/document/123/Title")
        print(doc.meta.title, len(doc.pages))

asyncio.run(main())
```

## Tests (offline, no Scribd traffic)

```bash
pip install pytest
python -m pytest tests/ -q
python -c "from scribd import ScrapeError, ScribdScraper; print('import OK')"
python -m scribd --help
```

## Notes that matter

- **Cache first.** `--cache-dir` means re-runs cost nothing and you can
  iterate on the renderer without re-hitting Scribd.
- **Rate limit, don't blast.** Default 6 concurrent / 6 rps is well under
  the threshold that triggers 403s. (403/429 are retried with UA rotation —
  in the original listing that code was dead because 403 wasn't in
  `RETRY_STATUS`.)
- **Scanned docs.** If pages come back with no text layer, the JSONP content
  is empty by design. Use `--images` to capture image URLs, or feed the
  images through `pytesseract` — the hook is in `_build_from_html`.
- **Books vs documents.** `book` URLs (Everand) are EPUB-backed and often
  only expose a preview without a subscription. The PDF strategy tends to
  win there; the JSONP strategy wins on uploaded documents.
- **Cookies.** Logged-in sessions get full access to subscriber-only docs
  and to the PDF endpoint more reliably. Netscape `cookies.txt` supported.
- **If the page HTML ever becomes fully client-rendered**, add a Playwright
  strategy: render the page, grab `page.content()`, and feed that string
  straight into `_build_from_html` — no other code changes needed.

### Respect the source

Only scrape content you have the right to access, keep the rate limits on,
and check Scribd's Terms and applicable copyright law for your use case.
