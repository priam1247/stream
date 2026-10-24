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

0. **`jsonp-pages`** (first) — the document page lists **every** page asset
   `/pages/N-<hash>.jsonp`, each page with its *own hash*. Fetching those
   95 URLs is what produces a complete text extraction. (Earlier versions
   synthesised all pages from page 1's hash, so only page 1 resolved.)
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

With `--browser` the chain is different, and it is where the working PDF
comes from: **`embed-print`** (themrsami's model — see "The embed route"
below) → **`scroll-print`** (the older scroll-the-main-viewer route) →
`jsonp-pages`. `--no-embed` skips the first one.

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

## "Client Challenge" — the anti-bot page

Scribd sits behind Akamai bot protection. When it distrusts a request it
still replies **HTTP 200** with a small page titled *Client Challenge* and
the text *"A required part of this site couldn't load"*. Valid cookies do
not help: what it fingerprints is the **TLS/HTTP2 handshake**, which plain
`httpx` cannot disguise.

This build handles it two ways:

1. **`curl_cffi` impersonation** (default `--impersonate chrome`) — the
   request is performed with a real Chrome fingerprint. It is in
   `requirements.txt`, so `pip install -r requirements.txt` is enough.
2. **Challenge detection** (`scribd/blockers.py`) — a challenge page is
   retried, then raised as an error. It is *never* cached and *never*
   written out as a document. (Before this, a challenge page produced a
   3-line `.txt` and a cheerful `1/1 succeeded`.)

Check which backend you got — the CLI prints it at startup:

```
http backend: curl_cffi (chrome)          # good
http backend: httpx (curl_cffi not installed)   # you will be challenged
```

If you still get challenged with `curl_cffi` active: wait a few minutes
(rate-limited IP), keep `--rate` low, and use `--no-cache` so no earlier
challenge page is reused. A residential IP works far better than a VPN or
datacentre IP; `--proxy` can point at your own proxy.

## Getting the whole document (PDF)

Text extraction gives you the readable text, but on modern Scribd documents
the embed page ships only the **first few pages** of HTML — a 95-page
document yields 3 pages of text. The complete file comes from the page
images:

1. **`pdf-download`** — the real PDF from `/document_downloads/<id>`.
   Works when your account has a download credit; a 403 here is normal
   for free accounts (the CLI says so).
2. **`page-images-pdf`** — downloads every page image
   (`html.scribdassets.com/<uuid>/images/<n>-<hash>.jpg`, plus the uniform
   `screenshots.scribd.com/.../<doc_id>/<n>.jpeg` pattern for pages missing
   from the HTML) and merges them into one PDF with Pillow.

```bash
# whole document as a PDF, keeping the page images too
python -m scribd "https://www.scribd.com/document/REAL_ID/Title" \
    -o out -f pdf --cookies-file cookies.txt --no-cache --keep-images
```

`pdf` is included in the default format list, so a plain run already writes
it. Progress looks like:

```
[123] embed-text: PARTIAL 3/95 pages (the rest is lazy-loaded) — trying fuller strategies
[123] pdf-download: HTTP 403 … usually needs a subscriber download credit
[123] page-images: 95/95 images downloaded
[123] OK via page-images-pdf
```

Notes: 95 images at the default `--rate 6` takes a couple of minutes and is
cached, so a re-run is instant. `--keep-images` also saves
`out/_pages/page-001.jpg …` if you want to OCR them yourself.
`PARTIAL` in the output means fewer than 90% of pages were captured — never
assume it is the whole book.

## The embed route: what `--browser` tries first

`--browser` now starts with the export path from
**[themrsami/scribd-downloader](https://github.com/themrsami/scribd-downloader)**
(ported in `scribd/embedprint.py`, not re-invented). That project is known to
produce clean PDFs on very large documents, and it does not fight the viewer:

1. `/document/<id>/Title` → `https://www.scribd.com/embeds/<id>/content` — the
   bare embed viewer: no site navigation, sidebar, footer or paywall chrome.
2. Pages are loaded **through the viewer's own manager**, not by scrolling:

   ```js
   window.docManager.pages[n].load()          // fetch the page DOM
   window.docManager.pages[n].display()       // render it
   window.docManager.pages[n].turnOnImages()  // start image decoding
   window.docManager.pages[n].innerPageElem   // "ready" marker
   ```

   with bounded concurrency (8) and bounded export batches (8 pages), so a
   thousand-page document does not exhaust Chrome's memory.
3. Toolbars are removed, cookie/consent banners are removed, and
   `.document_scroller` is flattened while keeping its class (removing the
   class breaks math/SVG CSS — that was a bug in older versions).
4. Each `.outer_page` is printed **alone** via the DevTools Protocol:
   `.outer_page { display: none }` for everything else, the target pinned at
   `0,0` at its measured size, `html`/`body` clamped to that size with
   `overflow: hidden`, `@page { size: <w>px <h>px; margin: 0 }`, and
   `Page.printToPDF` with `scale: 1`, `paperWidth/paperHeight` = measured
   px / 96, zero margins, `preferCSSPageSize: true`, **`pageRanges: "1"`**.
5. Every page PDF is read back with `pypdf` and must contain **exactly one
   sheet**; the pages are merged in order.

```bash
python -m scribd "URL" -o out -f pdf --cookies-file cookies.txt --no-cache --browser
# embed-print: https://www.scribd.com/embeds/804179430/content
# embed-print: loaded 95/95 pages directly in 12.43s (concurrency 8)
# embed-print: toolbars removed (1 top, 1 bottom), 1 scroll container(s) flattened
# embed-print: render settled
# embed-print: paper from .outer_page 11.60x15.02 in
# embed-print: exporting 95 pages in batches of 8
# embed-print: page 1 1114x1442px -> 1 sheet
# embed-print: merged 95 page PDFs -> 95 sheets
# OK via embed-print
```

Tuning (same names as upstream):

| env var | default | meaning |
|---|---|---|
| `SCRIBD_PAGE_LOAD_CONCURRENCY` | 8 | pages loaded in parallel |
| `SCRIBD_PAGE_LOAD_TIMEOUT` | 120 | seconds per batch |
| `SCRIBD_EXPORT_BATCH_SIZE` | 8 | pages kept in Chrome at once |
| `SCRIBD_RENDER_SETTLE_TIMEOUT` | 30 | max seconds waiting for fonts/images |

If the embed route is unavailable (`window.docManager` missing, or no
`.outer_page` appears), the CLI falls back to the scroll-based route described
in the next section. `--no-embed` skips it on purpose.

### Search and download without a link

```bash
python -m scribd --search "excel" --limit 5 -o out -f pdf --cookies-file cookies.txt --no-cache --browser
```

`--search` replaces the URL argument: type a keyword, get five documents — no
link needed, and no login either (Scribd search is public; your cookies are
used when present).

**Scribd's search page is a JavaScript app.** The HTTP response is a shell with
zero document links in it — that is why the first version reported
`0 result(s)` on a page that shows twenty results in Chrome. The search now
runs in two steps:

1. **HTTP first** (fast, uses the same cookies/TLS fingerprint as the
   download). If it does carry links, they are used.
2. **A real browser** otherwise: headless Chromium opens
   `https://www.scribd.com/search?query=excel`, closes the cookie banner, waits
   for the result cards, scrolls to the bottom until the card count stops
   growing (the grid is lazy), and reads the document links out of the live
   DOM. It tries the known search URL shapes
   (`/search?query=…`, `…&content_type=documents`, `/search/documents?query=…`)
   and keeps the first that renders results. `--search-pages N` (default 3)
   also walks the result pages with `&page=2,3,…` when the first page does not
   fill `--limit`.

Titles are scored so real ones beat junk: `title` attribute → `aria-label` →
card text → thumbnail `alt` → slug. Duplicates (thumbnail link, title link,
"Save" link for the same document) collapse into one hit with the best title.

Then every hit is printed with its URL and handed to the download chain, so
`out/` ends up with five PDFs.

Knobs: `--limit 5` (how many), `--search-pages 3` (how deep), `--jobs 2`
(documents in parallel — default 2 for `--search`, because every job is a
browser with two tabs), `--search-only` (list the matches and download
nothing), `--pick 1,3,7` (download only those numbers from the printed list):

```bash
# 1) see what the search finds (fast, downloads nothing)
python -m scribd --search "excel and succeed" --limit 50 --search-only --browser --no-cache

# 2) download three of them — the 1st, 3rd and 7th of that list
python -m scribd --search "excel and succeed" --pick 1,3,7 -o out -f pdf --cookies-file cookies.txt --no-cache --browser

# ...or just take the first three
python -m scribd --search "excel and succeed" --limit 3 -o out -f pdf --cookies-file cookies.txt --no-cache --browser
```

`--pick` reads as far as the highest number you ask for, marks the chosen rows
with `*` in the printed list, and warns if a number does not exist.

Every search also writes `out/search-<query>.txt` (one URL per line) and
`.json` (title + URL) for the selection — so you can trim that file by hand and
feed it back with `--file out/search-excel_and_succeed.txt`.

Repeat `--search` for several queries:

```bash
python -m scribd --search "excel" --search "pivot tables" --limit 5 -o out -f pdf --cookies-file cookies.txt --no-cache --browser
```

If nothing is found, the CLI does not pretend it worked: it writes what the
browser saw to `.debug/search-<query>-browser.html` and `.png` (the HTTP page,
when empty, goes to `.debug/search-<query>-p<N>.html`) and says so. Those two
files are enough to fix a changed result layout.

### Speed

* `--workers N` — the per-page `Page.printToPDF` work is split across N tabs
  (default 2, 4 with `--fast`). Each tab loads only the pages it prints, so the
  download cost is unchanged and only the printing runs in parallel.
* `--jobs N` — download several documents at once (default 3 for `--search`).
* `--fast` — 4 tabs, batch of 12, 10s settle budget instead of 30s.
* No more "load every page first": the page count comes from
  `window.docManager` and only the pages being printed are fetched.
  `--preload-all` restores upstream's slower load-everything-first mode.
* Every tab reports its own throughput, e.g.
  `embed-print[w1]: done — 47/47 pages in 90.3s (0.5 pages/s)`, so you can tell
  whether more workers helps on your machine (weak CPU: keep 2; a 3 GB doc with
  `--jobs 3` may want `--jobs 1`).

### If our port ever fails and you just need the file

Both upstream projects work independently of this repo:

```bash
git clone https://github.com/themrsami/scribd-downloader.git && cd scribd-downloader && pip install -r requirements.txt && python scribd-downloader.py
# then paste: https://www.scribd.com/document/804179430/...
```

Or install **xDatx/Studocu-Scribd-Helper** (Chrome → `chrome://extensions` →
Developer mode → Load unpacked, from their Releases ZIP), open the document
with your account, and use its **In PDF** button.

## One book page per PDF sheet



Earlier browser output contained the whole browser viewport (toolbars,
sidebars, viewer chrome) and, after the first attempt at isolating pages,
each page still spilled over **14 sheets**. Two things were wrong:

* the page box was read from the inline `style` attribute, where Scribd writes
  percentages (`width: 100%`), so `parseFloat` produced `100` and the paper
  was ~1 inch instead of the page;
* marking the page *in place* left the viewer's scrollers and virtual pages
  contributing to the printed document, so nothing capped it at one sheet.

What the browser route now does, per document page:

1. **Scroll** the page into view (the viewer is virtualised — an unhydrated
   page would print blank).
2. **Clone** it (`cloneNode(true)`, plus canvas bitmaps and shadow roots) into
   a bare `position: fixed; top: 0; left: 0` root appended to `<body>`. The
   clone is inert, so the viewer cannot re-render or unload it mid-print.
   Its ancestors are rebuilt as class-only shims so Scribd's descendant
   selectors still match.
3. **Measure** with `getComputedStyle` (always px, never the percentage
   inline style) and grow to the image/text-layer bounds if they overflow.
4. **Hide the viewer** — every other `<body>` child gets inline
   `display: none !important`, `html`/`body` are clamped to the page size with
   `overflow: hidden`, and Scribd's decorative frame
   (`.b_tl … .highlighter_canvas`) is dropped.
5. **Print** with `@page { size: <w>px <h>px; margin: 0 }`,
   `page.pdf(width=w/96 in, height=h/96 in, margin=0, page_ranges="1")`,
   `prefer_css_page_size=True` and `print_background=True`, after waiting for
   the clone's images to decode.
6. **Verify** with `pypdf`: exactly one sheet is accepted. A page that prints
   as 0 or several sheets is rasterised from a screenshot of the isolated
   clone instead — never two sheets, never a missing page.
7. **Merge** the one-sheet PDFs with `pypdf`, preserving each page's size.

```bash
python -m scribd "URL" -o out -f pdf --cookies-file cookies.txt --no-cache --browser
# → browser: printing 95 pages, one sheet each
# → browser: page 1 -> 1 sheet 836x1088 pt (1114x1442 px, 1 img(1 loaded), 2140 chars)
# → browser: printed 10/95 pages…
# → browser: merged 95 page PDFs -> 95 sheets
```

If the sheet count is ever wrong you will see one of these instead, which says
exactly which step misbehaved:

```
browser: page 7 printed as image (print gave 2 sheets)     # raster fallback used
browser: page 7 isolate failed (Error: …)                  # selector/measure problem
browser: 3 page(s) could not be printed                    # those pages were dropped
browser: WARNING merged PDF has 90 sheets for 95 pages
browser: pypdf missing, cannot merge page PDFs              # pip install -r requirements.txt
```

`--no-print-pages` falls back to a single whole-document print (the older
viewport-shaped output); `--screenshots` additionally screenshots each page.

## Credits / what these approaches are based on

- **[Phoenix124/scribd-downloader](https://github.com/Phoenix124/scribd-downloader)**
  — the page-asset payload format (`window.pageN_callback(["<html>"])`), text
  extraction from `<span class="a">`, real image URLs from
  `<img class="absimg" orig="...">` (the `src` is a lazy placeholder), and
  deriving page images from asset URLs (`/pages/N-hash.jsonp` →
  `/images/N-hash.jpg`).
- **[themrsami/scribd-downloader](https://github.com/themrsami/scribd-downloader)**
  — the whole `--browser` export path in `scribd/embedprint.py`: embed URL,
  `window.docManager` page loading in bounded batches, chrome removal,
  per-page `@page` + `Page.printToPDF` with `pageRanges: "1"` and `scale: 1`,
  one-sheet assertion, `pypdf` merge.
- **[xDatx/Studocu-Scribd-Helper](https://github.com/xDatx/Studocu-Scribd-Helper)**
  — isolate the viewer (move the page container under `<body>`, hide every
  other body child, flatten ancestors, hide the decorative corner classes) so
  only the document prints.
- **[youngpiu/scribd-pdf-downloader](https://github.com/youngpiu/scribd-pdf-downloader)**
  — scroll each page into view until the container count stabilises
  (`scrollIntoView`, not `scrollBy`), then inject print CSS (hide toolbars,
  flatten `.document_scroller`, `@page` sized to the document) and print.

## If the HTTP routes are refused: the browser route

As a last resort the chain ends with a **real Chromium** (Playwright), which
renders exactly what your logged-in account sees — including pages that are
lazy-loaded by JavaScript — then captures the text of every page and prints
the document to PDF:

Scribd's viewer is **lazy-loaded**: page images for later pages are injected
into the DOM as you scroll, so *no* static request can see them. The browser
route therefore scrolls every scrollable pane of the viewer first, then
collects each page's text and image URLs from the live DOM:

```bash
pip install playwright
playwright install chromium

# force it (skips the HTTP strategies)
python -m scribd "https://www.scribd.com/document/REAL_ID/Title" \
    -o out -f pdf,txt --cookies-file cookies.txt --no-cache --browser
```

Expect a line per ten pages, then:

```
browser: 'div.outer_page' matched 124 containers
browser: captured 10 pages…
…
browser: captured 95 pages via 'div.outer_page' (95 screenshots, 95 image URLs)
browser: PDF from 95 page screenshots
```

Each container is scrolled into view and **screenshotted**, so the PDF no longer
depends on CDN image URLs (those were lazy placeholders returning HTML).

Scribd's viewer is lazy-loaded: page images for later pages only exist in the
DOM after scrolling, so the strategy scrolls first and collects afterwards.

Watch for `browser: N pages via 'div.outer_page', + PDF`. If Playwright is
not installed the strategy says so and the rest of the chain is unaffected.

Note on signed assets: per-page \`?token=...\` query strings are part of the
URL and are preserved now. Dropping them turned every fetch into a 403.

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
