# Scribd downloader

Turns Scribd documents into clean PDFs — one document page per sheet — **without
pip and without a Python framework**. Python 3.8+ is enough (developed on 3.11).

## Clean layout

```text
tools/
  build_scribd_singlefile.py      # dev tool: makes a one-file deployment copy
  downloader/                    # the Python panel — split sources only
    scribd_download.py           # thin loader / entry point
    scribd_config.py             # config, cookies, network, tokens, links, helpers
    scribd_pages.py              # image decoding, page heuristics, PDF assembly
    scribd_jobs.py               # job engine, page sources, run/batch/probe
    scribd_shots.py              # shooter bridge, screenshot fallback, _download
    scribd_panel.py              # search, HTTP panel, embedded UI, CLI main
    scribd_selftest.py           # offline selftest and __main__ guard
  troy-search/                   # separate JS search + /shot service
    index.js
    core.js
    selftest.js
docs/
  scribd-downloader.md           # this manual
```

`tools/downloader/scribd_download.py` executes the six `scribd_*.py` source
modules in order in one shared namespace. That keeps every function importable
exactly as before and leaves `inspect.getsource()` pointing at the real file,
while each module stays in the 1,000–1,500 line range and has one clear
responsibility. The builder is the only `.py` file left at the `tools/` root.

The old `tools/scribd_parts/`, `tools/troy-search/src/`, top-level
`tools/scribd_*.py` files, `tools/README.md`, and the standalone helper scripts
have been removed from the repository. Use the panel, the built-in CLI,
`tools/troy-search/`, and this manual instead.

---

## Quick start (from the repo root)

```bash
python3 tools/downloader/scribd_download.py --selftest
python3 tools/downloader/scribd_download.py --url "https://www.scribd.com/document/…"
python3 tools/downloader/scribd_download.py --find "physics 12th" --pick 1,3
SERVER_PORT=25811 python3 tools/downloader/scribd_download.py   # HTTP panel
python3 tools/build_scribd_singlefile.py                         # one-file build
python3 tools/build_scribd_singlefile.py --check
node tools/troy-search/index.js --selftest
```

## Deployment

### Split folder (recommended)

Upload the whole repo (or at least the whole `tools/` tree). The panel root must
contain `downloader/` and `troy-search/` as siblings.

- Full-repo mirror, e.g. the GitHub Actions `lftp mirror -R ./ /`:
  `PY_FILE=tools/downloader/scribd_download.py`
- If you upload only the **contents** of `tools/` to the panel root instead:
  `PY_FILE=downloader/scribd_download.py`

The loader finds its six modules beside itself. It looks for `troy-search/` and
`shooter-found.txt` in the parent `tools/` folder by default. If your host uses
a different layout, set `SCRIBD_TOOLS_DIR` to the folder that contains them.
`SCRIBD_SHOOTER_DIR` overrides the service directory itself, and
`SCRIBD_AUTOSHOOT=0` forbids starting Chromium locally.

Cookies are read from `COOKIES`, `SCRIBD_WEB_COOKIES`,
`SCRIBD_DIAG_COOKIES`, `cookies.txt`, `./cookies.txt`, or
`/home/container/cookies.txt`; `--cookies PATH` sets `COOKIES`. Only
`scribd.com` / `scribdassets.com` cookies are sent.

### One file (Pterodactyl `PY_FILE`)

From the repo root:

```bash
python3 tools/build_scribd_singlefile.py
# -> tools/scribd_download_singlefile.py
python3 tools/scribd_download_singlefile.py --selftest
```

Upload `tools/scribd_download_singlefile.py` as `scribd_download.py` and keep:

```bash
PY_FILE=scribd_download.py
```

The generated file is gitignored. The builder stays at `tools/` root and reads
the six sources from `tools/downloader/`. In one-file mode the generated file's
own folder is treated as the `tools/` folder, so `troy-search/` should sit
beside it when you want local screenshots.

### Old files to delete on an existing panel

The deploy workflow mirrors **without `--delete`**, so remove these once in the
panel's **Files** tab after upgrading:

- `tools/scribd_parts/` and `tools/troy-search/src/` — old 179-fragment / 11-module splits.
- `tools/scribd_download.py`, `tools/scribd_core.py`, `tools/scribd_config.py`,
  `tools/scribd_pages.py`, `tools/scribd_jobs.py`, `tools/scribd_shots.py`,
  `tools/scribd_panel.py`, `tools/scribd_selftest.py` — old top-level Python copies.
- `tools/README.md`, `tools/_mock_scribd.py`, `tools/audit_pdf_pages.py`,
  `tools/screenshots_to_pdf.py`, `tools/scribd_screenshots.py`,
  `tools/scribd_search.py` — removed legacy helpers.
- `tools/scribd_download_singlefile.py`,
  `tools/downloader/scribd_download_singlefile.py`, `tools/shooter-found.txt`,
  `tools/downloader/shooter-found.txt` — only if a previous deploy left a
  generated copy or stale cache behind.

Do **not** delete `tools/downloader/`, `tools/build_scribd_singlefile.py`,
`tools/troy-search/`, `session/`, `.env`, or `database/*.json`.

---

## Command line

Run the loader with no arguments to serve the panel on `SERVER_PORT`, `PORT`, or
`25811`. Useful flags:

| flag | meaning |
|---|---|
| `--url LINK` | download one document; repeat for several |
| `--links "LINK LINK"` | paste a whitespace/newline-separated list |
| `--find "words"` | search Scribd and print numbered hits |
| `--pages N` | how many search result pages to fetch |
| `--pick 1,3` | download chosen hits from `--find` |
| `--limit N` | only the first N pages of each document |
| `--out DIR` | output directory (default `downloads`) |
| `--cookies FILE` | Netscape/base64/JSON cookie file |
| `--base URL` | override the Scribd base URL (testing) |
| `--jobs N` | parallel channels, 1–32 (default 12) |
| `--name NAME` | force the output PDF name |
| `--probe N` | print every URL tried for page N |
| `--shots URL` | point at a specific `/shot` service |
| `--text`, `--text-layer` | add invisible searchable text |
| `--no-check`, `--no-placeholder`, `--no-verify` | relax checks |
| `--verify FILE.pdf` | verify a finished PDF and exit |
| `--selftest` | offline regression checks, no network |
| `-h`, `--help` | print the built-in usage |

`--scans` is accepted but prints that scanning is gone; every page is
photographed. `--shots-only` is a no-op for the same reason. `--base=…` and
`--shots=…` are also accepted.

## Panel routes

The HTTP panel is served by `tools/downloader/scribd_panel.py`. The browser UI
calls these same-origin routes; the dashboard calls them server-side through
`/api/scribd/*` and adds `X-Panel-Key` (or `?key=` / the panel cookie) when
`PANEL_KEY` is set.

| route | method | meaning |
|---|---|---|
| `/` | GET | the embedded search/download page |
| `/health` | GET | `{"ok", "version", "locked", "state"}` — no key needed |
| `/status` | GET | running job: state, verdict, progress, log |
| `/files` | GET | `{"files": [{name, bytes, when}]}` newest first |
| `/file`, `/file/NAME` | GET | stream the finished PDF; signed links allowed |
| `/send?url=…` | GET | queue links from the bookmarklet and show an HTML answer |
| `/logs`, `/logs/NAME` | GET | debug folder as a page or a single file |
| `/find` | POST | `{"query", "page"}` -> documents from Scribd |
| `/run` | POST | `{"urls"\|"url"\|"links", "limit", "text", "jobs"}` |
| `/reset` | POST | stop a job that is not moving |
| `*` | OPTIONS | CORS preflight (`PANEL_ORIGIN` controls allowed origins) |

`/find` asks Scribd's own `/search/query` endpoint; that is an **upstream**
request, not a panel route. The dashboard's `/api/scribd/config` route is also
separate — it stores `SCRIBD_PANEL_URL` / `SCRIBD_PANEL_KEY` in D1 or the disk
store.

Results are ordered by the words you typed: exact phrase first, then all words,
then some. Anything sharing no word is kept but marked **related**.

## PDF behaviour

- One document page per sheet, with the sheet size taken from the median page.
- JPEG bytes are embedded without recompression; PNG pages go through the
  built-in decoder. WebP needs Pillow.
- A small/odd-shaped picture is still used as a scaled preview rather than
  dropped; only sub-16px noise is refused.
- Empty/black images are skipped; real scans beside words are drawn with the
  words kept as an invisible text layer.
- `--text` adds one extra request per page and gives up quietly on pages with no
  descriptor — the PDF still builds.
- Verdicts are honest: `PDF BUILT`, `PDF PARTIAL`, `PDF BROKEN`, `NO PAGES`,
  `BAD LINK`. A failed page is named in the log, never greyed and hidden.

## Screenshot fallback / troy-search

When Scribd gives neither a picture nor words for a page, the panel asks the
optional `tools/troy-search/` service for `/shot?doc=…&page=…`. That service:

- is three files: `index.js`, `core.js`, `selftest.js`;
- tries plain HTTP search before Chromium;
- measures a real page rectangle with `JS_PAGE_RECTS` as a function, not a
  string, so Puppeteer returns boxes instead of `{}`;
- returns a PNG with `X-Shot-Box` describing the measured clip;
- can be autostarted from the sibling `troy-search/` folder when no external
  shooter answers.

The panel caches a found shooter in `shooter-found.txt` beside `troy-search/`
(gitignored). `SCRIBD_TOOLS_DIR` moves that whole lookup,
`SCRIBD_SHOOTER_DIR` points directly at the service, and `SCRIBD_AUTOSHOOT=0`
forbids autostart. `SCRIBD_SHOTS`, `SCRIBD_SHOT_SCALE`, and
`SCRIBD_SHOT_TIMEOUT` tune the client.

## Wiring it into a dashboard

The Next.js dashboard talks to the panel through `dashboard/lib/scribd-panel.ts`
and its `/api/scribd/*` routes. Set `SCRIBD_PANEL_URL` and, when the panel is
locked, `SCRIBD_PANEL_KEY`. `SCRIBD_PUBLIC_URL` lets the dashboard mint a signed
short-lived link straight to `/file` so large PDFs skip the serverless proxy.
See `dashboard/README.md` for the route table.

## Disk guard

`SCRIBD_KEEP_FILES=40`, `SCRIBD_MAX_MB=6000`, `SCRIBD_CACHE_DAYS=3`, and
`SCRIBD_RETRY_BUDGET=75`.

After each finished document and once at startup, the panel prunes old page
caches, then PDFs beyond the newest `KEEP_FILES`, then the oldest PDFs if the
folder is still over `MAX_MB`. It never removes the last PDF and says what it
pruned. Lower `KEEP_FILES` to about 20 on a 10 GB plan.

## Limits, stated plainly

- The panel reads `scribd.com/search/query`; that endpoint is not documented and
  can change. If it refuses the host, the message says so — downloads use the
  document pages, not search.
- A locked page (403) is left out and named. Several refusals in a row are
  treated as throttling: the job rests 4s/12s/30s, slows down, clears its
  blacklist and re-reads the document for a fresh token.
- `/shot` is best-effort. If no browser service is reachable, the PDF is still
  built from whatever arrived and the missing pages are reported.
- Very large documents take a while: roughly 400 pages in ~6 minutes on a shared
  container.
- The text layer drops characters Helvetica cannot draw (anything outside
  Latin-1); the scan still shows them.

## Testing without the network

```bash
python3 -m py_compile tools/downloader/*.py tools/build_scribd_singlefile.py
python3 tools/downloader/scribd_download.py --selftest
python3 tools/downloader/scribd_download.py --help
python3 tools/build_scribd_singlefile.py
python3 tools/build_scribd_singlefile.py --check
python3 tools/scribd_download_singlefile.py --selftest
node --check tools/troy-search/index.js
node --check tools/troy-search/core.js
node --check tools/troy-search/selftest.js
node tools/troy-search/index.js --selftest
git diff --check
```

The loader and generated one-file copy also work from any working directory:

```bash
cd /tmp
python3 /home/user/stream/tools/downloader/scribd_download.py --selftest
python3 /home/user/stream/tools/scribd_download_singlefile.py --selftest
```

Optional real-Chromium smoke test (needs the two npm packages):

```bash
cd tools/troy-search
npm install --no-audit --no-fund --no-package-lock
node index.js --selftest
# then ask /health, /shot/ping, and /shot/ping?launch=1 on the running service
```

The repo-level `npm run selftest` also exercises the dashboard client and the
CI gate; its `Procfile`/`package.json` alignment check is a separate,
pre-existing repository issue.
