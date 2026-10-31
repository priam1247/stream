# WhatsApp Service

A command-driven WhatsApp bot built on Baileys v7 with an integrated Past-Paper Vault, streaming media & movie/series downloader, 9 GB folder-quota disk guard, and a standalone Next.js 16 Control Room in the sibling `dashboard/` folder. **Each linked session responds only to prefixed commands sent by that same WhatsApp account (`fromMe`). Incoming messages, bare links and edited-message re-execution are ignored; there is no command cooldown.**

## Commands

```text
.movie <title> [year] [quality]        Download a movie (480/720/1080/2160) with title and quality selection
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
.dl <URL> [audio|video] [quality]      Generic yt-dlp downloader (streamed to disk)
.tiktok <URL>  .x <URL>  .pinterest <URL>  .instagram <URL>  .fb <URL>
.bilibili <title or URL>  .vimeo <title or URL>  .dailymotion <title or URL>
.reddit <title or URL>    .twitch <title or URL>  .rumble <title or URL>
.odysee <title or URL>    .weibo <title or URL>   .douyin <title or URL>
.acfun <title or URL>     .youku <title or URL>   .vk <title or URL>
.xiaohongshu <title or URL>  .niconico <title or URL>
.spotify <Spotify URL or artist - title>
.sticker (reply to media)              512x512 WebP sticker
.viewonce (reply to view-once media)   Unwrap view-once photo/video/audio (from the session owner)
.menu / .ping
```

Interactive title and quality choices use a tap selector or a prefixed numbered reply, such as `.1`, `.2` or `.cancel`. Poll votes and replies without the prefix are ignored.

### Video sites and YouTube troubleshooting

The 14 site commands accept a title as well as a direct link. For example:

```text
.youku the blood of youth s01e1
.1
.vimeo mountain video --audio
.bili a title 480p
.nico a title --first
```

Search shows numbered results even when `SEARCH_PICKER` is off; reply with a
prefixed number or `.cancel`. `--first` skips the list. For title searches use
`--audio`, `--video`, `--image`, a trailing quality such as `480p`, or
`--quality 480`; bare words such as `music` and `video` remain part of the
search title. Direct links still accept the older `audio` and `480` options.
`SEARCH_RESULTS` (1–10, default 5) and `SEARCH_TTL_MINUTES` apply to the list.

Bilibili, Youku, AcFun, Reddit, Rumble and Odysee first try public site search;
Dailymotion and Niconico first try yt-dlp's site search. All 14 can fall back to
DuckDuckGo and Brave Search with a site filter. These third parties receive the
search words. For an English Youku episode search with no native result, TVMaze
may receive the series name to find an exact matching original Chinese title;
that title is then searched on Youku. HTTP searches do not send the bot's saved
cookies or authorization to those services. yt-dlp's native searches use its
existing domain-scoped cookie and proxy settings. Results are checked against
the requested site's video/post URLs, but may be outdated, incomplete, unrelated
or not downloadable. A site's original language may work better; `S01E01` is
only a search hint, not an episode guarantee.
Search and downloads can fail because of rate limits, sign-in, location, deleted
videos, network blocks, DRM or site changes. Search is not a filter for explicit
material hosted on general-purpose sites.

Downloads still use the existing yt-dlp pipeline, not separate extractors;
`.bili`, `.daily`, `.xhs`, and `.nico` are aliases. `.dl` remains available for
other supported links. Use individual public video/post URLs; the bot does not
intentionally download whole playlists. Dashboard command switches apply to
individual commands, not whole websites: turning off `.bilibili` for members
does not stop `.dl` accepting a Bilibili URL.

For a YouTube access check, the owner can run `.ytdl update` and then
`.ytdl test <video link>`. The test checks metadata or URL resolution only; it is
not a successful media download. Try `.ytv <video link>` or `.song <video link>`
to check an actual download from the deployed host. The bot uses Node and the
installed or official yt-dlp EJS component where supported. A fresh export of
the owner's own Netscape `cookies.txt` may help: upload it privately to the host
and set `YOUTUBE_COOKIES_FILE`, or attach it to the owner-only `.cookies set`
command in a private chat. Cookies can expire, and even valid cookies cannot
guarantee that YouTube will accept a hosting IP. Treat the file as a password;
never commit it or send it to support or anyone else. Inline cookies take priority over
`.cookies set`, which takes priority over `YOUTUBE_COOKIES_FILE`. Check `.ytdl`
for the active source if a different file is being used. For export guidance see
the [yt-dlp FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp).

If local methods fail, the existing remote fallbacks may receive the video URL;
their availability is independent of the bot. TLS certificates are verified:
if verification fails, fix the host's clock or CA store instead of disabling
verification. Run `.ytdl` for the installed version and supported runtime flags.

## Background link jobs

Bare links are ignored; use a prefixed command such as `.dl <URL>`. Previously queued bare-link jobs in `database/jobs.sqlite` are preserved but no longer run or send replies automatically.

```text
INLINE_LIMIT=104857600     bytes that still go inline (100 MB)
MEDIA_DIR=temp             staging folder for downloads
RCLONE_REMOTE=gdrive       remote name from secrets/rclone.conf
RCLONE_PATH=bot/uploads    folder inside that remote
```

DRM-protected services are not supported.

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
npm run test:media     # offline YouTube, cookie, installer, and shortcut tests
npm run test:jobs      # offline background-job tests
npm run test:sessions  # offline pairing, permissions, and delivery tests
npm start
```

Run the selftests in a fresh checkout, not against an existing live bot's state;
some checks load modules that access the bot's runtime database directory.
Optionally run `npm run ytdlp:install` on a host that needs yt-dlp installed.
The entry point uses this folder as its working directory, including when it is
started from another directory. Do not commit or share `.env` or session files.

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

Session files are sensitive credentials. Recovery is optional and **does not**
guarantee WhatsApp will keep accepting a device. For Vercel, configure the portal's
Cloudflare D1 variables first and confirm the administrator status reports D1.
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
backup may still be stale; WhatsApp ultimately decides whether it can reconnect. A crash immediately
following a credential change or a failed/offline sync can leave the last snapshot
stale. The encrypted payload is limited to 1 MB; oversize sessions report failure.

For a move, stop the old instance only after a recent successful snapshot, and
start **one** updated instance with the same key and private sync token on the new
host. The service attempts recovery before creating fresh local sessions. Never
run two instances with the same WhatsApp sessions. Keep a separate secure local
backup and be prepared to relink if WhatsApp has revoked the device or recovery
fails. Legacy session manifests without an ownership claim bind once to the
current portal claim; their earlier ownership cannot be proven. No inbound Botkeep port is needed. The legacy XS SFTP workflow will not
upload on a push; manual use now requires explicit destination confirmation.

Members' command switches are controlled under **WhatsApp → Commands**. The
service enforces canonical commands, their aliases, and outstanding selections;
the owner can still test. A switch remains **awaiting service sync** until the
running bot acknowledges it. Already-running work is not forcibly cancelled.

## Disk Budget & Concurrency (10 GB Panel Plan)

Shared container panels often report the entire host node's free space via `statfs`. The service protects against `ENOSPC` crashes with two layers (`utils/diskSpace.js` + `utils/diskGuard.js`):

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
its own environment and pair again instead. Completed downloads awaiting delivery
are recorded with absolute paths. To resume those jobs after a move, preserve the
job database and their media files at the same absolute paths; otherwise request
the affected downloads again. Other temporary files need not be moved.

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
