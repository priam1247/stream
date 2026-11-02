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
.paper <course-code> [module] [year]   Search & send past papers (capped per query, 3-day dedupe)
.paper browse [letter|code] [page]     Paginated course/module directory
.countpapers [course-code]             Count papers in the vault
.song <name-or-YouTube-URL>            Send one artist-titled MP3 document via XJX resolvers
.video <name-or-YouTube-URL>           Download video with XJX's resolver flow (480p)
.mfind <name|music-link> [--video] [720]  Search catalogs, then deliver via external APIs
.embed <link> [--audio|--video] [720]  Resolve an embed/player link to its canonical URL
.mdiag [search phrase]                 Test the separate standalone downloader
.tiktok <URL>  .x <URL>  .instagram <URL>  .fb <URL>
.reddit <title>                        Search Reddit videos by title
.spotify <Spotify URL or artist - title>
.sticker (reply to media)              512x512 WebP sticker
.viewonce (reply to view-once media)   Unwrap view-once photo/video/audio (from the session owner)
.menu / .ping
```

Interactive title and quality choices use a tap selector or a prefixed numbered reply, such as `.1`, `.2` or `.cancel`. Poll votes and replies without the prefix are ignored.

`.dramabox <bookId> [episode]` follows XJX's DramaBox command: it calls the `/dramabox/stream` resolver with the book ID and episode (default `1`) and returns a stream link. It does not download the episode to the bot host.

### Video sites and YouTube

`.reddit` searches by title, shows numbered results, and accepts `--first`,
`--audio`, `--video`, a quality such as `480p`, or `--quality 480`. It uses
Reddit's public search and, if necessary, site-filtered web indexes. Search
results are discovery hints, not guaranteed downloads. The social shortcuts
also accept their site links; there is no generic `.dl` command.

`.song` and `.video` now use the same resolver sequence as XJX, with no local
YouTube downloader fallback. Search phrases use the first `yt-search` result;
URLs are passed to the same resolvers as in XJX. Audio tries XJX's `getIzumi`
URL resolver (KnightBot, ApisSupreme, then Apix), its `getEliteProTech`
Hector-URL resolver, then its Hector query resolver. Video calls XJX's
`getEliteProTechVideoByUrl` (KnightBot, then Keithsite) at 480p. Resolved HTTPS
URLs are sent directly through Baileys: `.song` sends exactly one MP3 document
with a cleaned artist–title filename and caption; it requests the configured
high-bitrate format (320 kbps by default, subject to what the source can
provide). `.video` falls back to a document if WhatsApp rejects the video
message. Neither command runs yt-dlp or ffmpeg locally. `.mdiag` diagnoses the
separate local media engine and does not test these providers. Download only
content you have permission to use.

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
| XJX APIs | audio/video URLs for a matching public YouTube upload | optional provider credentials |

`.mfind` resolves a pasted music-service link to `artist - title` and its
duration, then searches for a matching public YouTube upload. If no catalog
upload matches, it searches YouTube by title and artist. The resolved media is
sent from the external provider URL. Albums and playlists show the existing
numbered picker, capped at ten tracks. The `.song` and `.video` commands do not
resolve music-catalog links; they follow XJX's direct URL/search behavior.

The API-key settings (`XJX_KNIGHTBOT_API_KEY`, `XJX_APISSUPREME_API_KEY`,
`XJX_APIX_KEY`, or an existing `APIX_KEY`) belong in the private Botkeep
environment or `.env`; only use credentials you own. The ApisSupreme key is
also used by `.fb`. No API tokens from XJX's repository were copied. `.song`
sends only one document and asks KnightBot for the bitrate in
`XJX_SONG_AUDIO_FORMAT` (320 kbps by default); actual quality depends on the
provider and source. `.video` uses XJX's 480p default and does not accept a
quality argument. Provider availability remains external and can change
independently of this repository.

### Social media downloads

`.fb` uses XJX's ApisSupreme Facebook resolver and picks HD when available,
otherwise SD. `.instagram` / `.ig` uses the `ruhend-scraper` `igdl` resolver and
sends public post/reel items (up to ten carousel images/videos). These commands
no longer route through the generic yt-dlp → yt1d → Cobalt fallback chain.
Private/restricted posts may not resolve. The Facebook endpoint may require
`XJX_APISSUPREME_API_KEY`; configure only a key you own.

Streaming services are used for metadata only: nothing is downloaded from
them directly and **no DRM is circumvented**. The background download-job
router (`utils/providerRouter.js`) continues to reject DRM-protected music
hosts. `.spotify` remains a separate single-track command. Only download
content you have the rights to.

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

### Standalone media engine (`utils/ownMedia/`)

The local `utils/mediaPipeline.js` remains for site-specific and other
commands that explicitly use it. It delegates YouTube, YouTube Music,
YouTube-nocookie and SoundCloud URLs to `utils/ownMedia/`, built brick by
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
`.status` (alias `.update`), `.restart`, `.on`, `.off`, `.allow`, `.disallow`, `.listusers`, `.cookies`, `.ytlogin`, `.ytdl` (`status` | `update` | `repair` | `proxy` | `test`), and `.refreshpapers`.

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
server (`../scribd/`) are separate projects.

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

Shared container panels often report the entire host node's free space via `statfs`. The service protects against `ENOSPC` crashes with two layers (`utils/diskSpace.js` + `utils/diskGuard.js`):

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
