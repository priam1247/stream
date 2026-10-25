# scribd-download

One file. Turns Scribd links into clean PDFs — one document page per sheet —
**without a browser, without pip, without a repository**.

`tools/scribd_download.py` is the whole tool. Python 3.8+ and nothing else
(it parses as 3.8 syntax; it was developed and run on 3.11).

```
python tools/scribd_download.py            # panel mode: a page you can use from anywhere
python tools/scribd_download.py --url LINK # one document from the command line
```

---

## How it works (the short version)

| | who does it | why |
|---|---|---|
| **finding links** | **Scribd itself**, asked by the panel | the search engines refuse a server's IP; Scribd does not — the panel already reads Scribd pages, so its search endpoint answers it too |
| **downloading** | the panel | the panel has your cookies, the bandwidth and the disk |

The panel asks `scribd.com/search/query` — the exact request Scribd's own search
page makes — and gets titles, page counts and document links back as JSON. No
Google, no Bing, no DuckDuckGo, so none of them can refuse the address.

Two fallbacks stay, because they cost nothing: a **bookmarklet** (search in your
own browser, one click sends every link on the page) and a **paste box**.

---

## 1. Put it on the panel

1. Upload `tools/scribd_download.py` to `/home/container` (Pterodactyl → Files).
2. Put your `cookies.txt` in the same folder. It is never committed, never
   printed, and only `scribd.com` / `scribdassets.com` cookies are ever sent —
   the rest of a browser export stays out of the request.
3. Start it: `PY_FILE=scribd_download.py`, restart.
4. Open the server address. The line under the title must read **v2.7**.

## 2. Find links: five ways

### a) find them on the panel (no PC needed)

On the panel page, box **1**: type `physics 12th`, press **Find**. Scribd's own
search answers, each result shows its title, link, page count and views. Tick
the ones you want, press **Download ticked**.

If it cannot search, it says why in those words — `HTTP 403 — Scribd refused the
search from this address` is not the same as `no documents match that`, and it
never pretends to be.

Same thing from a shell, if you have one:

```bash
python scribd_download.py --find "physics 12th"                 # list only
python scribd_download.py --find "physics 12th" --pick 1,3      # list, then download 1 and 3
```

Honest caveat: `/search/query` is not a documented API. It is the endpoint
Scribd's own JavaScript calls, so it can change without notice. If it does, the
page tells you instead of showing an empty list, and routes (b) and (c) still
work.

### b) the search helper on your PC (when the panel is refused)

`tools/scribd_search.py` is a second small file — search there, tick what you
want, send it to the panel.

```bash
python tools/scribd_search.py --panel http://YOUR-PANEL:25811
# open http://127.0.0.1:8095/ , type a keyword, tick, press "Send ticked"
```

Why it runs on your PC and not on the panel: Scribd's own search page is a
JavaScript app with no results in its HTML, so the keyword goes to the search
engines that have already indexed scribd.com — and a hosting provider's IP is
very often refused by them, while a home connection is not. The helper asks
DuckDuckGo, DuckDuckGo lite, Bing, Mojeek and Scribd in turn and prints what
each one answered, so "nothing found" never hides "this address was blocked".

It also works from the terminal:

```bash
python tools/scribd_search.py "physics 12th"                      # just list the links
python tools/scribd_search.py "physics 12th" --pick 1,3 \
    --panel http://YOUR-PANEL:25811                               # list, then send 1 and 3
```

The panel address is remembered in the page; `?panel=http://…` pre-fills it.
The panel's answer is shown as it comes back — `queued 3 link(s)`, or
"the panel is already downloading something".

### c) the bookmarklet on the panel page

If you would rather search on Scribd itself, the panel page shows a
bookmarklet — one long `javascript:` line built from the address you opened the
panel on, so it always comes back to *your* panel.

1. `Ctrl+Shift+B` shows your bookmarks bar.
2. Drag the blue **“Send links to this panel”** button onto it. If dragging does
   nothing, press **Copy**, make a bookmark, and paste it as the address.
3. Search Scribd normally in your browser, on the results page you want.
4. Click the bookmark. The panel opens with `queued N link(s)` and starts
   downloading them one after another.

It collects `/document/`, `/presentation/`, `/spreadsheet/` and `/ebook/` links
(up to 40 on a page), merges duplicates, and ignores everything else.

### d) search from your own JS server

If you run a Node box with `@sparticuz/chromium` + `puppeteer-core`, `tools/troy-search/`
is a second small service that searches and hands the links to the panel:

```bash
cd tools/troy-search
npm start                                  # http://0.0.0.0:8096/
# or point it at the panel once:
SCRIBD_PANEL=http://YOUR-PANEL:25811 npm start
```

Type a keyword, tick the documents, press **Send ticked to the panel** — the
panel answers `queued N link(s)` and starts downloading.

It asks Scribd's own `/search/query` first, then DuckDuckGo, DuckDuckGo lite,
Bing and Mojeek with `site:scribd.com`. **Plain HTTP is tried before the
browser**, because that was measured: the same headless Chromium that this box
runs was refused (HTTP 403) by a page that answered plain Python with ten real
Scribd links, from the same address, four minutes apart. The browser is a
fallback, and `/diag` tells you whether it can start at all on this box.

```bash
node index.js "physics 12th"                       # list the links
node index.js "physics 12th" --pick 1,3 --panel http://IP:25811
node index.js --selftest                           # offline check
```

It sends only links, only Scribd document links, at most 40 at a time, and it
prints every engine's answer — `refused`, `captcha`, `no answer` — instead of
turning a block into "no results".

### e) paste links

The panel page also has a box: one link per line, anything that is not a Scribd
document link ignored, duplicates dropped, `?utm=…` and `#page=3` stripped.

## 3. Read the verdict

Every run ends with one of:

| verdict | meaning |
|---|---|
| `PDF BUILT` | every page arrived, the PDF was re-read and passed its own checks |
| `PDF PARTIAL` | some pages could not be fetched; they are labelled placeholder sheets, **in their own position**, and named in the log |
| `PDF BROKEN` | the finished file failed its checks — the reason is printed |
| `NO PAGES` | the document named no pages, or nothing could be read |
| `BAD LINK` | that URL has no document id in it |

A page that will not answer walks a short ladder — the name the document gave,
the same name without the token, then the page's own descriptor — and every URL
it tried is written to `downloads/debug/failed-pages.txt`.

---

## Command line

```bash
python tools/scribd_download.py --find "physics 12th"      # search Scribd, print links
python tools/scribd_download.py --find "physics 12th" --pick 1,3   # then download 1 and 3
python tools/scribd_download.py --url LINK                 # whole document
python tools/scribd_download.py --url LINK --limit 5       # first 5 pages, quick test
python tools/scribd_download.py --url A --url B            # several documents, in order
python tools/scribd_download.py --links "$(cat links.txt)" # a pasted list
python tools/scribd_download.py --url LINK --probe 4       # every URL for page 4 and its answer
python tools/scribd_download.py --verify FILE.pdf          # check a PDF you already have
python tools/scribd_download.py --selftest                 # offline check of the file itself
```

Useful extras: `--out DIR`, `--cookies PATH`, `--jobs N` (default 12),
`--refresh` (ignore the cache), `--name TITLE`, `--no-check`, `--no-placeholder`,
`--no-verify`.

---

## What you get

- `downloads/<title>.pdf` — one document page per sheet, in document order
- `downloads/cache/<id>/` — the page scans, so a re-run does not re-download them
- `downloads/debug/pages.txt` — every page: real pixel size, orientation, source URL
- `downloads/debug/failed-pages.txt` — every URL tried for a page that failed
- `downloads/debug/missing-pages.txt` — just the page numbers

## How the PDF is kept clean

Each sheet is the document's own page size (the **median** page, so one odd scan
cannot shape the book), and each scan is fitted to fill it: aspect ratio kept,
nothing cropped, and never enlarged more than 2× so a small scan stays sharp.
A scan stored sideways is turned upright through the page matrix — no re-encode,
no quality loss. JPEG is embedded as-is; PNG goes in as its own filtered stream.

If the pages genuinely differ (a portrait book with landscape spreads), that is
reported and every sheet keeps its own size instead of being squashed.

## Testing without the network

`tools/_mock_scribd.py` is a local stand-in for Scribd (document page, embed
viewer, page images, Scribd's own search answer, and a query that answers 403):

```
python tools/_mock_scribd.py 8911
python tools/scribd_download.py --base http://127.0.0.1:8911 --out /tmp/out \
    --find "physics 12th"          # the mock answers with two documents
```

`--selftest` covers the rest offline: sheet maths, all four EXIF rotations, JPEG
header traps, PDF verification, cookie filtering, token parsing, pasted links,
the bookmarklet, and the search-answer parser (a refusal is never reported as
"no results").

---

## Limits, stated plainly

- A page whose scan Scribd refuses will stay a placeholder. The log says which
  page and why; it is never quietly dropped.
- Very large documents take a while: roughly 400 pages in ~6 minutes on a shared
  container (the download rate is capped on purpose to avoid throttling).
- The tool reads JPEG and PNG on its own. WebP needs Pillow — without it, those
  pages are reported as unreadable rather than silently lost.
- The panel's search uses `scribd.com/search/query`, the endpoint Scribd's own
  page calls. It is not documented and not promised to stay. It is also read
  only: it returns 42 documents a page, and the panel shows the first page of
  answers, which is what a search box needs.
- If Scribd ever refuses the search from a host's address, the message says
  exactly that. The download half is unaffected — it uses the document pages,
  not the search.
