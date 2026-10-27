# ZaFar WhatsApp Bot & Control Room

A command-driven WhatsApp bot built on Baileys v7 with an integrated Past-Paper Vault, streaming media & movie/series downloader, 9 GB folder-quota disk guard, and a standalone Next.js 16 Control Room (`dashboard/`). **The bot responds to prefixed commands only — natural-language/AI routing and edited-message re-execution are disabled.**

## Commands

```text
.movie <title> [year] [quality]        Download a movie (480/720/1080/2160) with poll picker
.series <title> s01e03 [quality]       Download one episode (supports titles like "9-1-1", "Full House")
.series <title> s01 1-6 [quality]      Download an episode range
.series <title> s01 full               Season pack (Drime link when oversized)
.info <title> [series]                 Metadata + provider IDs + active catalogs
.providers / .moviestatus              Source circuit-breakers, queue depth, and disk usage
.paper <course-code> [module] [year]   Search & send past papers (capped per query, 3-day dedupe)
.paper browse [letter|code] [page]     Paginated course/module directory
.countpapers [course-code]             Count papers in the vault
.song <name-or-YouTube-link>           ID3-tagged MP3 via yt-dlp + Cobalt/Gifted fallbacks
.ytv <name-or-YouTube-link> [quality]  Download YouTube MP4 with silent-audio verification
.dl <URL> [audio|video] [quality]      Universal downloader (~1,000 sites, streamed to disk)
.tiktok <URL>  .x <URL>  .pinterest <URL>  .instagram <URL>  .fb <URL>
.spotify <Spotify URL or artist - title>
.sticker (reply to media)              512x512 WebP sticker
.viewonce (reply to view-once media)   Unwrap view-once photo/video/audio (open to allowed users)
.menu / .ping
```

Interactive title and quality choices use **WhatsApp Polls** (with automatic numbered-reply fallback `1`, `2`, … or `cancel`), scoped strictly to the sender and quoted prompt.

## Background link jobs

A bare link (nothing else in the message) from an allowed user in a direct chat is queued and answered with `⚙️ Queued #<id>`. Results up to `INLINE_LIMIT` return as normal WhatsApp media; larger files are uploaded with `rclone` and returned as a share link. Jobs are stored in `database/jobs.sqlite` (built-in `node:sqlite`) and resume after a restart — two run at once, one per provider.

```text
URL_JOBS=1                 set 0 to disable
INLINE_LIMIT=104857600     bytes that still go inline (100 MB)
MEDIA_DIR=temp             staging folder for downloads
RCLONE_REMOTE=gdrive       remote name from secrets/rclone.conf
RCLONE_PATH=bot/uploads    folder inside that remote
```

DRM-protected services (Netflix, Disney+, Apple TV+, Apple Music, Deezer) are refused with a short reason instead of being queued.

Owner/admin commands (hidden from non-owners in `.menu` and error hints):
`.status` (alias `.update`), `.restart`, `.broadcast`, `.on`, `.off`, `.allow`, `.disallow`, `.listusers`, `.cookies`, `.ytdl` (`status` | `update` | `repair` | `proxy` | `test`), and `.refreshpapers`.

## Repository Layout

```text
index.js            Entry point (WhatsApp socket, backoff reconnect, built-in /admin/api server)
handler.js          Command dispatch, per-user cooldown, poll/reply selection routing, error sanitizer
config.js           Central configuration (all secrets read from env vars)
commands/           Command modules (admin/, general/, media/)
utils/              Atomic jsonStore, diskSpace/diskGuard, selections, mediaPipeline, adminApi, etc.
engine/             ESM movie/series resolver & downloader (loaded via utils/movieEngine.js)
database/           Git-ignored runtime JSON state & vault_snapshot.json (backed up with .bak)
scripts/            install-ytdlp.sh and offline regression suite (scripts/selftest.js)
dashboard/          Standalone Next.js 16 web portal (deploy with Root Directory = dashboard)
docs/               Scribd downloader manual (docs/scribd-downloader.md)
tools/              downloader/ (Python panel), troy-search/ (JS service), build_scribd_singlefile.py
Procfile            Process start command (`node --expose-gc index.js`, matching `npm start`)
```

## Quick Start

```bash
cp .env.example .env   # fill in DRIME_API_TOKEN, ADMIN_DASHBOARD_TOKEN, etc.
npm ci
npm run ytdlp:install
npm run selftest       # offline test suite (must pass before deploy)
npm start              # runs: node --expose-gc index.js
```

## Disk Budget & Concurrency (10 GB Panel Plan)

Shared container panels often report the entire host node's free space via `statfs`. ZaFar Bot protects against `ENOSPC` crashes with two layers (`utils/diskSpace.js` + `utils/diskGuard.js`):

1. **Bot-Folder Quota (`DISK_BUDGET_MB=9000`)**: Tracks actual bytes inside the bot directory (including `session/`, `database/`, `node_modules/`, and `temp/`) plus **per-job byte reservations** so concurrent downloads can never over-commit a 10 GB plan.
2. **Comparison Logging & Status**: Startup, periodic warnings, and `.status` print both `bot folder: X / 9000 MB` and `host statfs free: Y MB` so operators can compare against the panel's disk meter.
3. **Zero Caching & Boot Sweep**:
   - `QUEUE_LIGHT=20` (short social/music links) and `QUEUE_HEAVY=2` / `MOVIE_CONCURRENCY=2` (movies & episodes).
   - Every delivered media/movie file is deleted immediately after WhatsApp accepts it; `utils/cleanup.js` sweeps leftover `.part`/`.ytdl` partials on boot and caps `temp/` at `TEMP_MAX_MB` (`2048` MB default).
   - Direct torrent support (`webtorrent` optional dependency) remains enabled when `TORRENT_DIRECT=true`.

## Sizing: what the two servers actually need

| what | RAM it uses | disk it needs |
|---|---|---|
| the Scribd panel (`tools/downloader/scribd_download.py`) | ~70–120 MB while downloading (the channels are threads) | **the real constraint**: each book is 40–150 MB, plus its page cache (roughly the same again) |
| the search helper (`tools/troy-search`) | ~100–200 MB | a few MB |
| the dashboard (`dashboard/`, on Vercel) | 0 on your servers | 0 on your servers |

So 4 GB / 10 GB for the panel is comfortable on RAM and tight on **disk**. The
panel now guards that itself (`SCRIBD_KEEP_FILES=40`, `SCRIBD_MAX_MB=6000`,
`SCRIBD_CACHE_DAYS=3` — lower `KEEP_FILES` to ~20 on a 10 GB plan) and prints
what it pruned.

Merging the two servers buys nothing for downloads — the second box is nearly
idle — and costs a supervisor, because a Pterodactyl startup command runs one
process. If you want one box, run the search under the same startup line
(`node tools/troy-search/index.js & python tools/downloader/scribd_download.py`);
the panel does not need the search to work.

Running the **dashboard** on your own box removes the Vercel function limit, but
it needs HTTPS (the session cookie is `Secure` in production) so a domain and a
reverse proxy, and 2 GB / 2 GB is tight for Next.js. Keeping it on Vercel and
using signed links to the panel gets the same result for free.

## Deploying to XS Systems / Pterodactyl Panel

### 1. Secret Rotation Order (Zero Downtime)
1. **Env First**: Add `DRIME_API_TOKEN`, `TMDB_API_KEY`, `GIFTED_API_KEY`, `ADMIN_DASHBOARD_TOKEN`, `PANEL_URL`, `PANEL_SERVER_ID`, and `PANEL_API_KEY` in the panel's **Startup Variables** (or `.env` on disk).
2. **Code Second**: Merge/push to `main`. `.github/workflows/deploy-panel.yml` runs `npm ci && npm run selftest` + builds `dashboard/` **before** uploading via SFTP.
3. **Revoke Old Keys Last**: Once `.status`, `.paper`, and `.movie` are verified on the live bot, revoke/regenerate any previously hardcoded keys in Drime Cloud, TMDB, Gifted, and the panel.

### 2. Dedicated Restricted Panel Subuser (Recommended for SFTP & `PANEL_API_KEY`)
Never put your master panel account password or an unrestricted account API key into GitHub Actions or `.env`:
1. In the panel, open your server → **Users (Subusers) → New User** and invite a dedicated service email (e.g. `bot-deploy@yourdomain.com`).
2. Grant **only** these permissions:
   - **Control**: `control.console` (read), `control.restart` (for `.restart` and post-deploy restart)
   - **File**: `file.create`, `file.read`, `file.read-content`, `file.update`, `file.sftp` *(leave `file.delete` unchecked if you want SFTP physically unable to delete `session/` or `database/`)*
3. Log in once as that subuser:
   - Copy its **SFTP Username & Password** into GitHub Secrets `PANEL_SFTP_USER` / `PANEL_SFTP_PASS`.
   - Generate a Client API Key (`ptlc_…`) under **Account → API Credentials** and set it as `PANEL_API_KEY` (both in GitHub Secrets for CI restart and in panel Startup Variables for the `.restart` WhatsApp command).

### 3. Manual Panel File Cleanup After Upgrading
Because `.github/workflows/deploy-panel.yml` runs `lftp mirror -R` **without `--delete`** (so `session/`, `.env`, and `database/*.json` — especially `database/vault_snapshot.json` — are never wiped), delete these obsolete files once in the panel's **Files** tab after deploying:

- `admin-server.js` *(replaced by `utils/adminApi.js` inside `index.js`)*
- `utils/heapPlan.js` *(heap re-exec removed; `Procfile` & `npm start` pass `--expose-gc` directly)*
- `utils/memoryWatchdog.js` *(replaced by `utils/diskSpace.js` + `utils/diskGuard.js`)*
- `commands/media/instagram.js` *(merged into streaming `commands/media/shortcuts.js`)*
- `commands/media/facebook.js` *(merged into streaming `commands/media/shortcuts.js`)*
- `engine/core/locker.js` *(unused stub removed)*

- `tools/scribd_parts/` and `tools/troy-search/src/` *(old fragment/module splits;
  replaced by `tools/downloader/` and three JS files)*
- `tools/scribd_download.py`, `tools/scribd_core.py`, `tools/scribd_config.py`,
  `tools/scribd_pages.py`, `tools/scribd_jobs.py`, `tools/scribd_shots.py`,
  `tools/scribd_panel.py` and `tools/scribd_selftest.py` *(old top-level Python
  copies; the split sources now live only in `tools/downloader/`)*
- `tools/README.md`, `tools/_mock_scribd.py`, `tools/audit_pdf_pages.py`,
  `tools/screenshots_to_pdf.py`, `tools/scribd_screenshots.py` and
  `tools/scribd_search.py` *(legacy helpers removed from the repository)*
- `tools/scribd_download_singlefile.py`,
  `tools/downloader/scribd_download_singlefile.py`, `tools/shooter-found.txt`,
  and `tools/downloader/shooter-found.txt` *(only if a previous deploy left a
  generated copy or stale cache behind)*

> **Do NOT delete** `tools/downloader/`, `tools/build_scribd_singlefile.py`, or
> `tools/troy-search/` — those are the live services.

> **Do NOT delete** `session/`, `.env`, or `database/*.json` (`whitelist.json`, `botstate.json`, `media_settings.json`, `paper_log.json`, `vault_snapshot.json`) on the panel! Keeping `database/vault_snapshot.json` avoids walking ~10,900 Drime files on cold boot.

## Scribd Library (panel + dashboard tab)

The Python Scribd panel lives in `tools/downloader/`: a thin loader
(`scribd_download.py`) plus six responsibility modules of roughly 1,000-1,500
lines each — `scribd_config.py` (config, cookies, network, tokens, links and
panel helpers), `scribd_pages.py` (image decoding and PDF assembly),
`scribd_jobs.py` (job engine and page sources), `scribd_shots.py` (shooter
bridge, screenshot fallback and final download), `scribd_panel.py` (search, HTTP
panel and CLI main) and `scribd_selftest.py` (offline selftest and entry guard).
The loader executes them in order in one shared namespace, so the public
behaviour is the same as the old single file. It photographs viewer pages into a
PDF and can serve itself as a small HTTP panel, so no PC is needed.

`tools/build_scribd_singlefile.py` stays at the `tools/` root and can build a
one-file deployment copy. `tools/troy-search/` is the separate JS search/shooter
service (three files). The full manual is
[`docs/scribd-downloader.md`](./docs/scribd-downloader.md).

```bash
python3 tools/downloader/scribd_download.py --selftest   # offline, no network, no deps
python3 tools/downloader/scribd_download.py --url "https://www.scribd.com/document/…"
SERVER_PORT=25811 python3 tools/downloader/scribd_download.py   # HTTP panel mode

# full-repo deploy (e.g. the GitHub Actions mirror):
PY_FILE=tools/downloader/scribd_download.py
# if you upload only the contents of tools/ to the panel root instead:
PY_FILE=downloader/scribd_download.py

# host that still needs one file (upload it as scribd_download.py):
python3 tools/build_scribd_singlefile.py   # -> tools/scribd_download_singlefile.py
```

Verdicts are deliberately honest: `PDF BUILT`, `PDF PARTIAL`, `PDF BROKEN`,
`NO PAGES`, `BAD LINK`. `--text` adds an invisible, searchable text layer (one
extra request per page).

### Working from a phone

Search, then download — that is the whole flow; there is no link box to fill in.

- **Search accuracy**: results are ordered by what you actually typed (exact phrase
  first, then all the words, then some). Anything that shares no word with the
  query is kept but marked **related** — Scribd's search is loose by design, and
  the tag stops a vague answer looking like a real match.
- **Bulk**: **Mark all** ticks every loaded result, **Clear** undoes it, and pages
  can be capped (0 = the whole document). **Load more** keeps going while Scribd
  has results left.
- **Queue**: documents download one at a time and the rest wait. Keep searching
  and ticking while a book downloads — the button turns into **Add to queue**, and
  the progress card shows `book 2 of 5 · 3 waiting` plus each finished book's
  verdict. Nothing is refused because "a job is running".
- **Speed**: **Channels** (8/12/16/24, default 16) is how many pages are fetched at
  once. More is not always faster — Scribd throttles by address, and the log's
  `pages/s` figure is the honest measure.
- **A page Scribd will not serve** (a `403` on a scan-only document) costs the
  book at most 75 seconds of retrying, then the PDF is built with that page
  labelled as a placeholder — `PDF PARTIAL`, never a lost book. **Nothing that
  arrives is discarded**: thumbnails, odd-shaped spreads, cut-short transfers and
  tiny scans all go in, scaled to the sheet. Only sub-16 px noise is refused.
- **A blank page is looked for in three places before it is given up on**
  (v2.18): the page's own descriptor, the address built from a name the document
  did print, and **the viewer's own scroll page** — the page a browser reads,
  which carries the whole book's text in one answer. The viewer's chrome (ads,
  "Share this document", page numbers) is stripped, so it is never drawn as if it
  were the book. If even that page is a JavaScript shell, the panel saves it to
  `downloads/debug/viewer-<id>.html` — no cookie in it — instead of guessing.
- **A drawn page reads like the page (v2.19).** The viewer positions every line,
  and the sheet keeps those positions, so a contents page stays a contents page
  instead of collapsing into one paragraph; two columns on a row stay a row; type
  is sized against the sheet; curly quotes, dashes and dotted leaders are written
  in the encoding Helvetica actually uses, so nothing turns into `?` or vanishes.
  Widths use Helvetica's real metrics, so a line never runs off the page. A page
  that really is a scan (the cover of a converted document) is shown as that
  scan, with its words kept as a searchable text layer; an empty rectangle
  pretending to be a scan is skipped and the words are drawn instead.
- **Waiting is capped.** A document may rest at most `SCRIBD_REST_BUDGET` (60 s)
  in total, and stops resting after two turns if not one page has ever arrived:
  a refused 6-page document went from 2 m 50 s to under a minute with the same
  report at the end.
- **A document that is text, not scans, is still a full PDF.** Most Scribd
  uploads are converted documents: the viewer lays out each page's *words* and
  there is no image for them at all. The panel now reads those pages as text and
  draws them, so a 38-page book is 38 readable pages instead of 1 scan and 37
  `scan not available` sheets. A refused page is asked for its words before it is
  called missing, and the verdict says how many pages came that way
  (`38 of 38 page(s) real · 37 from text`).
- **The scan token is hunted in four shapes** (`?token=`, `"token":"…"`,
  `"imageToken":"…"`, bare `eyJ…` JWT). A scanned upload used to log
  `image token: none` and then 403 on every page; that is what 2.16 fixes.
- **A stuck job stops blocking you**: if a job has not moved for 7 minutes, a new
  download steps over it, and the amber banner's **Stop it** button clears it at
  once (`POST /api/scribd/reset`, administrator only).
- **Saving on a phone**: the PDF is streamed through this dashboard and served as
  a normal attachment, so the phone saves a 150 MB book without holding it in
  memory. Tap the file name if the Save button does nothing.
- **Big files vs. hosting limits**: a Vercel function is cut at 60 s on Hobby.
  Set `SCRIBD_PUBLIC_URL=http://195.123.189.187:25811` on the dashboard and Save
  mints a **signed, short-lived link straight to the panel** (`?t=…&e=…`, an HMAC
  keyed with `PANEL_KEY`), so the bytes never pass through Vercel and the key
  never appears in a URL. `http://` is fine: the browser only navigates to it.
  No tunnel, no domain, no migration.

**The Control Room drives it.** The member console has a fourth tab, **Scribd**, so
the whole workflow lives in the dashboard:

| piece | file |
|---|---|
| server-side panel client (holds the key) | `dashboard/lib/scribd-panel.ts` |
| session / admin gate | `dashboard/lib/scribd-guard.ts` |
| proxy routes | `dashboard/app/api/scribd/{status,files,find,run,file,config,reset}/route.ts` |
| the tab | `dashboard/components/scribd-desk.tsx` |
| saved address & key | `dashboard/lib/storage.ts` → `portal_settings` |

The browser only ever calls `/api/scribd/*` on the dashboard's own origin, so the
panel key never reaches the page and no CORS or mixed-content rules apply.

### Panel settings (no redeploy to move the panel)

Sign in as the administrator, open **Scribd → Panel settings**, paste the panel
address and (if the panel was started with `PANEL_KEY`) the key, then press
**Save & test**. Three outcomes, all shown in the card:

- *the panel answered and the key works* — green light, ready;
- *reachable but refused the key* — `/health` is open, `/status` said 401;
- *did not answer* — wrong address, wrong port, or the server is down.

The values are stored in Cloudflare D1 (`portal_settings` keys
`scribd_panel_url` / `scribd_panel_key`), with the disk store used in local dev.
`SCRIBD_PANEL_URL` / `SCRIBD_PANEL_KEY` in the environment are only the defaults
used before anything is saved, so a fresh deployment already works.

### Locking the panel

```text
PANEL_KEY=<secret>            # every route except /health needs X-Panel-Key
PANEL_ORIGIN=https://your-dashboard.vercel.app   # optional CORS allow-list
```

Leave `PANEL_KEY` unset while testing on a private port; set it before exposing the
panel to the internet. It is the same value you paste into **Panel settings**.

## Linking the Web Dashboard (`dashboard/`)

See [`dashboard/README.md`](./dashboard/README.md) for full Vercel / self-hosted portal instructions.

- **Architecture**: `dashboard/` is a standalone Next.js 16 app using **Local-First Cloudflare D1 + `bcryptjs`** authentication (no external Koyeb auth dependency), login rate limiting (`429` + `Retry-After`), mandatory `JWT_SECRET_KEY` in production, and a 3-second fast-fail bot status proxy.
- **Bot Bridge**: Set `ADMIN_DASHBOARD_TOKEN` and `ADMIN_API_PORT` on the bot. Expose the port over HTTPS via **Cloudflare Tunnel** (`cloudflared tunnel --url http://127.0.0.1:3000` or a named Zero Trust tunnel) and save the `https://` URL + token inside `/admin` → **Bot & Numbers**.
- **Vercel**: create the project with **Root Directory = `dashboard`** (the repo root is the bot; it is not a Next.js app). Set `JWT_SECRET_KEY`, and `CLOUDFLARE_ACCOUNT_ID` + `D1_DATABASE_ID` + `CLOUDFLARE_API_TOKEN` for the D1 stores. Add `SCRIBD_PANEL_URL` / `SCRIBD_PANEL_KEY` only if you want defaults before the first **Save & test**.
- **CORS**: `utils/adminApi.js` no longer sends `Access-Control-Allow-Origin: *`. Server-to-server requests from `dashboard/` need no CORS headers; if you explicitly allow a browser origin, set `ADMIN_CORS_ORIGINS=https://your-portal.vercel.app`.

## License

MIT — Baileys by @whiskeysockets, ZaFar Bot & Control Room.
