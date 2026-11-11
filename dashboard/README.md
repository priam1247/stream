# ZaFar Control Room (Web Portal)

Standalone Next.js 16 application for member sign-in, WhatsApp number self-service, and the administrator console (`/admin`). The Botkeep service synchronizes outbound over HTTPS; an optional direct bridge can be configured separately. Secrets stay server-side.

## Deploying on Vercel (or Self-Hosted Node)

The WhatsApp bot lives in `the bot/` at the repository root (`cd "the bot" && npm start`). This portal is separate and has its own `dashboard/package.json` and `dashboard/package-lock.json`:

1. **Vercel → Project → Settings → General → Root Directory** → set to `dashboard` and click **Save**.
2. Keep the framework preset on **Next.js** (`npm install` / `npm run build`).
3. Configure the environment variables below, then **Deploy**.

Self-hosting with `npm start` enforces `JWT_SECRET_KEY` (minimum 16 characters) before `next start` binds a port, and `instrumentation.ts` + `lib/jwt.ts` enforce the same check on serverless/edge cold starts.

## Environment Variables

| Variable | Required? | Purpose |
|---|---|---|
| `JWT_SECRET_KEY` | **Required in production** | Signs HS256 session tokens (min 16 chars; generate via `openssl rand -hex 32`). Production startup refuses to run without it. |
| `ADMIN_EMAIL` | Recommended | Comma-separated administrator email(s) allowed into `/admin` (default: `troykunsauka@gmail.com`). |
| `ADMIN_INITIAL_PASSWORD` | Optional | Bootstraps the verified `ADMIN_EMAIL` account in D1 on first sign-in before email delivery is configured. |
| `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID` / `CLOUDFLARE_API_TOKEN` | Required for durable serverless state | Cloudflare D1 stores accounts, permissions, numbers, bot settings, activity, support messages, and encrypted session backups. Without D1 the portal uses `.data/zafar-db.json` on local disk, which must be writable and may be ephemeral or inconsistent across serverless instances. |
| `RESEND_API_KEY` + `EMAIL_FROM` | Pick Resend **or** SMTP | Sends 6-digit verification & password-reset codes over HTTPS (works cleanly on serverless/edge hosts). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Pick Resend **or** SMTP | Direct SMTP mail delivery (e.g. Gmail App Password on port `587` or `465`). |
| `ZAFAR_AUTH_API_URL` | Optional (legacy migration only) | Leave empty. If set during migration from an older external auth service, existing accounts are verified once (6 s cap) and migrated permanently into local D1. |
| `BOT_SYNC_TOKEN` | Recommended | Shared private token for the bot’s outbound sync. |
| `BOTKEEP_BOT_API_URL` / `BOTKEEP_BOT_ADMIN_TOKEN` | Optional | Direct bot bridge defaults. `BOTKEEP_BOT_API_URL` defaults to the service reverse proxy `https://troy.hidenplay.net`; set it to override, or save an empty URL in the dashboard for heartbeat-only. Both are still required for direct calls. Old generic bridge addresses and tokens are not used for inbound control. |
| `HIDENCLOUD_SERVER_ID` / `HIDENCLOUD_API_KEY` | Optional | HiddenCloud panel (Pterodactyl-compatible client API) for server status and power. The API key is a client key (`ptlc_…`) with Control permission from **Account → API Credentials**. The server ID defaults to `a6451c6c` (troyzafarings – Free Server #236941); the panel address is hardcoded to `https://freepanel.hidencloud.com`. Legacy `BOTKEEP_WORKLOAD_ID` / `BOTKEEP_API_KEY` are still honored as fallbacks. |

## Linking Botkeep securely

For normal operation set `DASHBOARD_URL` and a private `BOT_SYNC_TOKEN` on the
Botkeep service, and configure the same token under **WhatsApp → Sync** or as a
dashboard environment secret. The bot initiates the connection; no inbound bot
port is needed. Keep `SESSION_BACKUP_KEY` unchanged if encrypted recovery is in
use. Old saved single-host sync credentials remain supported; a saved Botkeep
role token is used only when no single-host token or legacy admin token exists.
The owner can explicitly save the matching token if needed. Sync and recovery
requests must include the timestamped HMAC signature and nonce used by the
Botkeep client; bearer-only clients must be updated.

An optional direct bot bridge can be enabled separately on Botkeep. Enter its
HTTPS address and token under **WhatsApp → Sync**, or set
`BOTKEEP_BOT_API_URL` and `BOTKEEP_BOT_ADMIN_TOKEN` server-side. When no
address is configured anywhere, the dashboard defaults to the service's
reverse proxy (`https://troy.hidenplay.net`); saving an empty URL in the
dashboard opts back into heartbeat-only mode. Old generic bridge addresses
and old hosting-panel credentials are intentionally ignored, so they cannot
silently target a previous host. Prefer HTTPS for all token traffic. A
heartbeat is a report by the bot, not proof of hosting power state.

HiddenCloud server controls are optional and require a HidenCloud plan with API access — the **free** tier deletes client API keys every 30 minutes, so status/power cannot stay configured there; control the server from the panel instead. On plans with API access, in **WhatsApp → Hosting**, enter a
server ID (prefilled with `a6451c6c`) and a client API key (`ptlc_…`) from
**Account → API Credentials**. The server sends credentials only to the fixed
panel address (`https://freepanel.hidencloud.com`, Pterodactyl-compatible
client API); it is never sent to a browser-supplied URL. Power requests require
an owner confirmation and an accepted request does not mean it has completed.

If an older coordinated bot is still running on Botkeep, stop it before
updating the bot code and synchronizing the single-host token. The older code
expects lease grants that the current dashboard no longer issues. Preserve its
existing environment, database and session, and do not run a second copy. The
separate deployment branch remains owner-managed.

## Owner control room and security

- **WhatsApp → Status** shows the single service and optional HiddenCloud server
  state. A missing check-in is not proof that the server is powered off.
- Sign-in is kept only in the current page's memory. A full refresh or a closed,
  reopened or restored tab requires sign-in again; pending member pairing progress
  and its resend cooldown remain recoverable after signing in.
- The owner home combines bot bridge, WhatsApp, number-list and optional
  HiddenCloud server checks. Status is requested only with a client API key and
  server ID, at most once per minute during routine polling while
  the page is open. Unreachable or unrecognized responses remain **unknown**,
  not automatically offline. Power actions require confirmation and are never
  retried against a different server or queued to an older bot.
- The member-linking pause blocks new linking and pairing requests. It is not a
  reliable kill switch for numbers already approved on the bot. Blocking or allowing
  a member changes that member's stored numbers too; allowing re-enables them.
- Activity is owner-only and best effort: actions are recorded without passwords,
  pairing codes, tokens or full phone numbers. D1 retains entries for approximately
  90 days (cleanup occurs when writing); local fallback keeps the latest 1,000.
  Alerts are derived from checks while a page is open; there is no background or
  email notification when the website is closed. Opening an alert marks it read
  in that owner's browser, but the active warning stays visible until resolved.
  A checked condition that clears and later returns is shown as new again.
- This version closes a verified-account verification bypass and rejects older
  session tokens. All existing users must sign in again after deployment. Deploy
  the fix promptly and remove or restrict any older publicly accessible deployment
  that still contains the vulnerable route. Production registration always requires
  email verification (even if `EMAIL_VERIFICATION_REQUIRED=false` was previously
  set); configure an email provider. Retrying a pending registration requires its
  original password so another registration cannot replace it.

## Member approval, reports, and recovery

- New member numbers can link first, then appear for owner approval under
  **Members**. Pending numbers may pair but cannot execute commands; existing
  approved numbers keep their access. One pending claim per member and the bot's
  linked-account cap limit resource use. Blocking a member does not approve a
  pending request.
- The command catalog is a read-only reference. Command availability and the
  bot's local user allowlist are controlled on the bot and are never sent to or
  changed by the dashboard.
- **Report a problem** is a private member/administrator conversation. The
  server derives the member from the signed-in account and checks the admin role.
  Production reports require D1 rather than silently using ephemeral Vercel disk;
  local disk is for development only. Reports are website-only and are not email
  notifications. Members should not send passwords or pairing codes.
- Optional encrypted WhatsApp recovery requires D1, HTTPS bot sync, the updated
  bot, a private stable `SESSION_BACKUP_KEY` on that bot, and a successfully saved
  snapshot. The dashboard never receives the key or plaintext session credentials.
  Check **WhatsApp → Sync** and follow the recovery instructions in the bot README
  before moving hosts. A lost key, unsynchronized revocation, stale snapshot, or
  WhatsApp revocation can require a fresh link. Run only one bot instance per
  session. Repository CI never uploads or restarts the service.

## Local Development

```bash
cd dashboard
npm ci
npm run dev        # http://localhost:3000 (dev outbox prints 6-digit codes locally)
npm run typecheck
npm test
npm run build
```

If D1 is configured but unreachable, requests fail rather than silently using
local disk. For **isolated local development only**, set
`ZAFAR_DEV_STANDALONE_FALLBACK=1` to opt into the disk fallback. Never use that
override for a dashboard connected to live accounts. It has no effect in
production. Encrypted session recovery always requires D1.
