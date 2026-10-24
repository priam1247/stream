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

## Strategy chain (order matters)

1. **`embed-text`** — fetches `/embeds/<id>/content?start_page=1&view_mode=scroll`,
   which returns **every page's text layer in one HTML response**, grouped as
   `div.newpage` → `div.text_layer`. This is what works on documents uploaded
   today: their pages are *images* (`…/images/1-abc.jpg`), and there is no
   `/pages/1-*.jsonp` asset at all. If the page containers can't be found, the
   whole body is captured as a single page rather than failing.
2. **`jsonp-pages`** — older uploaded documents: page HTML → `contentUrl` →
   synthesise page N → fetch → strip the JSONP wrapper. Requires the asset
   URLs to be unescaped first (`\/` → `/`).
3. **`render-metadata`** — `/doc-page/download-render-metadata/<id>` sometimes
   exposes asset URLs when the doc page is JS-only.
4. **`pdf-download`** — `/document_downloads/<id>?extension=pdf`: full fidelity,
   often works without login, sometimes subscriber-only.

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

## Using your Scribd account (cookies)

Cookies make the scraper run **as you**: subscriber documents you're
entitled to open in the browser, and the PDF endpoint, work far more
reliably. They do **not** add search — you still find the book/document
in your browser and copy its URL; the scraper downloads from there.

1. Log in to `scribd.com` in Chrome/Edge/Firefox.
2. Install a cookies.txt exporter (e.g. **"Get cookies.txt LOCALLY"**),
   and — while on a scribd.com page — export cookies for the site.
3. Save the file as `cookies.txt` in the project folder.
   **Treat it like your password:** it's a live session credential.
   Never paste it into a chat, screenshot it, or commit it (it's already
   in `.gitignore`). Logging out of Scribd invalidates it.
4. Run with it — and use `--no-cache` on the first logged-in run so
   earlier anonymous cached pages aren't reused:

```bash
python -m scribd "https://www.scribd.com/document/REAL_ID/Real-Title" \
    -o out -f txt,md,json,pdf --cookies-file cookies.txt --no-cache
```

You should see `loaded N account cookies (values hidden)` at startup.
If you see `loaded 0 …`, the export didn't include scribd.com cookies —
re-export while on a scribd.com tab. Sessions expire; when downloads
start failing as if logged out, export a fresh `cookies.txt`.

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

## When a document fails: `--diagnose`

If a real document reports `all strategies failed: no result`, the page
loaded but the extractors found no asset URLs. Ask the tool what the live
page actually looks like instead of guessing:

```bash
python -m scribd "https://www.scribd.com/document/REAL_ID/Title" \
    --cookies-file cookies.txt --diagnose
```

It reports, per endpoint (page, embed, render-metadata, oembed, PDF): HTTP
status, byte count and content type; which config markers occur in the
page; the parsed state keys; how many page asset URLs were extracted; and
the scribdassets URL *shapes* seen. It saves the raw page to
`.debug/page-<id>.html` (git-ignored) for offline inspection. Cookie
values are never printed.

Common causes, in order of likelihood:

1. **Escaped slashes** — config embedded as JSON writes
   `https:\/\/html.scribdassets.com\/…`; handled by `_normalise()`.
2. **JS-only shell** — the HTML is a skeleton and the state arrives via a
   later XHR. The report shows zero markers; the fix is a Playwright
   strategy (see below).
3. **Paywall/403** — cookies not accepted; the report shows the status.
4. **Scanned document** — pages load but have no text layer (images only).

### Respect the source

Only scrape content you have the right to access, keep the rate limits on,
and check Scribd's Terms and applicable copyright law for your use case.
