# scribd-scraper

> ## 👉 **[START-HERE.md](START-HERE.md) — 4 steps, 5 minutes**
>
> Do only that. It uses GitHub's computer to fetch the documents, so your data
> bundle only carries the finished PDFs. The panel, Docker and the tunnels are
> not needed for it.
>
> Longer explanations, when you want them: [SETUP.md](SETUP.md) (the whole
> picture), then the rest of this file (how the scraping works).

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
   Never paste it into a chat, screenshot it, or commit it. `.gitignore` only
   protects files git has never seen — uploading it through GitHub's web UI
   commits it anyway, and `.gitignore` cannot undo that. Logging out of Scribd
   invalidates it, which is also the remedy if it ever leaks.
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

## Run it as a web app (search → tick → download)

`python -m scribd.webapp` puts the whole flow behind a page: type a search,
wait, tick the results you want (or "Download all found"), watch the log, then
download the PDFs one by one or as a zip.

```bash
pip install flask
python -m scribd.webapp --host 0.0.0.0 --port 8000
# then open http://127.0.0.1:8000/
```

On Windows (Git Bash), one line:

```bash
cd ~/Documents/stream && source .venv/Scripts/activate && python -m pip install flask && python -m scribd.webapp --host 127.0.0.1 --port 8000
```

Why there is a job queue instead of one request per download: a search is a
20–40 s browser session, and printing a 300-page textbook takes minutes. No
reverse proxy or shared host will hold such a request open. So:

* every action is a **job** (a subprocess: `python -m scribd …`), queued and run
  one at a time (`SCRIBD_WEB_CONCURRENCY`);
* the page polls `/api/jobs/<id>/log?offset=` and shows the CLI's own output —
  the same lines you see in the terminal;
* the search job writes `search-<query>.json`, and the page renders it as a
  tick-list; ticking rows and pressing *Download selected* starts a second job
  with those URLs written to `urls.txt` and passed as `--file`;
* *Download all found* runs `--search <query> --limit 0`, i.e. everything;
* files are served from the shared `out/` folder, and `/api/jobs/<id>/zip`
  bundles that job's PDFs plus `manifest.jsonl`.

State lives in `./webdata` (`jobs/<id>/job.log`, `state.json`, `out/`), so a
restart does not lose the PDFs — and because the CLI skips PDFs it already has,
re-running a failed job only fetches the missing ones.

### Security

Set a password before exposing the port; otherwise anyone who reaches it can
start downloads (and burn your Scribd account's limits):

```bash
export SCRIBD_WEB_USER=me
export SCRIBD_WEB_PASS='something-long'
export SCRIBD_WEB_COOKIES=/home/you/stream/cookies.txt   # your Scribd session, kept out of git
python -m scribd.webapp --host 127.0.0.1 --port 8000
```

All endpoints except `/api/health` then require HTTP Basic auth (or
`SCRIBD_WEB_TOKEN`, sent as `X-Token` or `?token=`). The cookie file is only
ever read by the CLI subprocess — it is never served, logged or echoed.

## Search in your browser, download on the panel (`tools/scribd_download.py`)

The panel **cannot** search, and this is measured rather than assumed:

* Scribd's own search page is a JavaScript app — its HTML contains no results.
* The search engines block the panel's address. `check_deployment.py` says it
  plainly: *"Search engines are blocked from this IP as well, so searches must
  run elsewhere too"*, and `SETUP.md` already recommended splitting the work:
  search elsewhere, paste the URLs into the panel.

So the one-file tool does not search at all. Searching happens in your own
browser; only the links travel:

1. Panel page → copy the bookmarklet shown at the top (or drag the blue button
   onto your bookmarks bar). It is built from the address you opened the panel
   on, so it always points back at *this* panel.
2. Search Scribd normally in your browser.
3. Click the bookmark. Every document link on that page
   (`/document/`, `/presentation/`, `/spreadsheet/`, `/ebook/`, up to 40) is
   handed to the panel's `/send` endpoint, which queues the downloads.

The same panel page also takes a pasted list — one link per line; anything that
is not a Scribd document link is ignored and duplicates are dropped. From the
CLI:

```bash
python tools/scribd_download.py --url LINK                 # one document
python tools/scribd_download.py --url A --url B            # several
python tools/scribd_download.py --links "$(cat urls.txt)"  # a pasted list
```

Each link then runs through exactly the same download path as before, and a
batch ends with a count: `PDF BUILT — 3 of 3 document(s) built`.

## Hand in hand: the panel does the downloading

The panel was never the problem — forcing `--browser` was. That flag *skips* the
HTTP routes. Without it the CLI fetches the document's page assets directly
(`/pages/N-*.jsonp` → images) and merges them into a PDF with Pillow: no
Chromium, no browser memory, and the container's own bandwidth does the work.

So the web UI decides per machine:

```
SCRIBD_WEB_BROWSER=auto   # default: add --browser only if Chromium can start here
SCRIBD_WEB_BROWSER=on     # always (a machine that has a browser)
SCRIBD_WEB_BROWSER=off    # never (panel, VPS, anything without libraries)
```

Search is the other half. Scribd's search page needs JavaScript, so when the
browser is unavailable the CLI falls back to a search engine that still answers
over plain HTTP:

```
web search: 'excel and succeed' via DuckDuckGo (site:scribd.com)
web search: 12 document(s) found
```

Nothing is crawled — it is `site:scribd.com <query>` asked once, and the document
links are read from the result page. `parse_ddg_results` handles DuckDuckGo's
redirect links and every Scribd document type.

| machine | search | download | data |
| --- | --- | --- | --- |
| your PC | Chromium | Chromium (embed-print, one sheet per page) | yours |
| **panel / VPS, no Chromium** | DuckDuckGo over HTTP | page assets over HTTP + Pillow merge | **theirs** |
| GitHub Actions | Chromium | Chromium | theirs |

The Chromium route is still better where it works — it produces the real page
layout, one book page per sheet. The HTTP route is what keeps a plain container
useful, and if `--browser` is on but the browser cannot start, the CLI no longer
dies: it reports why and continues on HTTP.

## Hosting it on a panel (Pterodactyl / panel.xsystemshosting.com)

A Pterodactyl "Python server" is not a shell and not cPanel. It pulls the repo,
runs `pip install -r requirements.txt`, then **executes one file** — by default
`bot.py` — with the panel's own port already in `SERVER_PORT`. `bot.py` in this
repo is that entry point: it starts the web UI on `0.0.0.0:$SERVER_PORT`.

Panel fields (Startup tab):

| Field | Value |
| --- | --- |
| Git Repo | `https://github.com/priam1247/stream` |
| Git Branch | `main` (or the branch you were sent) |
| **PY_FILE** | `bot.py` |
| PY_PACKAGES | leave **empty** — `playwright` is in `requirements.txt` |
| Auto Update | On, if you want the latest code on each start |

Startup variables, then **Start**:

```
SCRIBD_WEB_USER=me
SCRIBD_WEB_PASS=some-long-password
SCRIBD_WEB_COOKIES=/home/container/cookies.txt
```

`cookies.txt` is never committed: upload it with the panel's **Files** tab
(left sidebar → `Files` → upload into `/home/container`). If you have no
cookies, leave `SCRIBD_WEB_COOKIES` unset — public documents still work.

If you set neither `SCRIBD_WEB_USER` nor `SCRIBD_WEB_PASS`, the app refuses to
stay open on a public port: it generates a random password and prints it once in
the console (`user: admin`). Copy it from there, or set the variables.

Then open the panel's address for that server, e.g.
`http://195.123.189.187:25811/` (or the domain the panel gives you).

### No variable editor? Use a `.env` file

Some panel eggs only expose the built-in `SERVER_*` variables — there is no
"add a variable" button. Put the settings in a **`.env`** file next to
`bot.py` instead:

```ini
# /home/container/.env
SCRIBD_WEB_USER=me
SCRIBD_WEB_PASS=change-me-to-something-long
SCRIBD_WEB_COOKIES=/home/container/cookies.txt
```

Upload it with the panel's **Files** tab (or copy `.env.example` and edit it).
A real environment variable always wins over the file, and the console prints
just the path it loaded:

```
starting from /home/container
settings: loaded /home/container/.env
auth: configured (SCRIBD_WEB_USER/SCRIBD_WEB_PASS or SCRIBD_WEB_TOKEN)
```

`.env` is git-ignored — it is never committed, and values are never logged.

`cookies.txt` needs no setting at all: if `SCRIBD_WEB_COOKIES` is unset, the app
uses `cookies.txt` from the code folder (or `webdata/cookies.txt`). Upload it
next to `bot.py` and it is picked up. `/api/health` tells you whether it found
one:

```json
{"ok": true, "env_file": "/home/container/.env", "cookies": true,
 "browser": {"playwright": true, "chromium": true}}
```

Everything recognised in `.env`:

| Key | Meaning | Default |
| --- | --- | --- |
| `SCRIBD_WEB_USER` / `SCRIBD_WEB_PASS` | login for the page | random password printed once |
| `SCRIBD_WEB_TOKEN` | alternative: `X-Token` header / `?token=` | none |
| `SCRIBD_WEB_COOKIES` | path to your Netscape `cookies.txt` | `./cookies.txt` if present |
| `SCRIBD_WEB_DATA` | where PDFs and job logs live | `./webdata` |
| `SCRIBD_WEB_AUTO_BROWSER` | `1` = download Chromium on boot | `0` |
| `SCRIBD_WEB_CONCURRENCY` | jobs at a time (each is a Chromium) | `1` |
| `SCRIBD_WEB_MAX_JOBS` | how many job records to keep | `200` |
| `SCRIBD_WEB_FORMATS` | CLI `-f` formats | `pdf` |
| `SCRIBD_WEB_FAST` / `SCRIBD_WEB_WORKERS` / `SCRIBD_WEB_JOBS` | passed to the CLI | off |

The same file works on your PC (`python -m scribd.webapp` reads it too).

### First start: Chromium

Search and PDF printing both run in headless Chromium. The console tells you
exactly what is missing:

```
browser: chromium at /home/container/.cache/ms-playwright/chromium-…/chrome
browser: playwright is installed but Chromium is not downloaded yet.
         open the page and press 'Install Chromium', or run:
         python -m playwright install chromium
```

There is no shell in the panel, so either

* press **Install & test Chromium** in the page (it starts a normal job and
  streams the download, ~150 MB, once), or
* set `SCRIBD_WEB_AUTO_BROWSER=1` so `bot.py` downloads it on boot.

The job does not stop at "downloaded". It **launches Chromium, renders a page
and prints a test PDF**, because a successful download proves nothing about a
shared container. The log ends with one of:

```
OK: Chromium 156.0.8078.4 launches, renders and prints PDFs
FAILED: BrowserType.launch: ... error while loading shared libraries: libnss3.so
```

Same check from a shell (`--check` skips the download):

```bash
python -m scribd.browsersetup          # install if needed, then test
python -m scribd.browsersetup --check  # test only
```

Exit code is `0` only when the browser really started.

`/api/health` always reports the truth:

```json
{"ok": true, "version": "1.8.0", "env_file": "/home/container/.env",
 "cookies": true,
 "browser": {"playwright": true, "chromium": true, "chromium_path": ".../chrome"}}
```

If Playwright itself cannot launch Chromium, the console/log says which system
library is missing (`libnss3`, `libatk-1.0`, …). That is the one thing you
cannot fix from inside this container — it needs the host image to have them, or
a different host.

### "TargetClosedError: Target page, context or browser has been closed"

That is Chromium dying at startup, not a Scribd problem. Playwright runs
`chrome-headless-shell` for headless work, and on shared containers that binary
very often fails while the full Chrome build next to it still works. The app now
**tries the variants in order and remembers the one that worked**:

1. headless shell (playwright's default)
2. the full Chrome build (`channel="chromium"`)
3. the full Chrome build by explicit path

The winner is cached in `webdata/browser.json` (or `SCRIBD_BROWSER_CACHE`), so
later searches and downloads start with it. `/api/health` reports it as
`browser.mode` (`shell` / `chrome` / `path`).

If all three fail, the log tells you exactly why — look for these lines:

| Log line | Meaning | What to do |
| --- | --- | --- |
| `error while loading shared libraries: libnspr4.so` (or `libnss3`, `libatk-1.0`, `libgbm`) | the image lacks Chromium's system packages | the button fetches them itself (see below); `python -m scribd.sysroot` does it by hand |
| `No usable sandbox` / `Failed to move to new namespace` | the container blocks user namespaces | already handled: `--no-sandbox` is passed by default |
| `Executable doesn't exist at …` | Chromium is not downloaded | press *Install & test Chromium* |
| `Failed to download … ECONNRESET` | `cdn.playwright.dev` is blocked | retry, or point `PLAYWRIGHT_DOWNLOAD_HOST` at a mirror |

## Where to run it so it does not eat your data

Rendering one Scribd document pulls **every page image, font and script** of
that document — often 50-200 MB of traffic for a 60 MB PDF. Whose connection
carries that matters:

| Where it runs | who fetches the document | what you download |
| --- | --- | --- |
| your PC (local web UI) | **your bundle** | everything, then the PDF again |
| a panel / VPS / Docker host | the host | only the finished PDF |
| **GitHub Actions** | GitHub's runner (free) | only the finished PDF |
| a browser on your PC via CDP | **your bundle** | only the finished PDF |

So on a metered connection the browser must live somewhere else. Two hosted
routes need no server of your own and no root fights.

### 1. GitHub Actions — free, and it cannot run out of libraries

GitHub's `ubuntu-latest` runners are complete Ubuntu machines: `sudo` works, so
`playwright install --with-deps chromium` installs `libnspr4`, `libnss3`,
`libatk`, `libgbm` and the rest **properly and permanently**. Nothing to debug.
Private repos get 2,000 free minutes a month; public repos are unlimited.

`.github/workflows/scribd.yml` in this repo does the whole job:

1. **Once:** Settings → Secrets and variables → Actions → *New repository
   secret* → name `SCRIBD_COOKIES_B64`, value = base64 of your `cookies.txt`.
   **Never** use GitHub's *Add file → Upload files* for `cookies.txt`: the web
   upload ignores `.gitignore` and commits the file, and a public repository
   means a live session credential anyone can read. The workflow now refuses to
   run if `cookies.txt` is tracked.
   On Windows, in Git Bash:
   ```bash
   base64 -w0 cookies.txt        # copy the output, paste it as the secret
   ```
   (Without the secret, only public documents work.)
2. **Actions** tab → **scribd** → **Run workflow**, and fill the boxes:
   search text, `limit` (`0` = everything found), `picks` (`1,3,7`), pages, or
   paste document URLs to skip the search.
3. When it finishes, open the run → **Artifacts** → `scribd-out-<n>.zip`:
   the PDFs, `search-<query>.txt/.json` and `manifest.jsonl`.

The runner fetches Scribd; your bundle carries only that zip. A 95-page book
takes a few minutes of runner time, not hours of yours. Artifacts are kept 14
days (set in the workflow).

Limits worth knowing: one run may last 6 hours, an artifact may be 500 MB
(use `--pick` or a smaller `limit` for very large batches), and the workflow is
queued behind nothing else because it has its own concurrency group.

### 2. A container host with root — the app, 24/7

`Dockerfile` in this repo builds an image that already contains Chromium **and
its system libraries**, so the web UI works exactly like it does on your PC:

```bash
docker build -t scribd .
docker run -p 8000:8000 -v "$PWD/data:/data" -e SCRIBD_WEB_USER=me -e SCRIBD_WEB_PASS=secret scribd
```

The same image runs unchanged on hosts that give you root in a container:

* **Hugging Face Spaces** (free CPU, 16 GB RAM) — new *Docker* space, push this
  repo, set the port to `8000` in the space's `README.md` metadata
  (`app_port: 8000`), and add the variables there. The space sleeps after a
  while, which is fine: the queue and the PDFs are on its disk.
* **Fly.io / Render / Railway / any VPS** — same image, same variables,
  `SCRIBD_WEB_DATA` on a mounted volume so the PDFs outlive a restart.

On all of them the document is fetched by the host and you download only the
PDF from the web page.

### 3. If you must use the panel

It can only work if Chromium can start there. In order of likelihood:

1. let the app fetch the missing sonames (`python -m scribd.sysroot`, run
   automatically at boot and at launch — see above);
2. `SCRIBD_BROWSER_CDP=https://…` to drive a browser that runs elsewhere — but
   that browser's traffic is *your* connection again, so it saves nothing;
3. ask the host for an image with Chromium's dependencies.

If none of those hold, the panel can still serve as a **queue and storage**:
run the searches and downloads in GitHub Actions and keep the PDFs where you
like. The app itself has nothing more to debug — the missing piece is the
container's operating system, not the code.

### What will not work, and why

* **Vercel / Netlify / Cloudflare Pages** — serverless functions have seconds of
  lifetime, no disk and no Chromium; a PDF job takes minutes and needs both.
  A static page there could only be a front-end to somewhere else.
* **Google Colab** — works (root, real Ubuntu), but the session ends when the
  tab closes; fine for a one-off batch, not for a 24/7 page.

### Why it works in Zed but not on the panel

Nothing in the code path differs — the difference is the machine under Chromium.

| | your PC (Zed) | the panel container |
| --- | --- | --- |
| Chromium binary | Windows `.exe` | Linux ELF |
| its DLL/.so dependencies | installed with Chrome, or by Windows | **not in the image** |
| result | starts | `libnspr4.so: cannot open shared object file` |

Scribd search *needs* a real browser (the results page is JavaScript), and the
PDF route does too (`printToPDF`). No browser on the host → no search, no PDF.
Every failure in the panel log is that one sentence repeated three times, once
per launch variant.

There are four ways out. They are in order of least effort.

**1. Let the app fetch the libraries (automatic, no root).**
Since 2.0 the launch path repairs itself: the loader names the sonames, they are
pulled out of Debian packages into `webdata/sysroot`, and the launch is retried
once. `bot.py` also runs the check at boot, so a restart with the browser already
downloaded finishes the job:

```
libraries: Chromium is missing libnspr4.so, libnss3.so
  libnspr4.so: libnspr4
  libnss3.so: libnss3
  ok: all libraries found (2 package(s) unpacked into webdata/sysroot)
```

Nothing else to press. If it says `no Debian package known for: …`, paste that
line — it is one entry in `scribd/sysroot.py`.

**2. Drive a browser that already works (remote CDP).**
The panel keeps the web page, the queue and the PDFs; Chromium runs on your PC
or a free browser service. Nothing needs to be installed in the container.

On your PC (Windows, Chrome installed) — one line in Git Bash:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --remote-debugging-port=9222 --headless=new --disable-gpu
```

Make that port reachable from the panel (e.g. `cloudflared tunnel --url http://localhost:9222`,
or your router), then in the panel's `.env`:

```
SCRIBD_BROWSER_CDP=http://<public-host>:9222
```

The log then says `browser: connected to the remote browser at …` and every
search/download runs in *that* browser. If the endpoint stops answering, the app
falls back to a local Chromium instead of failing.

**3. Run the whole app on your PC, publish the page.**
The panel then only hosts nothing — you browse to your own machine:

```bash
cd ~/Documents/stream && source .venv/Scripts/activate && python -m scribd.webapp --host 127.0.0.1 --port 8000
cloudflared tunnel --url http://localhost:8000     # prints https://something.trycloudflare.com
```

That URL works from anywhere, with your local Chromium, your cookies, and no
RAM limits. Close the two windows and it is gone.

**4. Ask the host for a Chromium-capable image.**
`playwright install-deps chromium`, or any image that already has
`libnspr4`, `libnss3`, `libatk-1.0`, `libgbm`, `libxkbcommon`, `libcups`,
`libdrm`, `libxkbcommon` and the X libraries. Some eggs offer a Docker image
choice in the panel; picking one with a desktop stack fixes it permanently.

### Would Vercel (or Netlify, or any static host) work?

No, and it is worth being precise about why, so the search does not continue:

* they run **serverless functions** — no long-lived process, no local disk, no
  job queue; a request is capped at seconds to a minute, and a textbook print is
  minutes;
* the function bundle is a few hundred MB at most — Playwright's Chromium alone
  is ~300 MB unpacked, plus its shared libraries;
* nothing you upload to Vercel can run `chrome`; their runtime is not a
  container you control;
* the PDFs would have nowhere to live between requests.

A *static* Vercel page could only be a front-end pointing at a backend that has
a browser — which is the panel or your PC anyway. Same for Netlify, Cloudflare
Pages, GitHub Pages.

What does work if you want a paid host that runs Chromium: a small VPS
(Hetzner/Fly/Railway/Render with a Docker image), because there you get root and
can `playwright install-deps`. The current app deploys there unchanged:
`python -m scribd.webapp --host 0.0.0.0 --port $PORT`.

### Missing system libraries, without root

The panel can have Chromium downloaded and still refuse to start it:

```
/home/container/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome:
error while loading shared libraries: libnspr4.so: cannot open shared object file
```

`apt-get install` and `playwright install-deps` both need root. But these
libraries are ordinary files inside Debian packages, and a `.deb` is just an
`ar` archive around a tarball. So the app fetches **exactly the sonames the
dynamic loader complains about**, unpacks them into `webdata/sysroot/`, and
points `LD_LIBRARY_PATH` at them. The container's own glibc is used; only the
missing pieces are added.

Press **Install & test Chromium** in the page and it happens automatically:

```
launching headless Chromium…
  all 3 Chromium launch variant(s) failed:
  - full Chrome (channel=chromium): … error while loading shared libraries: libnspr4.so
fetching the missing libraries into the app folder (no root needed)…
  libnspr4.so: libnspr4
  libnss3.so: libnss3
  libatk-1.0.so.0: libatk1.0-0
  ok: all libraries found (3 package(s) unpacked into webdata/sysroot)
retrying the launch with the fetched libraries…
OK: Chromium 156.0.8078.4 launches, renders and prints PDFs
```

From a shell:

```bash
python -m scribd.sysroot --check     # list what is missing and which packages provide it
python -m scribd.sysroot             # fetch, unpack and verify
python -m scribd.sysroot --clean     # remove webdata/sysroot
```

How it decides, and why it is safe:

* `ldd` (part of glibc, always present) prints `lib → not found`. Those names
  are resolved to Debian binary packages by a table in `scribd/sysroot.py`, and
  fetched from `deb.debian.org` following the suite in `/etc/os-release`
  (override with `SCRIBD_DEB_SUITE`).
* The downloaded libraries are probed with `ldd` themselves, so their own
  dependencies are fetched too — a few rounds is enough.
* Extraction uses `dpkg-deb -x` when available; otherwise a 40-line pure-Python
  `ar` + `tarfile` reader handles `.xz` / `.gz` / `.bz2`. Only `.zst` needs the
  optional `zstandard` wheel.
* Nothing is installed system-wide, nothing is overwritten, and
  `python -m scribd.sysroot --clean` undoes all of it.
* Downloads are cached in `webdata/debs/`, so a second run is instant and works
  offline.

If a soname is unknown to the table, the log says so (`no Debian package known
for: …`) instead of pretending to fix it — that line is a one-line addition to
`scribd/sysroot.py`.


Force one variant (e.g. skip the shell entirely) by adding to `.env`:

```
SCRIBD_BROWSER_MODE=chrome
```

Other knobs: `SCRIBD_BROWSER_ARGS="--foo --bar"` (extra Chromium flags),
`SCRIBD_BROWSER_SANDBOX=1` (keep the sandbox, drops `--no-sandbox`),
`SCRIBD_BROWSER_CACHE=/path/browser.json`.

You can reproduce the whole check without the web page:

```bash
python -m scribd.browsersetup --check    # test only
python -m scribd.browsersetup --force    # re-download, then test
```

### Caveats on a panel

* The panel's RAM/CPU limit applies: one Chromium print job wants ~4 GB during
  a large document. Keep `SCRIBD_WEB_CONCURRENCY=1`, and keep `--workers` low.
* Disk is finite. PDFs land in `/home/container/webdata/out/`; delete old jobs
  from **Files** when the disk fills.
* A restart kills running jobs, but not the downloads already finished — the
  CLI skips existing PDFs, so start the same job again and it continues.
* Some panels stop the server after a crash-loop. `bot.py` fails loudly and
  quickly (instead of a silent no-op) when `playwright` is missing, so read the
  console before assuming the app is broken.

### The older cPanel/Python-App route

The app is a normal WSGI app (`scribd.webapp:app`), so cPanel's **Setup Python
App** works: create the app with application root = the checkout, application
startup file = `passenger_wsgi.py`, and the entry point `application`:

```python
# passenger_wsgi.py, next to the scratch checkout
from scribd.webapp import app as application
```

Then, in the virtualenv cPanel created for that app:

```bash
pip install -r requirements.txt
pip install playwright && python -m playwright install chromium
```

and add the environment variables (`SCRIBD_WEB_USER`, `SCRIBD_WEB_PASS`,
`SCRIBD_WEB_COOKIES`, optional `SCRIBD_WEB_DATA=$HOME/webdata`,
`SCRIBD_WEB_CONCURRENCY=1`).

Two honest caveats about shared Python hosting:

1. **Chromium must run.** Every download goes through headless Chromium
   (`--browser`); search and PDF printing both need it. Shared plans often lack
   the shared libraries Chromium wants (`libnss3`, `libatk`, …). Test it first:
   `python -m playwright install --with-deps chromium` or simply run one small
   document through the CLI. If Chromium cannot start there, the web page will
   load but every job will fail in the log — in that case run the web app on
   your own machine (or a small VPS) and use it from the browser instead.
2. **Long jobs vs. idle timeouts.** Passenger recycles idle workers, and a job
   that prints nothing for minutes can be killed. The queue survives that (the
   PDFs are on disk and the CLI resumes), but for real bulk runs prefer
   `screen`/systemd:

```bash
python -m scribd.webapp --host 127.0.0.1 --port 8000
```

with the host's proxy (or an `.htaccess` `ProxyPass`) pointing
`https://xsystemshosting.com/scribd/` at `127.0.0.1:8000`. Keep
`SCRIBD_WEB_CONCURRENCY=1` on a small plan: each concurrent job is its own
Chromium.

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

### Bulk: "download as many as it finds"

`--limit 0` removes the cap. Nothing else changes — the search walks
`--search-pages` result pages, collects every document it sees, and each one is
downloaded:

```bash
python -m scribd --search "malawi" --limit 0 --search-pages 10 -o out -f pdf --cookies-file cookies.txt --no-cache --browser
```

Raising `--search-pages` (default 3, allowed up to 50) is what makes the list
long — `.debug`/`out/search-<query>.txt` shows the collected URLs.

A batch that runs for an hour gets interrupted. So a run is **resumable**:

* A PDF that already exists in `out/` and starts with `%PDF-` is **skipped**,
  not re-downloaded (a 0-byte or HTML "PDF" is treated as broken and redone).
  `--overwrite` forces a re-download.
* Every document gets one row in `out/manifest.jsonl` —
  `{"status":"ok|failed|skipped","url":…,"doc_id":…,"title":…,"pages":…,"pdf_bytes":…,"files":[…],"at":…}`
  so you can see exactly what worked without opening 200 PDFs.
* The last line is a real summary, and the exit code is honest:

```
50 downloaded, 12 already present, 2 failed / 64
```

`0` only if at least one PDF exists (downloaded or already there) **and nothing
failed**; a run where 2 of 64 failed exits non-zero, so a `&&` chain or cron job
does not silently report success.

Re-running the exact same command after a failure therefore only fetches the
missing ones. That is also how you "download a lot": start it, stop it, start it
again.

### Picking from a long list

```bash
python -m scribd --search "excel and succeed" --limit 0 --search-only        # see the list, save it
python -m scribd --search "excel and succeed" --pick 1,4,9,12 -o out -f pdf --browser
```

or edit `out/search-excel_and_succeed.txt` down to the lines you want and:

```bash
python -m scribd --file out/search-excel_and_succeed.txt -o out -f pdf --browser
```

### The one public API route: oEmbed (metadata only)

Scribd has no public search API. What it does have is an **oEmbed provider**,
registered by WordPress for both `/doc/` and `/document/` URLs, and a request
for a public document really does return JSON:

```
https://www.scribd.com/services/oembed?url=<encoded document URL>&format=json
→ {"title": …, "author_name": …, "author_url": …, "thumbnail_url": …,
   "width": …, "height": …, "html": "<iframe src=\"/embeds/<id>/content\">"}
```

That establishes metadata for a public document. It does **not** establish a
search API, and it changes nothing about permissions: a restricted document
simply returns no metadata.

What this repo now does with it:

* **before every download**, one oEmbed request gives the real title and author
  — used in the log line, in `manifest.jsonl` (`"author"`, `"oembed": {...}`) and
  as the fallback when a search result's label is only a slug;
* `--require-public` turns it into a cheap refusal: if oEmbed answers 401/403/404
  the document is skipped **without starting a browser**, which saves minutes
  per private or mistyped link;
* `--no-oembed` disables the request entirely (one extra round trip per
  document, nothing more).

```
oembed: 751945245 → '2K Data' by Some Publisher
oembed: 999999 → HTTP 404 (no public metadata)
SKIPPED https://www.scribd.com/document/999999/x — oEmbed said HTTP 404 (not public; --require-public)
```

Two honest limits, because the difference matters:

* a transport failure returns **no metadata** (None) — never "this document is
  private";
* only an explicit 401/403/404 combined with `--require-public` refuses a
  download. Without the flag, every document is still attempted exactly as
  before.

#### Other Scribd endpoints: patterns, not an API

| pattern | status |
| --- | --- |
| `https://www.scribd.com/search?query=…` | a browser page, not a machine-readable search API — this is why the search needs Chromium or a search engine |
| `https://www.scribd.com/embeds/<id>/content` | the embed viewer, named by oEmbed's own HTML; used by the `--browser` route |
| `https://imgv2-N-f.scribdassets.com/img/document/<id>/<w>x<h>/<token>/<page>` | a thumbnail URL **observed in metadata**; the token is per response, so constructed URLs are not guaranteed |
| `http://api.scribd.com/api` (`docs.search`, `docs.getSettings`…) | the historical Platform API: keyed and signed, not usable as a public endpoint today |
| `https://api.development.scribd.com/api/v3/playground` | a development-environment GraphQL example, not a public production API |

So the architecture does not change: a browser (or a search engine) finds
documents, page assets produce the PDF, and oEmbed supplies the metadata.

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
