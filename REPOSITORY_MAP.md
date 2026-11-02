# Complete repository map

This map covers **367 repository files** in the current single-Botkeep snapshot. The detailed [file and connection index](docs/REPOSITORY_FILE_INDEX.md) gives each file's role, local references, reverse references, and literal outside-module imports.

## Contents

1. [Big picture](#big-picture)
2. [WhatsApp service](#whatsapp-service)
3. [Dashboard](#dashboard)
4. [Scribd service](#scribd-service)
5. [Automation, tests, and deployment](#automation-tests-and-deployment)
6. [State and secrets outside Git](#state-and-secrets-outside-git)
7. [Complete dashboard API route list](#complete-dashboard-api-route-list)
8. [Complete file tree](#complete-file-tree)
9. [Per-file reference index](docs/REPOSITORY_FILE_INDEX.md)

**Scope and honesty:** the tree covers every Git-tracked repository file, not installed packages, generated build output, host-only files, user data, or remote databases. Arrows in the diagrams distinguish in-process calls, dynamic/generated relationships, and HTTP links; a static scan cannot prove every computed import or remote action. See the index labels rather than treating every mention as a guaranteed runtime call.

## Big picture

```text
                     ┌──────────────────────────────────────────┐
                     │ User's browser                           │
                     └──────────────────┬───────────────────────┘
                                        │ HTTPS
                                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ dashboard/  — Next.js application                                      │
│ app pages → React components → /api/* route handlers → lib/*           │
│ Auth + roles       │ owner/member screens │ Scribd adapter             │
└─────────┬──────────┴──────────────┬───────┴──────────────┬─────────────┘
          │                        │                        │
          │ storage API            │ bot sync / optional    │ HTTPS to
          ▼                        │ direct bot admin API   │ Scribd proxy
 Cloudflare D1                    ↕                        ▼
 (or local disk where      ┌───────────────────┐  ┌────────────────────────┐
  supported)               │ Whatsapp bot/     │  │ scribd/scribd_web.py   │
                           │ Node + Baileys     │  │ HTTP UI, search, queue │
                           │ sessions/commands  │  │ → converter subprocess │
                           │ media engine       │  └───────────┬────────────┘
                           └─────────┬─────────┘              │
                                     │                        ▼
                              WhatsApp and             Scribd / browser /
                              media providers          PDF files / Drime*

* Drime, the bot direct admin API, and the Discord front end are optional.
  The dashboard, WhatsApp service, and Scribd service are separate processes;
  starting or deploying one does not automatically start or update the others.
```

- **Browser ↔ dashboard:** pages and components call same-origin Next.js routes. Permissions are enforced in route handlers and shared guards, not by hiding a button alone.
- **Bot → dashboard:** the bot posts heartbeats, results, and encrypted session-backup operations to dashboard routes. The response carries queued actions and access/policy state. The optional reverse direction uses the bot's admin HTTP API, if enabled/configured.
- **Dashboard → Scribd:** only the server-side dashboard adapter contacts the Scribd web service. The configured HTTPS proxy is in `dashboard/lib/scribd-config.ts`; the existing token is read server-side, not sent to the browser. The proxy may forward to its origin over HTTP, so HTTPS to the proxy is not proof of encrypted origin traffic.
- **Remote integrations:** WhatsApp/Baileys, Cloudflare D1, SMTP, the hosting panel, Scribd/CloakBrowser, optional Drime and Discord, and media and metadata providers are outside this repository.

## WhatsApp service

```text
Whatsapp bot/package.json (npm start) or Procfile
    └─→ index.js
        ├─→ config.js + temp/disk/logging helpers
        ├─→ sessionBackup.js: restore eligible encrypted backups first
        ├─→ sessionManager.js: create/manage each Baileys socket
        │    └─→ handler.js → database.js + commandLoader.js
        │         └─dynamic directory scan→ commands/{admin,general,media}/*.js
        └─→ serviceStartup.js → dashboardSync.js / optional adminApi.js

A movie/series command → utils/movieEngine.js → dynamic import of
engine/media/index.js → metadata, registry, resolver, providers, downloaders
                              ↕
                     engine/host.js → utils/movieHost.js → bot media helpers
```

`handler.js` accepts the linked account's own prefixed messages, scopes selections and delivery to the originating session, and checks owner/member command policy. `sessionManager.js` owns account lifecycle; `sessionBackup.js` handles encrypted backup and restore; `dashboardSync.js` exchanges heartbeats, policy, and queued work with the dashboard. `jobQueue.js` starts requested work concurrently with resource safeguards. `persistentJobs.js` and `jobDelivery.js` recover previously saved jobs and scope delivery to the originating account.

The bot is CommonJS. The nested `engine/package.json` switches that subtree to ES modules; the bridge uses dynamic `import()`. The engine entry point statically registers its selected stream and torrent providers. The three files in `engine/providers/ddl/` register themselves if loaded, but are not imported by the current `engine/media/index.js`; their presence alone does not mean they are active.

Media shortcuts and `.dl` use `utils/mediaPipeline.js` → the keyless YouTube provider where applicable, installed local engines, and remote fallbacks. `.reddit` searches titles through `utils/providerSearch.js` using Reddit or site-filtered indexes, then `utils/selections.js` presents session-scoped choices. Searches start immediately through `utils/jobQueue.js`; direct links remain available through `.dl`. Search results are discovery hints, not verified downloads. `dashboard/lib/bot-data.ts` catalogs canonical commands; member switches apply to commands, not website-wide blocking.

## Dashboard

```text
Next.js app/layout.tsx + globals.css
  ├─ /             app/page.tsx             → sign-in / role redirect
  ├─ /login        app/login/page.tsx       → auth-screen.tsx
  ├─ /admin        app/admin/page.tsx       → admin-console.tsx
  ├─ /dashboard    app/dashboard/page.tsx   → member-portal.tsx
  └─ /support      app/support/page.tsx     → support-desk.tsx

components/* → app/api/<route>/route.ts → lib/* → storage / remote service
```

`lib/auth-engine.ts`, `jwt.ts`, and the `app/api/auth/` routes handle authentication. The client session is held in memory (`client-session.ts`), so a full refresh needs a new sign-in. Owners manage member approval, linked numbers, command availability, support, and Scribd permissions through the relevant API routes. The link flow is **link first, then owner approval** for new members; existing access is preserved by the migration logic.

`lib/storage.ts` connects those features to Cloudflare D1 or the supported local store. Production support and encrypted recovery require durable D1; a successful local test does not prove the deployed D1 setup. The browser's Scribd screen (`components/scribd-desk.tsx`) reaches `app/api/scribd/*`, which applies `scribd-guard.ts` and uses `scribd-panel.ts`; downloads use scoped short-lived tickets. Owners can manage the shared queue; granted, unblocked members get the permitted read/download routes.

### Example: link a member's WhatsApp account

```text
member-connection.tsx → /api/member/numbers → storage.ts (pending claim)
                      → /api/member/pair → bot-proxy.ts
                                              ├─ fresh heartbeat: queue → /api/bot/sync
                                              │                              ↕
                                              │                    dashboardSync.js
                                              │                       → sessionManager.js
                                              │                       → pairing code / socket
                                              └─ otherwise: direct admin API, if configured

linked account → /api/admin/approvals → verify current claim and live status
                                     → storage.ts → next bot sync → command access
```

New pending members may link but cannot use commands before approval. Approval checks that the linked account still matches its claim. Direct and outbound-sync connections are alternatives, so not every deployment takes both paths.

### Example: encrypted session recovery

```text
bot/index.js → sessionBackup.js → signed /api/bot/session-backups
                                   → bot-sync-auth.ts + storage.ts
                                   → D1 portal_session_backups (ciphertext)
```

The bot encrypts eligible snapshots and retains the recovery key outside the dashboard. Restore occurs before session-manager startup. Eligibility, revisions, claims, and revocation are checked; this diagram is an implementation map, not a guarantee that any particular live deployment has a usable backup.

### Dashboard storage tables

`storage.ts` creates/uses D1 tables for `portal_accounts`, `portal_whatsapp_access`, `portal_member_permissions`, `portal_member_features`, `portal_activity`, `portal_settings`, `portal_bot_commands`, `portal_pair_cooldowns`, `portal_support_messages`, `portal_support_reads`, and `portal_session_backups`. In supported local operation it also uses `dashboard/.data/zafar-db.json`; that runtime file is not tracked.

## Scribd service

```text
Panel: run.py ──selected mode──→ scribd_web.py / discord_bot.py / scribd_all.py
Shell: start.sh ─selected mode→ scribd_web.py / discord_bot.py / scribd_all.py

scribd_web.py
  ├─ embedded browser UI + /health + /api/* + /files/*
  ├─ search + thumbnail retrieval through browser/HTTP helpers
  └─ job worker ─subprocess→ scribd_all.py (fallback: scribd_shot.py)
                                  ├─ Chromium/CloakBrowser + Scribd
                                  ├─ capture / audit / PDF assembly → output/
                                  └─ optional drime.py → Drime cloud

make_bundle.py reads scribd_shot.py + scribd_pdf.py + chromium_launch.py
                  + envfile.py + drime.py + logfmt.py
               └─generates→ scribd_all.py

uploads/main.py → uploads/{cookies,extract,token,download,build_pdf}.py
                  (separate image-based CLI; not the web queue's default tool)
```

`scribd_web.py` prefers the generated `scribd_all.py` when present and otherwise falls back to `scribd_shot.py`. Edit the source/helper files and regenerate the bundle rather than treating the generated bundle as an independent source. The default `auto` capture mode uses the live reader sequentially; fragment reconstruction is a separately selected mode. The optional Discord front end can start the web service and invoke the converter; it is not the WhatsApp bot.

The previously diagnosed page-audit logger crash is still present in this snapshot: the audit calls `Log.info`, but that class does not supply it. HTTPS does not repair this converter bug. The mixed-size warning alone does not establish whether the original document, viewport, or capture caused the dimensions.

## Automation, tests, and deployment

- `.github/workflows/ci.yml` runs bot and dashboard tests, typecheck, and build. It performs validation only: it does not upload files or restart a service. Botkeep deployment is separately managed by the owner.
- `Whatsapp bot/scripts/` contains offline tests plus a separate live N_m3u8DL-RE smoke test. Media tests mock network and media, and the extractor test checks URL recognition only; they do not verify live provider downloads. `dashboard/tests/` is discovered by `vitest.config.ts`; the contract fixture starts the real Scribd HTTP handler locally with external operations stubbed. `scribd/test_*.py` covers Python tools separately.
- `dashboard/package.json` and `Whatsapp bot/package.json` are independent npm projects with separate lockfiles. `scribd/requirements.txt`, optional MuPDF/Discord requirements, and `scribd/uploads/requirements.txt` define separate Python dependency sets.
- A GitHub Actions pass or public `/health` response is not proof that a production bot session, private token, full PDF conversion, or live D1 recovery works.

## State and secrets outside Git

The inventory deliberately excludes ignored/generated items: `node_modules/`, `.next/`, Python caches and browser binaries, bot `session/` and `database/`, temporary downloads and queues, local `.env`/cookies, Scribd `.webtoken`, and Scribd `output/`. D1 and external cloud storage are not repository files. These may be required to run or restore a deployment; do not commit or publish credentials. Check the relevant `.gitignore`, project README, and hosting configuration before backing up, cleaning, or moving state.

## Complete dashboard API route list

Next.js discovers each endpoint from its `app/api/.../route.ts` path. Methods below come from exported handlers; authorization and behavior are implemented in the linked files.

| URL | Methods | Source |
|---|---|---|
| `/api/admin/activity` | GET | [`admin/activity/route.ts`](dashboard/app/api/admin/activity/route.ts) |
| `/api/admin/approvals` | POST | [`admin/approvals/route.ts`](dashboard/app/api/admin/approvals/route.ts) |
| `/api/admin/commands` | GET, PATCH | [`admin/commands/route.ts`](dashboard/app/api/admin/commands/route.ts) |
| `/api/admin/members` | POST, PATCH | [`admin/members/route.ts`](dashboard/app/api/admin/members/route.ts) |
| `/api/admin/members/scribd` | PATCH | [`admin/members/scribd/route.ts`](dashboard/app/api/admin/members/scribd/route.ts) |
| `/api/admin/pair` | GET, POST | [`admin/pair/route.ts`](dashboard/app/api/admin/pair/route.ts) |
| `/api/admin/panel` | POST | [`admin/panel/route.ts`](dashboard/app/api/admin/panel/route.ts) |
| `/api/admin/panel/status` | GET | [`admin/panel/status/route.ts`](dashboard/app/api/admin/panel/status/route.ts) |
| `/api/admin/settings` | POST | [`admin/settings/route.ts`](dashboard/app/api/admin/settings/route.ts) |
| `/api/admin/status` | GET | [`admin/status/route.ts`](dashboard/app/api/admin/status/route.ts) |
| `/api/admin/users` | POST | [`admin/users/route.ts`](dashboard/app/api/admin/users/route.ts) |
| `/api/admin/users/[number]` | PATCH, DELETE | [`admin/users/[number]/route.ts`](dashboard/app/api/admin/users/%5Bnumber%5D/route.ts) |
| `/api/admin/users/[number]/sync` | POST | [`admin/users/[number]/sync/route.ts`](dashboard/app/api/admin/users/%5Bnumber%5D/sync/route.ts) |
| `/api/auth/forgot-password` | POST | [`auth/forgot-password/route.ts`](dashboard/app/api/auth/forgot-password/route.ts) |
| `/api/auth/login` | POST | [`auth/login/route.ts`](dashboard/app/api/auth/login/route.ts) |
| `/api/auth/logout` | POST | [`auth/logout/route.ts`](dashboard/app/api/auth/logout/route.ts) |
| `/api/auth/me` | GET, PATCH | [`auth/me/route.ts`](dashboard/app/api/auth/me/route.ts) |
| `/api/auth/register` | POST | [`auth/register/route.ts`](dashboard/app/api/auth/register/route.ts) |
| `/api/auth/resend` | POST | [`auth/resend/route.ts`](dashboard/app/api/auth/resend/route.ts) |
| `/api/auth/reset-password` | POST | [`auth/reset-password/route.ts`](dashboard/app/api/auth/reset-password/route.ts) |
| `/api/auth/verify` | POST | [`auth/verify/route.ts`](dashboard/app/api/auth/verify/route.ts) |
| `/api/bot/session-backups` | POST | [`bot/session-backups/route.ts`](dashboard/app/api/bot/session-backups/route.ts) |
| `/api/bot/sync` | POST | [`bot/sync/route.ts`](dashboard/app/api/bot/sync/route.ts) |
| `/api/bot/whitelist` | GET | [`bot/whitelist/route.ts`](dashboard/app/api/bot/whitelist/route.ts) |
| `/api/member/cancel-pending` | POST | [`member/cancel-pending/route.ts`](dashboard/app/api/member/cancel-pending/route.ts) |
| `/api/member/numbers` | POST | [`member/numbers/route.ts`](dashboard/app/api/member/numbers/route.ts) |
| `/api/member/numbers/[number]` | PATCH, DELETE | [`member/numbers/[number]/route.ts`](dashboard/app/api/member/numbers/%5Bnumber%5D/route.ts) |
| `/api/member/pair` | GET, POST | [`member/pair/route.ts`](dashboard/app/api/member/pair/route.ts) |
| `/api/member/status` | GET | [`member/status/route.ts`](dashboard/app/api/member/status/route.ts) |
| `/api/member/unlink` | POST, GET | [`member/unlink/route.ts`](dashboard/app/api/member/unlink/route.ts) |
| `/api/scribd/clear` | POST | [`scribd/clear/route.ts`](dashboard/app/api/scribd/clear/route.ts) |
| `/api/scribd/config` | GET, PATCH | [`scribd/config/route.ts`](dashboard/app/api/scribd/config/route.ts) |
| `/api/scribd/file` | GET | [`scribd/file/route.ts`](dashboard/app/api/scribd/file/route.ts) |
| `/api/scribd/file-ticket` | POST | [`scribd/file-ticket/route.ts`](dashboard/app/api/scribd/file-ticket/route.ts) |
| `/api/scribd/files` | GET | [`scribd/files/route.ts`](dashboard/app/api/scribd/files/route.ts) |
| `/api/scribd/find` | POST | [`scribd/find/route.ts`](dashboard/app/api/scribd/find/route.ts) |
| `/api/scribd/link` | GET | [`scribd/link/route.ts`](dashboard/app/api/scribd/link/route.ts) |
| `/api/scribd/reset` | POST | [`scribd/reset/route.ts`](dashboard/app/api/scribd/reset/route.ts) |
| `/api/scribd/run` | POST | [`scribd/run/route.ts`](dashboard/app/api/scribd/run/route.ts) |
| `/api/scribd/status` | GET | [`scribd/status/route.ts`](dashboard/app/api/scribd/status/route.ts) |
| `/api/scribd/thumb` | GET | [`scribd/thumb/route.ts`](dashboard/app/api/scribd/thumb/route.ts) |
| `/api/support` | GET, POST | [`support/route.ts`](dashboard/app/api/support/route.ts) |

### Other services' HTTP endpoints

These routes run in separate processes; they are **not** Next.js routes.

| Service / source | Method and path | Purpose |
|---|---|---|
| `scribd/scribd_web.py` | GET `/health` | Public health check. |
| Scribd web | GET `/`, `/index.html` | Embedded web UI; protected when a service token is enabled. |
| Scribd web | GET `/api/search`, `/api/thumb`, `/api/job` | Search, cover, and queue status. |
| Scribd web | GET `/api/zip`, `/files/<name>` | Download finished files. |
| Scribd web | POST `/api/download`, `/api/clear`, `/api/cancel` | Submit, clear, or cancel shared jobs. |
| `Whatsapp bot/utils/adminApi.js` | GET `/health`, `/ping` | Public health checks on the optional API. |
| Bot admin API | GET `/admin/api/status`, `/admin/api/users`, `/admin/api/whitelist` | Read status and allowlist. |
| Bot admin API | POST `/admin/api/users`, `/admin/api/pair`, `/admin/api/unlink` | Manage a number, pair, or unlink. |
| Bot admin API | PATCH or DELETE `/admin/api/users/<number>` | Change or remove a number. |

The optional bot admin API also accepts the equivalent `/api/...` paths and handles CORS `OPTIONS`. All of its non-health operations require authentication. The Scribd service protects its non-health endpoints when its token is enabled.

## Complete file tree

Each leaf is one Git-tracked file in this snapshot, including the two map documents. Open the [file and connection index](docs/REPOSITORY_FILE_INDEX.md) for what every leaf does and how it references or is referenced by other files.

```text
.
├── .github/
│   ├── tests/
│   │   └── repository-safety.test.cjs
│   └── workflows/
│       └── ci.yml
├── dashboard/
│   ├── app/
│   │   ├── admin/
│   │   │   └── page.tsx
│   │   ├── api/
│   │   │   ├── admin/
│   │   │   │   ├── activity/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── approvals/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── commands/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── members/
│   │   │   │   │   ├── scribd/
│   │   │   │   │   │   └── route.ts
│   │   │   │   │   └── route.ts
│   │   │   │   ├── pair/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── panel/
│   │   │   │   │   ├── status/
│   │   │   │   │   │   └── route.ts
│   │   │   │   │   └── route.ts
│   │   │   │   ├── settings/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── status/
│   │   │   │   │   └── route.ts
│   │   │   │   └── users/
│   │   │   │       ├── [number]/
│   │   │   │       │   ├── sync/
│   │   │   │       │   │   └── route.ts
│   │   │   │       │   └── route.ts
│   │   │   │       └── route.ts
│   │   │   ├── auth/
│   │   │   │   ├── forgot-password/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── login/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── logout/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── me/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── register/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── resend/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── reset-password/
│   │   │   │   │   └── route.ts
│   │   │   │   └── verify/
│   │   │   │       └── route.ts
│   │   │   ├── bot/
│   │   │   │   ├── session-backups/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── sync/
│   │   │   │   │   └── route.ts
│   │   │   │   └── whitelist/
│   │   │   │       └── route.ts
│   │   │   ├── member/
│   │   │   │   ├── cancel-pending/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── numbers/
│   │   │   │   │   ├── [number]/
│   │   │   │   │   │   └── route.ts
│   │   │   │   │   └── route.ts
│   │   │   │   ├── pair/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── status/
│   │   │   │   │   └── route.ts
│   │   │   │   └── unlink/
│   │   │   │       └── route.ts
│   │   │   ├── scribd/
│   │   │   │   ├── clear/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── config/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── file/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── file-ticket/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── files/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── find/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── link/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── reset/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── run/
│   │   │   │   │   └── route.ts
│   │   │   │   ├── status/
│   │   │   │   │   └── route.ts
│   │   │   │   └── thumb/
│   │   │   │       └── route.ts
│   │   │   └── support/
│   │   │       └── route.ts
│   │   ├── dashboard/
│   │   │   └── page.tsx
│   │   ├── login/
│   │   │   └── page.tsx
│   │   ├── support/
│   │   │   └── page.tsx
│   │   ├── globals.css
│   │   ├── icon.tsx
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/
│   │   ├── account-modal.tsx
│   │   ├── admin-console.tsx
│   │   ├── auth-screen.tsx
│   │   ├── command-directory.tsx
│   │   ├── control-room-activity.tsx
│   │   ├── control-room-home.tsx
│   │   ├── live-analytics.tsx
│   │   ├── media-vault-desk.tsx
│   │   ├── member-command-controls.tsx
│   │   ├── member-connection.tsx
│   │   ├── member-home.tsx
│   │   ├── member-portal.tsx
│   │   ├── member-workspace.tsx
│   │   ├── pairing-code-banner.tsx
│   │   ├── scribd-desk.tsx
│   │   ├── section-nav.tsx
│   │   ├── support-desk.tsx
│   │   ├── use-room-alert-reads.ts
│   │   ├── workspace-shell.tsx
│   │   └── zafar-robot.tsx
│   ├── lib/
│   │   ├── activity.ts
│   │   ├── auth-engine.ts
│   │   ├── bot-data.ts
│   │   ├── bot-proxy.ts
│   │   ├── bot-sync-auth.ts
│   │   ├── botkeep-config.ts
│   │   ├── client-session.ts
│   │   ├── control-room.ts
│   │   ├── email-service.ts
│   │   ├── jwt.ts
│   │   ├── member-analytics.ts
│   │   ├── member-insights-server.ts
│   │   ├── member-link.ts
│   │   ├── panel-client.ts
│   │   ├── rate-limit.ts
│   │   ├── room-alert-reads.ts
│   │   ├── scribd-config.ts
│   │   ├── scribd-download-ticket.ts
│   │   ├── scribd-guard.ts
│   │   ├── scribd-job.ts
│   │   ├── scribd-panel.ts
│   │   ├── scribd-search.ts
│   │   ├── scribd-types.ts
│   │   ├── storage.ts
│   │   ├── sync-status.ts
│   │   ├── types.ts
│   │   └── whatsapp-accounts.ts
│   ├── scripts/
│   │   └── check-prod-env.mjs
│   ├── tests/
│   │   ├── fixtures/
│   │   │   └── scribd_web_contract.py
│   │   ├── admin-console.test.tsx
│   │   ├── admin-route-authorization.test.ts
│   │   ├── auth-screen.test.tsx
│   │   ├── auth-security.test.ts
│   │   ├── bot-settings-route.test.ts
│   │   ├── bot-sync-auth.test.ts
│   │   ├── bot-sync-route.test.ts
│   │   ├── client-session.test.ts
│   │   ├── control-room-alerts.test.ts
│   │   ├── control-room-security.test.ts
│   │   ├── control-room-storage.test.ts
│   │   ├── d1-initialization.test.ts
│   │   ├── email-branding.test.ts
│   │   ├── member-cancel-pending.test.ts
│   │   ├── member-command-controls.test.tsx
│   │   ├── member-features-security.test.ts
│   │   ├── member-home.test.tsx
│   │   ├── member-insights.test.ts
│   │   ├── member-link-api.test.ts
│   │   ├── member-link-storage-local.test.ts
│   │   ├── member-onboarding-e2e.test.ts
│   │   ├── member-portal.test.tsx
│   │   ├── member-scribd-navigation.test.tsx
│   │   ├── pairing-code-banner.test.tsx
│   │   ├── pairing-security.test.ts
│   │   ├── panel-client.test.ts
│   │   ├── panel-route.test.ts
│   │   ├── panel-status.test.ts
│   │   ├── room-alert-reads.test.ts
│   │   ├── scribd-config.test.ts
│   │   ├── scribd-desk.test.tsx
│   │   ├── scribd-download-ticket.test.ts
│   │   ├── scribd-panel.test.ts
│   │   ├── scribd-search.test.ts
│   │   ├── scribd-web-contract.test.ts
│   │   ├── session-backup-api.test.ts
│   │   ├── session-backup-sqlite.test.ts
│   │   ├── single-host-e2e.test.ts
│   │   ├── single-host-storage.test.ts
│   │   ├── storage-outage.test.ts
│   │   ├── support-desk.test.tsx
│   │   ├── sync-status.test.ts
│   │   ├── whatsapp-bridge.test.ts
│   │   ├── whatsapp-status-privacy.test.ts
│   │   ├── workspace-shell.test.tsx
│   │   └── zafar-robot.test.tsx
│   ├── .env.example
│   ├── instrumentation.ts
│   ├── next.config.mjs
│   ├── package-lock.json
│   ├── package.json
│   ├── postcss.config.mjs
│   ├── README.md
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   └── vitest.config.ts
├── docs/
│   └── REPOSITORY_FILE_INDEX.md
├── scribd/
│   ├── uploads/
│   │   ├── build_pdf.py
│   │   ├── cookies.py
│   │   ├── download.py
│   │   ├── extract.py
│   │   ├── image-1.png
│   │   ├── image-2.png
│   │   ├── image-3.png
│   │   ├── image-4.png
│   │   ├── image-5.png
│   │   ├── image-6.png
│   │   ├── image-7.png
│   │   ├── main.py
│   │   ├── requirements.txt
│   │   ├── ruff.toml
│   │   └── token.py
│   ├── .env.example
│   ├── .gitignore
│   ├── bootstrap.sh
│   ├── bot-requirements.txt
│   ├── chromium_launch.py
│   ├── chromium_setup.py
│   ├── clean.sh
│   ├── discord_bot.py
│   ├── drime.py
│   ├── envfile.py
│   ├── logfmt.py
│   ├── make_bundle.py
│   ├── panel_setup.sh
│   ├── README.md
│   ├── requirements-mupdf.txt
│   ├── requirements.txt
│   ├── run.py
│   ├── scribd_all.py
│   ├── scribd_job.sh
│   ├── scribd_pdf.py
│   ├── scribd_shot.py
│   ├── scribd_web.py
│   ├── start.sh
│   ├── test_chromium.py
│   ├── test_discord_bot.py
│   ├── test_drime.py
│   ├── test_logfmt.py
│   ├── test_render_policy.py
│   ├── test_run.py
│   ├── test_scribd_pdf.py
│   ├── test_scribd_shot.py
│   ├── test_scribd_web.py
│   └── web-ui.png
├── Whatsapp bot/
│   ├── commands/
│   │   ├── admin/
│   │   │   ├── botmanage.js
│   │   │   ├── cookies.js
│   │   │   ├── toggle.js
│   │   │   ├── users.js
│   │   │   ├── ytdl.js
│   │   │   └── ytlogin.js
│   │   ├── general/
│   │   │   ├── debrid.js
│   │   │   ├── info.js
│   │   │   ├── menu.js
│   │   │   ├── paper.js
│   │   │   ├── ping.js
│   │   │   ├── providers.js
│   │   │   ├── sticker.js
│   │   │   └── viewonce.js
│   │   └── media/
│   │       ├── dl.js
│   │       ├── movie.js
│   │       ├── series.js
│   │       ├── shortcuts.js
│   │       ├── song.js
│   │       ├── spotify.js
│   │       └── ytv.js
│   ├── engine/
│   │   ├── core/
│   │   │   ├── cache.js
│   │   │   ├── events.js
│   │   │   ├── extract.js
│   │   │   ├── http.js
│   │   │   ├── jar.js
│   │   │   ├── log.js
│   │   │   ├── metrics.js
│   │   │   ├── mirrors.js
│   │   │   ├── queue.js
│   │   │   ├── ranker.js
│   │   │   ├── registry.js
│   │   │   ├── release.js
│   │   │   ├── reliability.js
│   │   │   ├── resolver.js
│   │   │   ├── tv.js
│   │   │   └── verify.js
│   │   ├── media/
│   │   │   ├── download.js
│   │   │   ├── downloader.js
│   │   │   ├── hls.js
│   │   │   ├── index.js
│   │   │   └── torrent.js
│   │   ├── metadata/
│   │   │   ├── anilist.js
│   │   │   ├── cinemeta.js
│   │   │   ├── imdb.js
│   │   │   ├── index.js
│   │   │   ├── jikan.js
│   │   │   ├── omdb.js
│   │   │   ├── tmdb.js
│   │   │   ├── trakt.js
│   │   │   └── tvmaze.js
│   │   ├── providers/
│   │   │   ├── ddl/
│   │   │   │   ├── fourkhdhub.js
│   │   │   │   ├── hdhub4u.js
│   │   │   │   └── moviesdrive.js
│   │   │   ├── stream/
│   │   │   │   ├── moviebox.js
│   │   │   │   ├── vaplayer.js
│   │   │   │   ├── vidlink.js
│   │   │   │   └── vidsrc.js
│   │   │   └── torrent/
│   │   │       ├── _trackers.js
│   │   │       ├── apibay.js
│   │   │       ├── eztv.js
│   │   │       ├── knaben.js
│   │   │       ├── nyaa.js
│   │   │       ├── solidtorrents.js
│   │   │       ├── torrentio.js
│   │   │       ├── torrentscsv.js
│   │   │       └── yts.js
│   │   ├── utils/
│   │   │   ├── disk.js
│   │   │   ├── format.js
│   │   │   └── httpBody.js
│   │   ├── config.js
│   │   ├── host.js
│   │   └── package.json
│   ├── scripts/
│   │   ├── install-ytdlp.sh
│   │   ├── selftest.js
│   │   ├── test-account-routing.js
│   │   ├── test-approval-readiness.js
│   │   ├── test-bridge.js
│   │   ├── test-command-removal.js
│   │   ├── test-delivery.js
│   │   ├── test-knight-live.js
│   │   ├── test-knight-provider.js
│   │   ├── test-media-downloads.js
│   │   ├── test-media-extractors.py
│   │   ├── test-media-shortcuts.js
│   │   ├── test-member-telemetry.js
│   │   ├── test-nm3u8dl-live.js
│   │   ├── test-preflight.js
│   │   ├── test-provider-core.js
│   │   ├── test-provider-search-handler.js
│   │   ├── test-provider-search.js
│   │   ├── test-public-media.js
│   │   ├── test-readiness.js
│   │   ├── test-sandbox.js
│   │   ├── test-service-startup.js
│   │   ├── test-session-backup.js
│   │   └── test-sessions.js
│   ├── utils/
│   │   ├── accessControl.js
│   │   ├── accountSockets.js
│   │   ├── adminApi.js
│   │   ├── allowlistSync.js
│   │   ├── api.js
│   │   ├── cleanup.js
│   │   ├── commandLoader.js
│   │   ├── converter.js
│   │   ├── dashboardSync.js
│   │   ├── diskGuard.js
│   │   ├── diskSpace.js
│   │   ├── downloadProviders.js
│   │   ├── ffmpeg.js
│   │   ├── hotReload.js
│   │   ├── jid.js
│   │   ├── jobDelivery.js
│   │   ├── jobQueue.js
│   │   ├── jsonStore.js
│   │   ├── knightYouTube.js
│   │   ├── logger.js
│   │   ├── mediaPipeline.js
│   │   ├── mediaSettings.js
│   │   ├── mediaTransfer.js
│   │   ├── memberCommandPolicy.js
│   │   ├── memberTelemetry.js
│   │   ├── movieEngine.js
│   │   ├── movieHost.js
│   │   ├── nm3u8dl.js
│   │   ├── paperSearch.js
│   │   ├── persistentJobs.js
│   │   ├── providerRouter.js
│   │   ├── providerSearch.js
│   │   ├── publicHttp.js
│   │   ├── publicMediaDownload.js
│   │   ├── rcloneStore.js
│   │   ├── reconnect.js
│   │   ├── safeLog.js
│   │   ├── selections.js
│   │   ├── serviceStartup.js
│   │   ├── sessionBackup.js
│   │   ├── sessionManager.js
│   │   ├── spotify.js
│   │   ├── telemetry.js
│   │   ├── tempManager.js
│   │   ├── userErrors.js
│   │   ├── youtubedl.js
│   │   ├── youtubeSearch.js
│   │   ├── yt1d.js
│   │   ├── ytAuth.js
│   │   └── ytInnertube.js
│   ├── .env.example
│   ├── .gitignore
│   ├── .npmrc
│   ├── config.js
│   ├── database.js
│   ├── handler.js
│   ├── index.js
│   ├── package-lock.json
│   ├── package.json
│   ├── Procfile
│   └── README.md
├── .gitignore
├── README.md
└── REPOSITORY_MAP.md
```
