# WhatsApp Service

A command-driven WhatsApp bot built on Baileys v7 with an integrated Past-Paper Vault, streaming media & movie/series downloader, 9 GB folder-quota disk guard, and a standalone Next.js 16 Control Room in the sibling `dashboard/` folder. **Each linked session responds only to prefixed commands sent by that same WhatsApp account (`fromMe`). Incoming messages, bare links and edited-message re-execution are ignored; there is no command cooldown.**

## Commands

```text
.movie <title> [year] [quality]        Download a movie (480/720/1080/2160) with title and quality selection
.series <title> s01e03 [quality]       Download one episode (supports titles like "9-1-1", "Full House")
.series <title> s01 1-6 [quality]      Download an episode range
.series <title> s01 full               Season pack (Drime link when oversized)
.dramabox <bookId> [episode]           Get a DramaBox stream link
.info <title> [series]                 Metadata + provider IDs + active catalogs
.providers / .moviestatus              Source circuit-breakers, queue depth, and disk usage
.paper <course-code> [module] [year]   Search & send past papers (capped per query; never re-sent to the same group within 5 days)
.paper browse [letter|code] [page]     Paginated course/module directory
.countpapers [course-code]             Count papers in the vault
.song <name-or-YouTube-URL>            Send one artist-titled MP3 document (Gronka)
.video <name-or-YouTube-URL>           Send the video (Gronka)
.mfind <name|music-link> [--video] [720]  Search catalogs, then deliver via external APIs
.embed <link> [--audio|--video] [720]  Resolve an embed/player link to its canonical URL
.mdiag [search phrase]                 Test the separate standalone downloader
.tiktok <URL>  .instagram <URL>  .fb <URL>
.sticker (reply to media)              512x512 WebP sticker
.viewonce (reply to view-once media)   Unwrap view-once photo/video/audio (from the session owner)
.menu / .ping
```

Interactive title and quality choices use a tap selector or a prefixed numbered reply, such as `.1`, `.2` or `.cancel`. Poll votes and replies without the prefix are ignored.

`.dramabox <bookId> [episode]` follows XJX's DramaBox command: it calls the `/dramabox/stream` resolver with the book ID and episode (default `1`) and returns a stream link. It does not download the episode to the bot host.

### Video sites and YouTube

`.song` and `.video` ask the Gronka API (`https://api.gronka.dev`) for one
finished file and send it to WhatsApp by link; `.fb` and `.instagram` do the same
for public Facebook and Instagram links (carousels up to ten items). Gronka is
the **only** source for these four commands. If it fails, the user sees its
reason (deleted post, video too long, rate limit with seconds to wait) and
nothing else is tried; `.status` shows whether the service is up. Search phrases
for `.song` / `.video` use the first `yt-search` result. `.tiktok` uses the local
yt-dlp pipeline; there is no generic `.dl` command. Removed on request: `.x`,
`.reddit` and `.spotify`. Download only content you have permission to use.

### Music sources

`.mfind` accepts **track, album and playlist links** from Spotify, Deezer,
Apple Music, SoundCloud and YouTube Music; `.mfind <words>` searches the public
music catalogs. Use `.song` and `.video` for the direct XJX-style YouTube
commands:

| Source | What it provides | Credentials |
| --- | --- | --- |
| Deezer public API | search, tracks, albums, artists, playlists | none |
| iTunes Search / Lookup | Apple Music search, albums and songs | none |
| Spotify embed page | track / album / playlist metadata (first 100 rows, longer playlists best effort) | none |
| SoundCloud web API | search and link metadata (public client id) | none |
| Gronka API | the final audio/video file for a matching public YouTube upload | `GRONKA_API_KEY` |

`.mfind` resolves a pasted music-service link to `artist - title` and its
duration, then searches for a matching public YouTube upload. If no catalog
upload matches, it searches YouTube by title and artist. The resolved media is
sent from the external provider URL. Albums and playlists show the existing
numbered picker, capped at ten tracks. The `.song` and `.video` commands do not
resolve music-catalog links; they follow XJX's direct URL/search behavior.

`.mfind` and `.embed` deliver through the same Gronka service, so they need
`GRONKA_API_KEY` too. Provider availability remains external and can change
independently of this repository.

### Social media downloads

`.fb` and `.instagram` / `.ig` use Gronka only (see above). Private or restricted
posts may not resolve; the user is told why.

Streaming services are used for metadata only: nothing is downloaded from
them directly and **no DRM is circumvented**. The background download-job
router (`lib/providerRouter.js`) continues to reject DRM-protected music
hosts. Only download content you have the rights to.

`.mfind` defaults to MP3. Use `.mfind <name|link> --video [720]` (or
`--quality 720`) for a music video, `--first` / a leading `!` to skip the
picker, and `--audio` to force MP3. `.song` and `.video` use XJX command
behavior without audio-mode or quality flags.

Optional tuning for catalog requests: `MUSIC_REQUEST_TIMEOUT_MS`,
`MUSIC_SEARCH_TIMEOUT_MS` and `MUSIC_MAX_DURATION_DRIFT`. For the XJX-style
provider requests, set `XJX_MEDIA_TIMEOUT_MS` and, only if you own them, the
three `XJX_*_API_KEY` variables. The local downloader still uses
`OWN_MEDIA_TIMEOUT_MS`, `OWN_MEDIA_DOWNLOAD_TIMEOUT_MS`,
`OWN_MEDIA_CLIENT_TIMEOUT_MS`, `OWN_MEDIA_FFMPEG_TIMEOUT_MS`,
`OWN_MEDIA_MAX_AUDIO_MB`, `OWN_MEDIA_MAX_VIDEO_MB`, and optional `YT_PO_TOKEN` /
`YT_VISITOR_DATA`; see `.env.example`.

### Standalone media engine (`lib/ownmedia/`)

The local `lib/downloads/pipeline.js` remains for site-specific and other
commands that explicitly use it. It delegates YouTube, YouTube Music,
YouTube-nocookie and SoundCloud URLs to `lib/ownmedia/`, built brick by
brick. `.song` and `.video` do not call this local YouTube pipeline; they use
the XJX resolver sequence above.

| Brick | File | What it does |
| --- | --- | --- |
| 1 | `constants.js` | public endpoints, client matrix, limits, host allowlist |
| 2 | `http.js` | allowlisted HTTPS with redirect re-checks, JSON/text, streamed size-limited downloads |
| 3 | `clients.js` | direct public YouTube `/youtubei/v1/player` + `/results` search, client rotation, format normalisation |
| 4 | `formats.js` | choose a progressive MP4, an audio-only stream, or a video+audio pair to mux |
| 5 | `soundcloud.js` | scrape the public `client_id`, resolve/search tracks, follow `media.transcodings` to an MP3 |
| 6 | `convert.js` | ffmpeg from the locked `@ffmpeg-installer/ffmpeg` (extract MP3, mux MP4, read HLS/DASH) |
| 7 | `engine.js` | resolve → download → convert → tag/remux → send, with per-brick failure reasons |

No external binary, npm package or remote API is required beyond the repo's
existing dependencies. Ciphered formats are skipped rather than downloaded
broken. Optional `YT_PO_TOKEN` / `YT_VISITOR_DATA` are read from the environment
if a host needs them; they are **not** stored here. `.mdiag [query]` prints one
line per brick — ffmpeg, HTTPS transport, client rotation, format selection,
YouTube search, SoundCloud client id and SoundCloud search — so a broken host
can be diagnosed in one message. A failed download also lists the bricks that
were tried instead of just saying "could not download".

### Embed / player links

Share sheets and "copy embed" buttons often give a *player* URL rather than
the normal link. The catalog commands (`.mfind` and `.embed`) normalise these
to a shared URL before resolving metadata, so pasting supported forms works:

| Provider | Embed / player URL | Canonical link |
| --- | --- | --- |
| Spotify | `open.spotify.com/embed/{track\|album\|playlist\|show}/{id}` | `open.spotify.com/{kind}/{id}` |
| Deezer | `widget.deezer.com/widget/{theme}/{kind}/{id}` | `deezer.com/{kind}/{id}` |
| SoundCloud | `w.soundcloud.com/player/?url=<encoded>` | the `url=` parameter |
| YouTube | `youtube-nocookie.com/embed/{id}` or `?videoseries&list=` | `youtube.com/watch?v=` / `playlist?list=` |
| Vimeo / TikTok | `player.vimeo.com/video/{id}`, `tiktok.com/player/v1/{id}` | `vimeo.com/{id}` / the player URL |

The same registry covers Anchor.fm, Buzzsprout, SimpleCast, Zencastr, Bluesky,
Threads, Mastodon, X/Twitter, CodePen, GitHub Gist, StackBlitz, Slides, Relive,
Guild and a generic fallback. `.embed <link>` prints the provider, kind, ID,
canonical URL, embed URL and iframe attributes; `.embed --list` lists all of
them. `.embed <link> --audio` / `--video 720` delivers catalog media directly;
`.mfind` handles music catalog links. `.song` and `.video` use XJX's input
handling and do not normalize non-YouTube music-service links.

The URL shapes, iframe defaults (`loading="lazy"`, `allow`, heights) and the
term-by-term fuzzy search scoring come from
[spences10/sveltekit-embed](https://github.com/spences10/sveltekit-embed)
(MIT, Scott Spence). That project renders browser iframes in SvelteKit; this
bot uses only the public link data — WhatsApp cannot display an iframe and no
Svelte code is included here.

## Background link jobs

Bare links are ignored; use `.song` or `.video` for YouTube media, or a site-specific command. Previously queued bare-link jobs in `database/jobs.sqlite` are preserved but no longer run or send replies automatically.

```text
INLINE_LIMIT=104857600     bytes that still go inline (100 MB)
MEDIA_DIR=temp             staging folder for downloads
RCLONE_REMOTE=gdrive       remote name from secrets/rclone.conf
RCLONE_PATH=bot/uploads    folder inside that remote
```

DRM-protected streams are not decrypted or delivered. Music-service links are
used for metadata only (see "Music sources" above); the actual audio or video
comes from public YouTube / SoundCloud pages.

Owner/admin commands (hidden from non-owners in `.menu` and error hints):
`.status` (alias `.update`), `.restart`, `.on`, `.off`, `.allow`, `.disallow`, `.listusers`, `.cookies` (`commands/ytcookies`), `.ytlogin`, `.ytdl` (`status` | `update` | `repair` | `proxy` | `test`), and `.refreshpapers`.

## Bot folder layout

```text
zafar-bot/
├── index.js              Boot only: sessions, dashboard sync, reload hooks
├── config.js             Configuration from environment variables
│
├── gateway/              Frozen core. Owns sockets, routing and access. No feature logic.
│   ├── handler.js        parse -> guards -> command -> timeout + circuit breaker
│   ├── guards.js         sender-only, approved-only, one-socket-per-message
│   ├── ctx.js            the helper bag every command receives (reply, status, isOwner)
│   ├── registry.js       loads commands/<folder>, isolates failures, on/off + breaker state
│   ├── sessions/         linked-number sessions, reconnect, backup, startup/shutdown
│   ├── users/            approved list (access), member command policy, usage counters
│   └── dashboard/        dashboard sync and the admin API
│
├── commands/             ONE FOLDER PER COMMAND (a folder may export several related triggers)
│   ├── ping/ menu/ info/ sticker/ viewonce/ debrid/ providers/ paper/
│   ├── song/ video/ embed/ mfind/ mdiag/ dramabox/
│   ├── movie/ series/
│   ├── social/           .tiktok .instagram(.ig) .fb (Gronka for fb/ig)
│   └── users/ botmanage/ toggle/ ytcookies/ ytdl/ ytlogin/     (owner only)
│
├── lib/                  Shared, stable infrastructure
│   ├── youtube/ downloads/ music/ ownmedia/ movies/ (media engines used by several commands)
│   └── logger, jsonStore, tempManager, jobQueue, jobDelivery, selections, telemetry, ...
│
├── scripts/              Installation and offline regression tests
├── database/ session/ temp/    created at runtime, never in Git
├── package.json          Baileys is pinned to an exact version (no ^)
├── .env.example          Configuration template (no real secrets)
└── Procfile              Start command for compatible hosts
```

### Groups

* **Papers are never repeated in a group.** `.paper` remembers what it sent to
  each group for 5 days (`PAPER_DEDUPE_DAYS`, 1 to 30). The memory belongs to the
  group, not to an account: if two approved users share a group, the second one
  asking for a paper the first already got is told it was sent, and nothing is
  sent again. Two people asking at the same moment trigger one send. A different
  group has its own memory, and a private chat keeps its own per account. The
  owner is held to the same rule in a group and can resend with
  `.paper <code> <module> --force`.
* **Lightweight:** the memory is one small JSON file, `database/paper_log.json`,
  written once per batch and pruned of anything older than the window.
* Only the approved sender is answered, and replies are quoted to their message
  (see below).

### Who the bot answers

* The bot answers **only approved accounts**, and only when the command is sent
  **by that account itself**. Nobody else can trigger it, in a DM or a group.
* In a group with several approved users, every linked socket sees every
  message, but only the sender's own socket passes `gateway/guards.js`, and a
  message is claimed by exactly one socket. Replies are quoted to the sender's
  message, so there are no duplicate or crossed replies.
* Approval is managed with `.allow`, `.disallow` and `.listusers` (owner only).

### Fixing one command without touching the others

1. `.status` shows every command folder as ✅ ok, ❌ broken (with the reason) or
   ⛔ switched off (owner or circuit breaker).
2. Edit only that command's folder.
3. `.restart <command>` reloads just that folder. Nothing else restarts.
4. `.off <command>` / `.on <command>` switches a single command off or on. Three
   crashes within ten minutes switch a command off automatically; `.on <command>`
   brings it back. Bare `.on` / `.off` still switch the whole bot.
5. Run `npm run test:structure` before deploying: it verifies the layout, command
   isolation, guards and the circuit breaker.

Rules: a command never imports another command; only the owner-only folders
`users/`, `botmanage/` and `toggle/` may use `gateway/`; shared code lives in
`lib/`. There are no hidden fallbacks added by the gateway: a failing command
fails visibly in `.status` and in its log.

## Gronka API (YouTube audio/video, Facebook, Instagram)

Put your key in `.env` (on Termux: `echo 'GRONKA_API_KEY=gk_...' >> .env`) and
restart. With a key set, `.song`, `.video`, `.fb` and `.instagram` ask
`https://api.gronka.dev` for one finished file (`split:false`, so no separate
video and audio parts) and send it by link. Gronka is then the **only** source
for those four commands: if it fails, the user sees its message (for example a
deleted post, a too-long video, or a rate limit with the seconds to wait) and
nothing else is tried. Without a key these commands answer that downloads are not set up. A bad key shows up as "the owner needs to check GRONKA_API_KEY", and the
key is never written to logs or chat. Quota: 50 downloads per 10 minutes per key.

## Console output

Every command is printed with who ran it, where, and how it ended:

```text
21:08:41.120  INFO   commands  .song ← 265991111111 (DM) calm down rema
21:08:44.902  INFO   commands  .song ✓ 3.8s
21:09:10.455  WARN   commands  .fb ✗ 1.2s (CONTENT_GONE)
```

Routine WhatsApp reconnects (status 408, 428, 515) are not logged, because the
session stays linked and reconnects within seconds. If the connection drops 5 or
more times in 10 minutes you get one `WARN ... connection is unstable` line, which
points at the host's network. Set `LOG_LEVEL=debug` to see every reconnect.

## Data backups

The approved-users list, bot and command on/off state, member policy and usage,
media settings, paper history and counters are snapshotted into
`database/backups/` shortly after boot, every 6 hours and on stop. A snapshot is
written only when something changed, and only the newest 10 are kept
(`DB_BACKUP_KEEP`, `DB_BACKUP_EVERY_HOURS`). Tokens and WhatsApp sessions are not
included (sessions have their own encrypted backup, `SESSION_BACKUP_KEY`), and
neither are rebuildable caches. `.status` shows when the last backup ran.

To restore, stop the bot and run:

```text
node lib/dbBackup.js list
node lib/dbBackup.js restore            # newest, or: restore db-20261104-120000.json
```

The state before a restore is snapshotted too, so a restore can be undone. Keep a
copy of `database/backups/` off the host if the disk itself might be wiped.

## Quick start

From the repository root, use Node.js **22.13 or newer** (Node 22 LTS is
recommended; CI uses Node 22). Older runtimes do not provide all the features
needed by the installed Baileys/jsdom dependencies and background jobs:

```bash
cd "Whatsapp bot"
cp .env.example .env   # configure privately, or use your host's startup variables
npm ci
npm run selftest       # offline checks, including preflight regressions; no WhatsApp connection
npm run test:media     # offline YouTube, social, DramaBox, installer, and shortcut tests
npm run test:jobs      # offline background-job tests
npm run test:sessions  # offline pairing, permissions, and delivery tests
npm start
```

Offline tests use temporary source fixtures and synthetic data; they do not copy
or modify the bot's `.env`, sessions, or runtime database. They still use the
installed dependencies and can consume CPU and disk, so a separate checkout is
recommended for testing rather than competing with a running bot. The optional
real HLS smoke test also downloads a binary from GitHub.

Optionally run `npm run ytdlp:install` on a host that needs yt-dlp installed.
The entry point uses this folder as its working directory, including when it is
started from another directory. Do not commit or share `.env` or session files.

For the past-paper vault, a Drime `401` means the service rejected authentication;
check `DRIME_API_TOKEN` and `DRIME_BASE_URL` in private host settings, then use
owner-only `.refreshpapers` to retry. A `403` instead calls for checking folder,
workspace and token permissions. Never paste the token into chat or support logs.
A saved vault snapshot can be stale while refresh is failing.

For HLS streams, N_m3u8DL-RE or ffmpeg is recommended. The pure-Node fallback
handles completed, supported playlists only; it refuses separate audio,
byte-range/changing-map streams and oversized playlists or segments rather than
sending incomplete or corrupt media. Its limits are 4 MiB per playlist and
32 MiB per segment.

## Linking additional WhatsApp accounts

Update both the dashboard and the WhatsApp service, and make sure the service
has `DASHBOARD_URL` and the matching `BOT_SYNC_TOKEN` configured. A member selects **Get code** and links first. An administrator then reviews
the linked request under **Members** and approves or rejects it. Until approval,
the linked session cannot respond to commands. Existing approved numbers retain
access. Each member may have one pending request, and pending sessions count
toward `MAX_LINKED_ACCOUNTS`. On that phone, open
WhatsApp → Linked devices → Link a device → Link with phone number instead, and
enter the code. A code being issued does not mean that linking is complete;
check the individual connection status after entering it. Existing linked
accounts are not replaced by the request. By default, up to 20 additional
accounts can be linked; adjust `MAX_LINKED_ACCOUNTS` if necessary (maximum 100).
Temporary pairing codes are sensitive; do not share them or post unredacted logs.
The service logs a numeric disconnect status and retry delay without session
contents. A logged-out session needs a new link rather than automatic retries.

Each additional account has independent credentials under
`<SESSION_NAME>/linked/`. Keep the entire session directory on persistent,
private storage and back it up securely before moving servers. Never commit,
share, or delete credential files just to request another code. Revoking a
number pauses its ability to respond; re-enabling it resumes access without
granting administrator privileges. Each session accepts commands only from its own WhatsApp account; owner/admin
commands still require the configured owner or administrator identity. `OWNER_NUMBER` and
`ADMIN_NUMBERS` should be set privately for your installation; their existing
fallbacks are retained for compatibility when these variables are empty.

If a custom `SESSION_NAME` is used, keep that whole directory out of Git and
backups/logs shared with others. The default `session/` and common Baileys key
files are ignored, but a custom directory can contain additional private files.

## Encrypted session recovery

Session files are sensitive credentials. When encrypted recovery is disabled,
the bot does not upload or restore snapshots; do not assume there is a current
dashboard backup. Preserve the entire local session directory and a separate
secure backup before changing hosts or files. Recovery is optional and **does
not** guarantee WhatsApp will keep accepting a device. For Vercel, configure
the portal's Cloudflare D1 variables first and confirm the administrator status
reports D1.
Update the dashboard and the bot together. In the bot host's private Environment,
set the existing `DASHBOARD_URL`, `BOT_SYNC_TOKEN`, and `SESSION_BACKUP_KEY`.
Generate the key privately once, for example:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Store that value somewhere secure, then put it in the bot Environment; never
commit it, put it in the dashboard, or share it in chat. The bot uses AES-256-GCM
and uploads only ciphertext over signed HTTPS to D1. The key is not stored there.
Without the original key, backups cannot be recovered. Changing the key while
existing backups still use it prevents startup and is not a rotation procedure.

The bot takes bounded snapshots of registered credentials after serialized auth
writes; allow time for them to finish. Under **WhatsApp → Sync**, verify the
reported last encrypted snapshot and check that all registered sessions have a
current snapshot. A connected recovery service or a recent timestamp alone is not
a complete backup; check service logs for failures. Existing, unreadable,
newer, or conflicting local session files are never silently overwritten; resolve
conflicts manually with secure copies. Revoked sessions and removed ownership
claims are excluded, and confirmed unlink clears the corresponding ciphertext.
If a revocation cannot reach the portal, recovery status reports an error and the
bot persists the revocation locally and retries; do not move hosts until it has
synchronized. If that host is lost before the revocation reaches D1, the remote
backup may still be stale; WhatsApp ultimately decides whether it can reconnect.

If shutdown interrupts a requested unlink, its WhatsApp outcome is unknown. The
bot retains local credentials and conservatively queues a recovery revocation for
that session generation so a late logout cannot restore it. Even if the logout
ultimately fails, that generation must be relinked to enable encrypted recovery
again. If the portal is unreachable, keep the original host and let its queued
revocation synchronize before moving or restoring a session. A crash, hard kill,
or failed/offline sync can still leave the remote snapshot stale. The encrypted
payload is limited to 1 MB; oversize sessions report failure.

For a move, stop the old instance only after a recent successful snapshot, and
start **one** updated instance with the same key and private sync token on the new
host. The service attempts recovery before creating fresh local sessions. Never
run two instances with the same WhatsApp sessions. Keep a separate secure local
backup and be prepared to relink if WhatsApp has revoked the device or recovery
fails. Legacy session manifests without an ownership claim bind once to the
current portal claim; their earlier ownership cannot be proven. No inbound Botkeep port is needed. Repository CI does not upload or restart
the service.

Members' command switches are controlled under **WhatsApp → Commands**. The
service enforces canonical commands, their aliases, and outstanding selections;
the owner can still test. A switch remains **awaiting service sync** until the
running bot acknowledges it. Already-running work is not forcibly cancelled.

## Disk Budget & Concurrency (10 GB Panel Plan)

Shared container panels often report the entire host node's free space via `statfs`. The service protects against `ENOSPC` crashes with two layers (`lib/diskSpace.js` + `lib/diskGuard.js`):

1. **Bot-Folder Quota (`DISK_BUDGET_MB=9000`)**: Tracks actual bytes inside the bot directory (including `session/`, `database/`, `node_modules/`, and `temp/`) plus **per-job byte reservations** so concurrent downloads can never over-commit a 10 GB plan.
2. **Comparison Logging & Status**: Startup, periodic warnings, and `.status` print both `bot folder: X / 9000 MB` and `host statfs free: Y MB` so operators can compare against the panel's disk meter.
3. **Concurrency & Temporary Files**:
   - Commands start concurrently instead of waiting in media lanes. Requests can be rejected immediately if available memory or reserved disk is too low.
   - Bot-generated media is deleted after WhatsApp accepts it. The boot/periodic sweeper removes recognizable abandoned job files but preserves sessions, databases, held transfers and unrelated files. An undelivered legacy background job retains its file for retry.
   - Movie sources do not need debrid account tokens. Direct torrents require `TORRENT_DIRECT=true` and a working optional `webtorrent` install; other sources work without it.

## Deploying to a server

Confirm the new provider allows WhatsApp bots and the required outbound traffic.
For a panel that uses the server root as the application directory, upload the
**contents** of `Whatsapp bot/` (including `.npmrc` and `.env.example`) to that
root, set your private environment values, install dependencies with `npm ci`,
and start with `npm start` (or `node --expose-gc index.js`). The panel root then
is the bot's working directory. Do not upload `dashboard/` or `scribd/`
to the bot server unless you intend to run those separate services there.

If the host instead clones the whole repository, set its working/root directory
to `Whatsapp bot` or use `cd "Whatsapp bot" && npm start`. On platforms that
honor a `Procfile`, point the project root to that folder so it finds the bot's
`Procfile` and package files.

### One Botkeep server

Run only one WhatsApp service using these sessions. The bot synchronizes with
the dashboard through its outbound HTTPS connection; set `DASHBOARD_URL` and
its matching private `BOT_SYNC_TOKEN`. The optional `SESSION_BACKUP_KEY` is a
stable private recovery key: retain it if encrypted recovery is enabled. The
bot's `.restart` reloads code and reconnects locally; dashboard server-power
controls require the separately configured Botkeep Developer API.

If Botkeep still runs an older coordinated bot, stop that process before
updating it to the current code. Preserve its `.env`, session and database, then
configure the dashboard's current single-host sync token to match the bot before
starting it. The previous coordination code cannot operate against a dashboard
that no longer grants leases. The owner manages the separate `botkeep-deploy`
branch and this repository does not update it automatically. Until that app is
updated, its old `.restart` command may still use a previous panel target; avoid
using it. Don't start a second copy of a WhatsApp session while the existing
process is running.

### Existing sessions and data

The reorganization does not copy files from a remote server. If moving an existing
bot installation, stop it and securely back up and transfer its `.env`,
`session/`, `database/` (including JSON and SQLite files), and any needed
`secrets/` or `cookies/` to the bot's new working directory. Preserve the originals
until the new installation has been verified. These files are private; never
commit them or post them in support tickets. For a fresh installation, configure
its own environment and pair again instead. Completed downloads awaiting delivery
are recorded with absolute paths. To resume those jobs after a move, preserve the
job database and their media files at the same absolute paths; otherwise request
the affected downloads again. Other temporary files need not be moved.

### Repository checks

GitHub Actions runs validation only. It does not upload files, restart the bot,
or alter the Botkeep deployment. Update the server manually or by the owner's
existing Botkeep deployment process, taking care to preserve private state.

## Dashboard and Scribd

The dashboard is a separate Next.js application. See
[`dashboard/README.md`](../dashboard/README.md) for deployment, authentication,
and bot synchronization. The separate Scribd service is documented in
[`scribd/README.md`](../scribd/README.md); the bot does not
start it.

## License

MIT

## Migration notes (from the flat `utils/` layout)

| Old | New |
|---|---|
| `handler.js` | `gateway/handler.js` (+ `gateway/ctx.js`, `gateway/guards.js`) |
| `utils/commandLoader.js` | `gateway/registry.js` (folder isolation, breaker, on/off, reload) |
| `utils/sessionManager, reconnect, sessionBackup, serviceStartup` | `gateway/sessions/` |
| `utils/accessControl, memberCommandPolicy, memberTelemetry` | `gateway/users/` |
| `utils/dashboardSync, adminApi` | `gateway/dashboard/` |
| `commands/{admin,general,media}/x.js` | `commands/x/index.js` (one folder each) |
| `commands/media/shortcuts.js` + `providerSearch` + `socialMedia` | `commands/social/` |
| `utils/paperSearch` / `xjxDramaBox` | private to `commands/paper`, `commands/dramabox` |
| `utils/youtubedl, ytInnertube, ytAuth, youtubeSearch, yt1d, knightYouTube` | `lib/youtube/` |
| `utils/mediaPipeline, downloadProviders, xjxMedia` | `lib/downloads/` |
| `utils/musicSources/`, `utils/ownMedia/` | `lib/music/`, `lib/ownmedia/` |
| `utils/movieEngine, movieHost`, `engine/` | `lib/movies/` (`.movie` and `.series` share a length check in `lib/movies/length.js` instead of importing each other) |
| other `utils/*`, `database.js` | `lib/` |

Behaviour is unchanged: the same 104 command names and aliases, the same data
files under `database/`. Removed: `utils/allowlistSync.js` (unused), the two
opt-in live probes and the python extractor test (not part of the offline suite).
Added: the guards, the registry (breaker, per-command on/off and reload) and
`scripts/test-structure.js`.

Known limits, stated plainly:

* Torrent downloads run in a **separate child process** with its own memory cap
  (`TORRENT_WORKER_MB`, default 384) and a hard kill (`TORRENT_HARD_TIMEOUT_MS`),
  so WebTorrent never loads into the bot. Everything else (yt-dlp, ffmpeg) is
  already an external process, but commands themselves run in the bot process
  because they need the live WhatsApp socket. Isolation for those is per-folder
  load, per-command error handling, a timeout (`timeoutMs`, default 30 min) and
  the breaker; a command that blocks the event loop synchronously can still
  stall the bot.
* The movie/series engine registers exactly these 12 providers: moviebox,
  vidlink, vidsrc, vaplayer (streams) and yts, torrentio, eztv, nyaa, knaben,
  solidtorrents, torrentscsv, apibay (torrents). The three DDL providers and the
  mirror pool they used were removed.
* `.tiktok` and the `.ytdl` admin tool still use the local yt-dlp pipeline, which
  tries several routes in order; that is the remaining place with a fallback chain.
* Data stays in `database/` (not per-command folders) so existing deployments
  keep their whitelist, paper snapshot and counters. It is backed up
  automatically (see below).
* Run `node scripts/check-live.js` (with `GRONKA_API_KEY` and optional
  `CHECK_YT_URL`, `CHECK_FB_URL`, `CHECK_IG_URL`) to see which sources work
  before users find out.
