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

One fallback stays, because it costs nothing: a **bookmarklet** (search in your
own browser, one click sends every link on the page) and the command line.
Search-then-download is the whole flow, so there is no paste box to fill in.

Results are put in the order the words were typed: the exact phrase first, then
titles with all the words, then titles with some. A result that shares no word
with the query is kept but marked **related** — the search is Scribd's, and it
is deliberately loose, so this is how the page stops looking like it answered
something nobody asked.

---

## 1. Put it on the panel

1. Upload `tools/scribd_download.py` to `/home/container` (Pterodactyl → Files).
2. Put your `cookies.txt` in the same folder. It is never committed, never
   printed, and only `scribd.com` / `scribdassets.com` cookies are ever sent —
   the rest of a browser export stays out of the request.
3. Start it: `PY_FILE=scribd_download.py`, restart.
4. Open the server address. The line under the title must read **v2.12**.

## 2. Find links: five ways

### a) find them on the panel (no PC needed)

On the panel page, box **1**: type `physics 12th`, press **Find**. Scribd's own
search answers, each result shows its title, link, page count and views. Tick
the ones you want, press **Download ticked**.

Under the results it says how far you have got — `showing 40 of 1,234 match(es)`
— and **Load more** asks Scribd for the next 40, appending them and keeping
whatever you already ticked. When the count reaches the total, the button goes
away. If Scribd does not say how many match, it says `showing 40` and the button
stays while each page still brings something new.

The **pages** box beside *Download ticked* is for that download only: `0` is the
whole document, `5` fetches the first five pages of each ticked book.

If it cannot search, it says why in those words — `HTTP 403 — Scribd refused the
search from this address` is not the same as `no documents match that`, and it
never pretends to be.

Same thing from a shell, if you have one:

```bash
python scribd_download.py --find "physics 12th"                 # list only
python scribd_download.py --find "physics 12th" --pages 3       # three pages of results
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

### e) tick all, then keep ticking while it downloads

The panel downloads **one document at a time** and holds the rest in a queue, so
you never wait to start the next book:

- tick a document, press **Download ticked** — it starts;
- while it runs, search again, tick more, press again: the button says
  **Add to queue** and the new ones wait behind the one in flight;
- the progress line shows `book 2 of 5 · 3 waiting`, and every finished document
  gets its own one-word verdict (`BUILT`, `PARTIAL`, `FAILED`);
- the whole batch ends with a single honest verdict (`4 of 4 document(s) built`).

One at a time is deliberate: the panel has one connection budget and one output
folder, and Scribd throttles by address, so two books at once would only make
both slower.

### f) tick many, and how many channels

**Tick all shown** ticks every result the current search has loaded (then
**Clear** undoes it), so a bulk download is two taps. **Load more** asks for the
next page of results and keeps going while Scribd has any left.

**Channels** is how many pages are fetched at once — 8, 12, 16 or 24, default 16.
Each channel is one connection fetching one page. More is not always faster:
Scribd throttles by address, so past a point extra channels only produce more
`403`s, and the log's `pages/s` figure stops rising. The gate slows down when it
sees refusals, which is what keeps the output clean — a page that fails is
retried, never silently dropped.

The command line still takes a list (`--links "LINK LINK"`, `--jobs N`); it is
the page that no longer has a paste box.

## 3. Read the verdict

Every run ends with one of:

| verdict | meaning |
|---|---|
| `PDF BUILT` | every page arrived, the PDF was re-read and passed its own checks |
| `PDF PARTIAL` | some pages could not be fetched; they are labelled placeholder sheets, **in their own position**, named in the log, and the log ends with `why: … 403` so you know whether to wait or to give up on those pages |
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

Useful extras: `--out DIR`, `--cookies PATH`, `--jobs N` (channels; the command
line defaults to 12),
`--refresh` (ignore the cache), `--name TITLE`, `--no-check`, `--no-placeholder`,
`--no-verify`, `--text`.

### `--text`: a PDF you can search and copy

By default every sheet is a picture of the page — readable, not searchable. Add
`--text` (or tick **searchable text** in the panel) and each page's real words go
into the PDF too, invisible, underneath the scan:

```bash
python tools/scribd_download.py --url LINK --text
```

The page looks exactly the same. Ctrl+F finds words in it, selection follows the
lines, and a screen reader can read it. The words come from the page's own
descriptor — the same `<hash>/pages/<n>-<hash>.jsonp` the downloader already
used for page names — and its name is worked out from the scan's name
(`images/2-90c206b2e6.jpg` → `pages/2-90c206b2e6.jsonp`), which was checked
against a live 402-page document. It costs **one extra request per page**, cached
in `downloads/cache/<id>/NNNN.text`, and the verdict reports how many pages got
words: `14 sheet(s), 0.10 MB, 14 page(s) with searchable text`.

---

## What you get

- `downloads/<title>.pdf` — one document page per sheet, in document order
- `downloads/cache/<id>/` — the page scans, so a re-run does not re-download them
- `downloads/debug/pages.txt` — every page: real pixel size, orientation, source URL
- `downloads/debug/failed-pages.txt` — every URL tried for a page that failed
- `downloads/debug/missing-pages.txt` — just the page numbers
- `downloads/debug/rejected/` — any picture that arrived but could not be used,
  so the reason in the log can be checked against the bytes (capped at 40 files)

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
header traps, previews and cut transfers, PDF verification, the text layer (including brackets, backslashes
and non-Latin characters), cookie filtering, token parsing, pasted links, the
bookmarklet, the throttle breaker, and the search-answer parser (a refusal is
never reported as "no results").

---

## Wiring it into a dashboard

The panel is a plain HTTP service, so another site can drive it — a Next.js /
Express / PHP dashboard, no browser automation anywhere. Two settings do the
locking, both optional:

| variable | what it does |
|---|---|
| `PANEL_KEY` (or `SCRIBD_PANEL_KEY`) | locks every route except `/health`. Callers send `X-Panel-Key: …`, or open `?key=…` once (that sets a `SameSite=Strict` cookie). Unset = open, as before. The dashboard stores this value in D1, never in the page |
| `PANEL_ORIGIN` | comma-separated browser origins allowed by CORS, e.g. `https://your-dashboard.vercel.app`. Never a wildcard — it is refused for any other origin |

| route | returns |
|---|---|
| `GET /health` | `{"ok", "version", "locked", "state"}` — no key needed, safe to poll |
| `POST /reset` | `{"ok", "stopped"}` — stop a job the panel still thinks is running |
| `GET /status` | the job: `state`, `verdict`, `detail`, `progress`, `file`, `log`, `queue` (`pending`, `done`, `total`, `current`, `results`), `version` |
| `GET /files` | `{"files": [{"name", "bytes", "when"}]}`, newest first |
| `GET /file` or `/file/NAME` | the finished PDF (attachment) |
| `GET /logs` / `/logs/NAME` | the debug folder |
| `POST /run` | `{"urls" \| "url" \| "links", "limit", "text", "jobs"}` → `{"ok", "queued", "channels", "started", "pending"}`. Never refuses: `started: false` means the documents joined the queue behind the one downloading |
| `POST /find` | `{"query", "page"}` → `{hits, notes, summary, page, total, documents}` |

Best practice is a **server-side proxy**: the dashboard's own backend calls the
panel with `X-Panel-Key`, and the browser only ever talks to the dashboard. That
avoids CORS entirely, keeps the key out of the page, and stops a public
`http://` panel being mixed into an `https://` site.

`?embed=1` on the panel address hides the bookmarklet card and the wide margins,
for showing the whole panel inside a frame.

**This repo already ships that proxy.** The ZaFar Control Room in
[`dashboard/`](../dashboard) has a fourth tab, **Scribd**:

| piece | file |
|---|---|
| panel client (server-side, holds the key) | `dashboard/lib/scribd-panel.ts` |
| session + admin gate | `dashboard/lib/scribd-guard.ts` |
| proxy routes | `dashboard/app/api/scribd/{status,files,find,run,file,config}/route.ts` |
| the tab itself | `dashboard/components/scribd-desk.tsx` |
| where the address/key are saved | `dashboard/lib/storage.ts` → `portal_settings` (`scribd_panel_url`, `scribd_panel_key`) |

The browser calls only `/api/scribd/*` on the dashboard's own origin; the key
never leaves the server. The address and key are editable in the tab's **Panel
settings** card (admin only) and land in Cloudflare D1, so moving the panel to a
new host does not need a redeploy. `SCRIBD_PANEL_URL` / `SCRIBD_PANEL_KEY` in the
environment are just the starting defaults.

### Big books: signed links straight to the panel (no tunnel needed)

The dashboard proxies every byte through its own server function, which is fine
until a 150 MB book meets a hosting limit (Vercel's Hobby plan cuts a function at
60 seconds). The panel has no such limit, so the dashboard can hand the browser a
link that goes **straight to the panel**:

- the panel accepts `?t=<signature>&e=<expiry>` on `/file/<NAME>`: an HMAC of
  `NAME|expiry` keyed with `PANEL_KEY`, valid for one file and a short time;
- the dashboard mints it in `GET /api/scribd/link?name=…` when you press Save;
- so the phone downloads from the panel itself and the key never appears in a
  URL. Nothing extra to run, no tunnel, no domain.

Set this on the dashboard (Vercel → Environment Variables) to switch it on:

```text
SCRIBD_PUBLIC_URL=http://195.123.189.187:25811     # the panel, as the browser sees it
```

`http://` is fine here **because the browser only navigates to it** (a download);
it is never loaded as a subresource inside the https page, so there is no
mixed-content block. Leave it empty and Save goes back to the proxy path.

Verified with curl against the real code: a signed link answers `200` with a
valid PDF, the same signature on another file answers `401`, an expired one
answers `401`, and no signature on a locked panel answers `401`.

If you would rather not expose port 25811 at all, put a **Cloudflare Tunnel**
(named tunnel, `scribd.yourdomain.com -> http://127.0.0.1:25811`) in front and
use `https://…` as `SCRIBD_PUBLIC_URL`. That needs a machine with a shell that
can run `cloudflared` — a Pterodactyl plan has none — so the signed link is the
one that works on the hosting you already have.

## A page Scribd will not serve

Some scanned documents (the uploader's own scans) have pages Scribd answers with
`HTTP 403 AccessDenied` — the page never arrives, under any name, with or without
the token. That is not a decoder problem, and no format handling can invent a
page that was never sent. What the panel does about it:

- the page's placeholders are **labelled and counted**, and the PDF is still
  built — a 120-page book with four refused pages is `PDF PARTIAL`, not a failure;
- retrying is capped by a **budget** (`SCRIBD_RETRY_BUDGET`, 75 seconds per
  document). When the budget is spent the panel says so and builds the book;
  if a retry recovers nothing it does not rest a second time;
- anything that *did* arrive is used: a low-resolution copy goes in as a **small
  preview**, a transfer cut short is kept and reported, a PNG or WebP is
  transcoded (WebP needs Pillow).

Measured on a mock document of 120 pages with 4 permanently refused pages:
**12 seconds**, `PDF PARTIAL`, placeholders on 5, 9, 40 and 77.

## When a download seems to do nothing

The panel runs **one job at a time**, on purpose: two jobs at once write to the
same progress record and the same output folder.

- **A second request is refused clearly.** `/run` answers `409` with the seconds
  since the last page arrived, and the dashboard says that in words instead of
  failing silently. Double-tapping the button on a phone cannot start two jobs.
- **A job that stops moving does not block you for ever.** If nothing has moved
  for 7 minutes, the next request steps over it and says so in the log. The amber
  banner in the dashboard also has **Stop it**, which calls `POST /reset`.
- **Nothing is left half-alive.** Every worker checks a generation number before
  it touches the network, so a reset really stops the pages being fetched — the
  log ends with `stopped — no more pages requested`.

## Disk: the panel keeps itself from filling the plan

`SCRIBD_KEEP_FILES=40`, `SCRIBD_MAX_MB=6000`, `SCRIBD_CACHE_DAYS=3`

Page scans are cached so re-running a partial only fetches the pages that
failed — that cache is what makes the "run it again later" advice cheap. On a
10 GB plan it cannot be kept for ever, so after every finished document (and once
at startup) the panel prunes, and **says what it pruned**:

1. page caches older than `SCRIBD_CACHE_DAYS` (3 days);
2. PDFs beyond the newest `SCRIBD_KEEP_FILES` (40);
3. if the folder is still over `SCRIBD_MAX_MB` (6000 MB), the oldest PDFs go —
   never the last one left.

A 150 MB book plus its cache is roughly 300 MB, so 40 books is about 12 GB of
history: on a 10 GB plan lower `SCRIBD_KEEP_FILES` to about 20.

## Limits, stated plainly

- A page whose scan Scribd refuses will stay a placeholder. The log says which
  page and why; it is never quietly dropped.
- **A refusal means one of two things, and v2.9 tells them apart.** One page
  refused while the rest arrive is a locked page — nothing to do. Different
  pages refused in a row is *throttling*: the job rests (4s, 12s, 30s), slows
  down, clears its blacklist and tries again, then re-reads the document for a
  fresh token before its retry rounds. Before this, the first 403 killed the
  page for the whole run, which is why the missing pages used to grow.
- **A partial is cheap to finish.** Page scans are cached, so running the same
  document again later only fetches the pages that failed — an 8-page test with
  one locked page re-ran in 0.2s once the page was reachable.
- Very large documents take a while: roughly 400 pages in ~6 minutes on a shared
  container (the download rate is capped on purpose to avoid throttling).
- A page that is permanently refused costs at most `SCRIBD_RETRY_BUDGET` seconds
  (75 by default) of the whole document, not minutes per retry round.
- **A picture that arrived but is not a full page now says so.** The log used
  to say `6 kB jpeg that is not a page scan`, which explains nothing. It now
  says what arrived (`a 60x80 jpeg, 430 B — below the 200 px floor for a page`,
  `a 764x1031 jpeg, 6.2 kB, cut short (no end-of-image marker)`), keeps the
  bytes in `downloads/debug/rejected/`, retries a cut transfer once, and puts a
  complete page-shaped picture that is simply small into the PDF as a **small
  preview** — filled to the sheet and counted in the verdict, because a readable
  page beats a blank one. Under 80 px it is still treated as a smudge.
- `--text` is one request per page and gives up quietly on a page that has no
  descriptor: the PDF is still built, that page just stays a picture. A locked
  page (403) gets a placeholder sheet with no words for the same reason.
- The text layer drops characters Helvetica cannot draw (anything outside
  Latin-1, e.g. Devanagari or Chinese) — the scan still shows them. There is no
  way around that without embedding a font, which would blow the file size.
- The tool reads JPEG and PNG on its own. WebP needs Pillow — without it, those
  pages are reported as unreadable rather than silently lost.
- The panel's search uses `scribd.com/search/query`, the endpoint Scribd's own
  page calls. It is not documented and not promised to stay. It answers 40
  documents at a time, plus `total_results_count` — that is where the "of N"
  comes from. Pages go up to 40 (1,600 results); nobody reads further.
- If Scribd ever refuses the search from a host's address, the message says
  exactly that. The download half is unaffected — it uses the document pages,
  not the search.
