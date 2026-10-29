# ZaFar WhatsApp Bot

A command-driven WhatsApp bot built on Baileys v7 with an integrated Past-Paper Vault, streaming media & movie/series downloader, 9 GB folder-quota disk guard, and a standalone Next.js 16 Control Room in the sibling `dashboard/` folder. **The bot responds to prefixed commands only — natural-language/AI routing and edited-message re-execution are disabled.**

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

## Bot folder layout

```text
Whatsapp bot/
├── index.js          WhatsApp entry point and admin API
├── handler.js        Command dispatch
├── config.js         Configuration from environment variables
├── database.js       Runtime state handling
├── commands/         Admin, general, and media commands
├── engine/           Movie and series resolver/downloader
├── utils/            Bot services and helpers
├── scripts/          Installation and offline regression tests
├── package.json      Bot dependencies and npm scripts
├── .env.example      Configuration template (no real secrets)
└── Procfile          Start command for compatible hosts
```

`database/`, `session/`, `temp/`, `secrets/`, and related files are created at
runtime and are not included in Git. The dashboard (`../dashboard/`) and Scribd
server (`../working scribd/`) are separate projects.

## Quick start

From the repository root (Node.js 22 is recommended; the CI tests use Node 22):

```bash
cd "Whatsapp bot"
cp .env.example .env   # configure privately, or use your host's startup variables
npm ci
npm run selftest       # offline checks; no WhatsApp connection
npm run test:jobs      # offline background-job tests
npm start
```

Run the selftests in a fresh checkout, not against an existing live bot's state;
some checks load modules that access the bot's runtime database directory.
Optionally run `npm run ytdlp:install` on a host that needs yt-dlp installed.
The entry point uses this folder as its working directory, including when it is
started from another directory. Do not commit or share `.env` or session files.

## Disk Budget & Concurrency (10 GB Panel Plan)

Shared container panels often report the entire host node's free space via `statfs`. ZaFar Bot protects against `ENOSPC` crashes with two layers (`utils/diskSpace.js` + `utils/diskGuard.js`):

1. **Bot-Folder Quota (`DISK_BUDGET_MB=9000`)**: Tracks actual bytes inside the bot directory (including `session/`, `database/`, `node_modules/`, and `temp/`) plus **per-job byte reservations** so concurrent downloads can never over-commit a 10 GB plan.
2. **Comparison Logging & Status**: Startup, periodic warnings, and `.status` print both `bot folder: X / 9000 MB` and `host statfs free: Y MB` so operators can compare against the panel's disk meter.
3. **Zero Caching & Boot Sweep**:
   - `QUEUE_LIGHT=20` (short social/music links) and `QUEUE_HEAVY=2` / `MOVIE_CONCURRENCY=2` (movies & episodes).
   - Every delivered media/movie file is deleted immediately after WhatsApp accepts it; `utils/cleanup.js` sweeps leftover `.part`/`.ytdl` partials on boot and caps `temp/` at `TEMP_MAX_MB` (`2048` MB default).
   - Direct torrent support (`webtorrent` optional dependency) remains enabled when `TORRENT_DIRECT=true`.

## Deploying to a server

Confirm the new provider allows WhatsApp bots and the required outbound traffic.
For a panel that uses the server root as the application directory, upload the
**contents** of `Whatsapp bot/` (including `.npmrc` and `.env.example`) to that
root, set your private environment values, install dependencies with `npm ci`,
and start with `npm start` (or `node --expose-gc index.js`). The panel root then
is the bot's working directory. Do not upload `dashboard/` or `working scribd/`
to the bot server unless you intend to run those separate services there.

If the host instead clones the whole repository, set its working/root directory
to `Whatsapp bot` or use `cd "Whatsapp bot" && npm start`. On platforms that
honor a `Procfile`, point the project root to that folder so it finds the bot's
`Procfile` and package files.

### Existing sessions and data

The reorganization does not copy files from a remote server. If moving an existing
bot installation, stop it and securely back up and transfer its `.env`,
`session/`, `database/` (including JSON and SQLite files), and any needed
`secrets/` or `cookies/` to the bot's new working directory. Preserve the originals
until the new installation has been verified. These files are private; never
commit them or post them in support tickets. For a fresh installation, configure
its own environment and pair again instead. Temporary downloads need not be moved.

If an existing panel already runs the bot with its files at the panel root, the
SFTP workflow described below continues uploading the **contents** there, so its
existing state stays in the same place. By contrast, a checkout that previously
ran from the repository root must move its private runtime files into the new
`Whatsapp bot/` directory before starting from there.

### Optional GitHub Actions deployment

GitHub requires workflows under the repository-level `.github/workflows/`, so
`deploy-panel.yml` remains there. It tests the bot and builds the dashboard, then,
if SFTP secrets are configured, uploads a clean archive of the committed bot
folder to the configured panel root and requests a restart. It does not upload the
dashboard, Scribd server, Git metadata, or untracked runtime files; it never uses
`--delete` and excludes existing session and database state from overwrites.

Before enabling or merging changes, check that the configured `PANEL_SFTP_*`,
`PANEL_URL`, `PANEL_SERVER_ID`, and `PANEL_API_KEY` refer to the intended new
server. Missing SFTP secrets skip the upload. The previous option to upload `.git`
for a panel-root `git pull` is no longer available: the repository now has a
nested bot folder, while the panel upload is flat. Use the workflow or deploy the
bot folder's contents from a separate repository checkout instead. Existing Git
metadata on a panel is not updated by this workflow.

## Dashboard and Scribd

The dashboard is a separate Next.js application. See
[`dashboard/README.md`](../dashboard/README.md) for deployment, authentication,
and bot synchronization. The separate Scribd service is documented in
[`working scribd/README.md`](../working%20scribd/README.md); the bot does not
start it.

## License

MIT
