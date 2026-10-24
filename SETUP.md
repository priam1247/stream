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

### The one-boot diagnostic (what to run when the panel misbehaves)

Guessing from a job log costs hours. `diag.py` answers every open question in a
single boot, standard library only — no pip, no shell:

```ini
# .env on the panel
SCRIBD_DIAG=1
SCRIBD_DIAG_COOKIES=/home/container/cookies.txt   # optional
SCRIBD_DIAG_DOC=https://www.scribd.com/document/<id>/<slug>   # optional
```

`bot.py` runs it **after** the sysroot step, so `ldd` sees the repaired
libraries, and then the server starts normally. Or run it by hand:
`python diag.py`, and `python diag.py selftest` offline.

What each line settles:

| line | question | if it fails |
| --- | --- | --- |
| `libc` | glibc or musl, and which suite its libraries match | musl → Chromium is impossible on that image, stop |
| `ldd <binary>` | does the loader resolve every `.so` | the missing names are listed; the sysroot step should fetch them |
| `chromium launch` | does it actually start, not just link | the real stderr, plus `libXXX.so` or `GLIBC_x.yy` |
| `dns …` | is it a resolver problem | DNS broken → nothing works |
| `egress deb.debian.org` | can the sysroot download at all | HTTP-only panel; the library route is dormant |
| `scribd /search` | wall or benign JS shell | `challenge=True` means the IP is walled |
| `search ddg-html / ddg-lite / bing` | can a keyword become URLs without a browser | all three fail → search elsewhere, feed URLs |
| `doc page / embed content` anon **and** with cookies | can this IP actually download | `challenge=True` → walled; `URLError` → no route |

Every failing body is saved as `.debug/diag-*.html`, so a FAIL arrives with its
own evidence. Cookie values are never printed — only the count.

Reading the verdict:

```
every line PASS              -> the panel is a complete downloader
chromium lines FAIL          -> HTTP route only (SCRIBD_WEB_BROWSER=off)
doc page FAIL, challenge=True -> the container's IP is walled; download elsewhere
doc page FAIL, URLError/HTTP  -> the container cannot reach Scribd at all
```

If the search engines all fail but Scribd serves the assets, split the work:
search from GitHub Actions or your PC, then paste the URLs into the panel's
`urls` box. Turn `SCRIBD_DIAG` off once the verdict is known — it is a
diagnostic, not a feature.

### Test the download itself: `download_check.py`

`check_deployment.py` answers *can this host run a browser*. This one answers
the other half: **can it download a link and build a PDF without one**. It is
also one file, also nothing to install, and it gives you a page because a panel
usually has no shell.

1. Set `PY_FILE=download_check.py`, restart, open the server URL.
2. Paste a document link, press **Test download**.
3. Read the box: `PDF BUILT` means the panel works; `NO PDF` prints the exact
   line that stopped it, and the log stays on the page.
4. Finished PDFs are listed under the log — click one to download it.

It runs `python -m scribd --file … -o out -f pdf --no-cache`, i.e. exactly what
the app runs, with whatever `cookies.txt` it finds. Tick **also try --browser**
to run the same job through Chromium and see both results side by side. With a
shell: `python download_check.py --url <link>` (add `--browser` to test the
browser, `--selftest` to check the file itself offline).

### Library matching: two traps this handles

`sysroot` does not assume anything about the image:

* **musl (Alpine) can never load Debian `.so` files.** The suite is refused
  outright instead of downloading 40 packages that cannot work.
* **A library that loads but rejects the binary** — `version 'GLIBC_2.36' not
  found (required by libnss3.so)` — is a *suite mismatch*, not a missing file.
  The suite now follows the container's own glibc (`ldd --version`):

  | container glibc | suite pulled | note |
  | --- | --- | --- |
  | < 2.31 | bullseye | too old: expect symbol errors |
  | 2.31 – 2.35 | bullseye | |
  | 2.36 – 2.40 | bookworm | |
  | ≥ 2.41 | trixie | |

  If a launch still reports a `GLIBC_x.yy` mismatch, the launch path steps one
  suite down (bookworm → bullseye) and retries once, automatically.
* **Unknown sonames are looked up, not guessed.** When the built-in table has
  no entry, the suite's `Contents-amd64.gz` index (~40 MB, downloaded once and
  cached) maps the file to its package. Only if that also fails does the log say
  what is missing.
* Every directory holding unpacked `.so` files goes on `LD_LIBRARY_PATH`, and
  all checks run with the same environment the browser gets.

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

### Test the panel first: one file, no installs

Before you upload the whole zip, run `check_deployment.py`. It is one file,
uses only Python's standard library, and needs no package, no Chromium and no
repository next to it. It answers one question: **can this machine do the job?**

1. Download the single file (right-click → *Save link as*):
   <https://raw.githubusercontent.com/priam1247/stream/main/check_deployment.py>
2. Upload it to the panel's file manager, next to `bot.py`.
3. In the panel's startup settings, set **`PY_FILE=check_deployment.py`**, keep
   the port as it is, and restart.
4. Open your server address in the browser. The page shows PASS / FAIL lines and
   a verdict, and refreshes itself while the checks run (about a minute).
5. Put `PY_FILE=bot.py` back when you are done.

You can also run it by hand anywhere: `python check_deployment.py`
(add `--json` for the raw data, `--doc <scribd url>` to test a different
document, `--cookies <path>` if the file is not in the project root).

It tests, and prints the evidence for: Python version, writable folder, free
disk, **glibc or musl**, whether a Chromium binary exists, whether its `.so`
files resolve, whether it really launches, whether it really writes a PDF,
whether `scribd.com` / the oEmbed endpoint / DuckDuckGo / Bing / `deb.debian.org`
are reachable, how many cookies load and whether a session cookie is among them
(counts only — never a value), and the document page anonymous vs. with cookies.

Read only the verdict line:

| verdict | what it means | what to do |
| --- | --- | --- |
| `YES` | browser works, Scribd answers, printing works | deploy the zip here |
| `PARTLY` | Scribd answers but no browser (or Scribd walls this IP) | `SCRIBD_WEB_BROWSER=off`, or use Path A |
| `NO` | cannot reach `scribd.com` at all | do not deploy here; use Path A |

Nothing it writes leaves the machine: the report lands in
`.debug/deployment-check.txt` and `.debug/deployment-check.html`.

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
| `check_deployment.py` | one-file test of a host, before deploying anything |
| `download_check.py` | one-file test: can this host download a link without a browser |
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
