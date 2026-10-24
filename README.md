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

There are two halves, and they deliberately run in different places:

| | who does it | why |
|---|---|---|
| **finding links** | your own browser | Scribd's search page is a JavaScript app, and search engines block a server's IP address. Your browser is not blocked. |
| **downloading** | the panel | the panel has your cookies, the bandwidth and the disk. That is the only part it needs to do. |

So nothing on the server ever searches, and there is nothing about the search
that can break on a host.

---

## 1. Put it on the panel

1. Upload `tools/scribd_download.py` to `/home/container` (Pterodactyl → Files).
2. Put your `cookies.txt` in the same folder. It is never committed, never
   printed, and only `scribd.com` / `scribdassets.com` cookies are ever sent —
   the rest of a browser export stays out of the request.
3. Start it: `PY_FILE=scribd_download.py`, restart.
4. Open the server address. The line under the title must read **v2.6**.

## 2. Send it links from your browser

The page shows a bookmarklet — one long `javascript:` line built from the
address you opened the panel on, so it always comes back to *your* panel.

1. `Ctrl+Shift+B` shows your bookmarks bar.
2. Drag the blue **“Send links to this panel”** button onto it. If dragging does
   nothing, press **Copy**, make a bookmark, and paste it as the address.
3. Search Scribd normally in your browser, on the results page you want.
4. Click the bookmark. The panel opens with `queued N link(s)` and starts
   downloading them one after another.

It collects `/document/`, `/presentation/`, `/spreadsheet/` and `/ebook/` links
(up to 40 on a page), merges duplicates, and ignores everything else.

**Or paste links instead:** one per line in the box on the panel. Anything that
is not a Scribd document link is ignored, duplicates dropped, `?utm=…` and
`#page=3` stripped.

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
viewer, page images, one page that answers 403):

```
python tools/_mock_scribd.py 8911
python tools/scribd_download.py --base http://127.0.0.1:8911 --out /tmp/out \
    --links "https://www.scribd.com/document/750213011/x"
```

`--selftest` covers the rest offline: sheet maths, all four EXIF rotations, JPEG
header traps, PDF verification, cookie filtering, token parsing, pasted links and
the bookmarklet.

---

## Limits, stated plainly

- A page whose scan Scribd refuses will stay a placeholder. The log says which
  page and why; it is never quietly dropped.
- Very large documents take a while: roughly 400 pages in ~6 minutes on a shared
  container (the download rate is capped on purpose to avoid throttling).
- The tool reads JPEG and PNG on its own. WebP needs Pillow — without it, those
  pages are reported as unreadable rather than silently lost.
