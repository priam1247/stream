# The whole setup, in one page

Read this once. Everything else in the repo is detail.

---

## 1. What this repo actually contains

Two things, and only two:

```
scribd/            the downloader (a command-line program)
  ├─ search.py       finds documents by keyword, in a real browser
  ├─ embedprint.py   prints one book page per PDF sheet
  └─ cli.py          ties it together:  python -m scribd ...
  webapp.py        a web page that runs that command for you
  bot.py           a 5-line file whose only job is starting the web page
```

The web page is **not** a second downloader. It is a remote control: you type a
keyword, it starts `python -m scribd …` in the background and shows you the log
and the files. Same code, same output.

## 2. The one hard requirement: a browser

Scribd's search page and its document viewer are both JavaScript. There is no
API. To find documents and to print a PDF, a real Chromium must run *somewhere*:

| works | does not work |
| --- | --- |
| your Windows PC (Chromium from `playwright install`) | anything that cannot launch Chromium |
| Ubuntu / Docker / a VPS with root | a panel egg without `libnspr4`, `libnss3`, … |
| GitHub Actions (`ubuntu-latest`) | Vercel, Netlify, Cloudflare Pages (serverless) |

Almost every failure in this project's history has been one sentence repeated:

```
error while loading shared libraries: libnspr4.so: cannot open shared object file
```

That is not a code bug. It means the machine cannot start a browser.

## 3. So the only real decision: whose machine runs Chromium?

| | who fetches the document | your data bundle pays for | always on? |
| --- | --- | --- | --- |
| Your PC | your PC | **everything** (50–200 MB per book) | no |
| Panel / VPS / Docker | the host | only the final PDF | yes |
| **GitHub Actions** | GitHub's runner | only the final PDF | no (but free) |

Rendering a 95-page book downloads hundreds of page images before the PDF is
written. On a metered connection, that must not happen on your machine.

**Recommended: GitHub Actions.** It is free, it installs Chromium *and its
libraries* correctly, and it needs no server.

---

## 4. Path A — GitHub Actions (recommended, saves data)

You already have the repo: `priam1247/stream`.

**Step 1 — one secret, once.**
On GitHub: *Settings → Secrets and variables → Actions → New repository
secret*.
- Name: `SCRIBD_COOKIES_B64`
- Value: the output of this command, run in your repo folder:

```bash
base64 -w0 cookies.txt
```

That encodes your Scribd session into one line of text. It is stored encrypted
by GitHub, never printed in logs, and only used inside the run.
No cookies? Skip this step — public documents still work.

**Step 2 — run it.**
*Actions* tab → **scribd** (left side) → **Run workflow** → fill in:

| field | example | meaning |
| --- | --- | --- |
| `query` | `excel and succeed` | what to search on Scribd |
| `limit` | `5` | how many documents; **`0` = everything found** |
| `picks` | `1,3,7` | only these result numbers (empty = use `limit`) |
| `pages` | `5` | how many search result pages to walk |
| `search_only` | ☐ | tick it to only *list* results, download nothing |
| `urls` | *(empty)* | paste document URLs to skip the search entirely |

Press **Run workflow**. It takes a few minutes for a book.

**Step 3 — collect the files.**
Open the finished run → **Artifacts** → `scribd-out-<n>.zip`. Inside:

```
out/*.pdf                      one PDF per document
out/search-<query>.txt/.json   the list the search produced
out/manifest.jsonl             one row per document: ok / failed / skipped
.debug/                        only when something failed (page dumps)
```

The runner fetched the document. You only downloaded the zip.

**Limits to know:** one run may last 6 hours; one artifact may be 500 MB; the
artifacts are kept 14 days (edit `retention-days` in
`.github/workflows/scribd.yml`). For a big batch, use `picks` or `limit`, or run
twice — the downloader **skips PDFs it already has**, so a re-run only fetches
what is missing.

---

## 5. Path B — the page, 24/7, on a host with root

If you want the search-and-tick page to stay up (not just one batch), run the
`Dockerfile`:

```bash
docker build -t scribd .
docker run -p 8000:8000 -v "$PWD/data:/data" \
  -e SCRIBD_WEB_USER=me -e SCRIBD_WEB_PASS=secret scribd
```

Then open `http://localhost:8000`. The image installs Chromium **with**
`--with-deps`, i.e. properly, because inside a container you are root.

Free option: **Hugging Face Spaces** → *New Space* → **Docker** → push this
repo → set `app_port: 8000` in the space's `README.md` metadata → add
`SCRIBD_WEB_USER`, `SCRIBD_WEB_PASS`, `SCRIBD_WEB_COOKIES` as space secrets.
Also works unchanged on Fly.io, Render, Railway, or a VPS.

On all of them the host fetches the document, you download only the PDF from the
page.

---

## 6. Path C — the panel (xsystemshosting / Pterodactyl)

It will work **only if Chromium can start there**. In order:

1. **Restart the server** and read the console. Good lines:

   ```
   settings: loaded /home/container/.env
   auth: configured
   libraries: Chromium is missing libnspr4.so, libnss3.so
     libnspr4.so: libnspr4
     ok: all libraries found (2 package(s) unpacked into webdata/sysroot)
   browser: chromium at …/chrome-linux64/chrome
   listening on http://0.0.0.0:25811
   ```

2. If the libraries cannot be fetched (no route to `deb.debian.org`), press
   **Install & test Chromium** in the page — it does the same thing and shows
   the result.

3. If it still says `FAILED … libnspr4.so`, that image cannot run a browser. Stop
   there; use Path A or B. Do not spend another day on it — the code is not the
   problem.

Panel files, once it runs:

```
/home/container/.env          settings (login, cookies path, options)
/home/container/cookies.txt   your Scribd session (never committed)
/home/container/webdata/out/  the PDFs
/home/container/webdata/jobs/ job logs, one folder per job
/home/container/webdata/sysroot/  fetched libraries, if any were needed
```

---

## 7. Doing one document on your PC (data = yours)

Fine for a quick single file, expensive for a whole book:

```bash
cd ~/Documents/stream && source .venv/Scripts/activate
python -m scribd "https://www.scribd.com/document/804179430/Whatever" -o out -f pdf --cookies-file cookies.txt --no-cache --browser
```

The CLI flags that matter:

| flag | meaning |
| --- | --- |
| `--search "text"` | search instead of passing a URL |
| `--limit N` / `--limit 0` | how many results; `0` = all found |
| `--search-pages N` | how deep the search goes (default 3, max 50) |
| `--search-only` | list results, download nothing |
| `--pick 1,3,7` | download only those result numbers |
| `--file urls.txt` | one URL per line, `#` comments allowed |
| `--browser` | use Chromium (needed for search and PDFs) |
| `--cookies-file cookies.txt` | your logged-in session |
| `--overwrite` | re-download even if the PDF exists |
| `-f pdf` | output format |

---

## 8. What each file is for

| file | what it is |
| --- | --- |
| `cookies.txt` | your Scribd session; git-ignored, never log or share it |
| `.env` | settings for a hosted run (login, cookies path) |
| `.env.example` | the same keys, documented — copy it to `.env` |
| `out/` | PDFs + `manifest.jsonl` |
| `webdata/` | web page state: jobs, logs, PDFs, fetched libraries |
| `.github/workflows/scribd.yml` | the GitHub Actions batch runner |
| `Dockerfile` | the image for a 24/7 hosted page |
| `bot.py` | entry point a panel runs |
| `SETUP.md` | this file |

---

## 9. When something goes wrong

| symptom | meaning | fix |
| --- | --- | --- |
| `libnspr4.so: cannot open shared object file` | machine cannot run Chromium | Path A or B; the panel cannot |
| `TargetClosedError: … browser has been closed` | Chromium died at startup | the app retries 3 variants; if all fail, see above |
| `0 result(s)` from the HTTP page | normal — Scribd search is JavaScript | nothing; the browser route follows |
| `no matching documents` | search found nothing | check cookies, try a simpler keyword, tick `search_only` to see the list |
| `Nothing found to download.` with `--search-only` | expected | that flag downloads nothing by design |
| `401 authentication required` | page password | set `SCRIBD_WEB_USER` / `SCRIBD_WEB_PASS`, or read the generated one in the console |
| artifact zip is empty | job failed | open the run log; `.debug/` shows what the browser saw |

**The rule that has held for every round of this project:** a run is only done
when `out/manifest.jsonl` says `"status":"ok"` for the documents you asked for
and the PDF opens. Anything less is a failure with a message, never a silent
success.
