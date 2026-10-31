# ZaFar Control Room (Web Portal)

Standalone Next.js 16 application for member sign-in, WhatsApp number self-service, and the administrator console (`/admin`). The Botkeep service synchronizes outbound over HTTPS; an optional direct bridge can be configured separately. Secrets stay server-side.

## Deploying on Vercel (or Self-Hosted Node)

The WhatsApp bot lives in `Whatsapp bot/` (`cd "Whatsapp bot" && npm start`). This portal is separate and has its own `dashboard/package.json` and `dashboard/package-lock.json`:

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
| `BOTKEEP_BOT_API_URL` / `BOTKEEP_BOT_ADMIN_TOKEN` | Optional | Botkeep-only direct bridge defaults; older generic bridge addresses and tokens are not used for inbound control. |
| `BOTKEEP_WORKLOAD_ID` / `BOTKEEP_API_KEY` | Optional | Explicit Botkeep server ID and Developer API key for server status and power. The key needs `workloads:read` and `power:write`. |

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
`BOTKEEP_BOT_API_URL` and `BOTKEEP_BOT_ADMIN_TOKEN` server-side. Old generic
bridge addresses and old hosting-panel credentials are intentionally ignored,
so they cannot silently target a previous host. Prefer HTTPS for all token
traffic. A heartbeat is a report by the bot, not proof of hosting power state.

Botkeep server controls are optional. In **WhatsApp → Hosting**, explicitly
enter the Botkeep server/workload ID and a Botkeep Developer API key. The
server sends credentials only to the fixed official HTTPS Developer API. It
does not discover or choose a server automatically. Power requests require an
owner confirmation and an accepted request does not mean it has completed.

If an older coordinated bot is still running on Botkeep, stop it before
updating the bot code and synchronizing the single-host token. The older code
expects lease grants that the current dashboard no longer issues. Preserve its
existing environment, database and session, and do not run a second copy. The
separate deployment branch remains owner-managed.

## Owner control room and security

- **WhatsApp → Status** shows the single service and optional Botkeep server
  state. A missing check-in is not proof that the server is powered off.
- Sign-in is kept only in the current page's memory. A full refresh or a closed,
  reopened or restored tab requires sign-in again; pending member pairing progress
  and its resend cooldown remain recoverable after signing in.
- The owner home combines bot bridge, WhatsApp, Scribd, number-list and optional
  Botkeep server checks. Status is requested only with a Botkeep Developer API
  key and explicit server ID, at most once per minute during routine polling while
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
- **WhatsApp → Commands** switches individual member commands on or off. Aliases
  and pending selections use the same canonical policy; the owner can still test.
  A site shortcut switch does not block that site through the separate `.dl`
  command. Changes show **awaiting service sync** until the bot reports the
  matching policy version. Work already running is not forcibly cancelled.
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

The Scribd contract test requires Python 3 and the `scribd` directory
from this repository. It runs the unmodified web handler against temporary
state, with search, covers, and conversion stubbed; it does not contact Scribd
or Drime.

## Scribd Library tab

The dashboard integrates with the **existing** `../scribd/scribd_web.py`
service. Only the dashboard adapter changes; no server modification is required.
The browser talks to the dashboard's `/api/scribd/*` routes, and the dashboard
calls the web service server-to-server. The web service token is not sent to the
browser.

### Server address and token

The dashboard uses the built-in HTTPS proxy `https://troy.hidenplay.net`. No address
entry is needed, and `SCRIBD_WEB_URL` is ignored, including an old HTTP value. If the
service moves, change the address in `lib/scribd-config.ts` and deploy the dashboard
again. The existing server-side `SCRIBD_WEB_TOKEN` is still used.

The service must be running and reachable; deploying the dashboard does not start
`scribd_web.py`. The public `/health` endpoint should return `ok`; `/api/job` should
return a job list, or HTTP 401 if a token is required. A successful health check
alone does not verify the token, search, or downloads.

HTTPS protects the dashboard's connection to the reverse proxy. The proxy may
forward to the service over HTTP, and the direct service port may still be public;
protect that hop and restrict direct access where the host permits it.

`SCRIBD_WEB_TOKEN` is the same token configured on the running service via
`--token` or `WEB_TOKEN`. With the default `auto` setting, the service keeps it
in its private `.webtoken` file and prints it in the startup URL after `?t=`.
Copy that value yourself into the dashboard deployment's secret environment
settings; do not put it in source code, a `NEXT_PUBLIC_` variable, or a message.
The command-line `--token` takes priority over `WEB_TOKEN` from the process
environment or the service's `.env`.

If the server has no token, anyone who can reach its port can use it directly.
Protect it before public exposure. The service sends tokens in a query string,
which upstream access logs may record; configure the HTTPS proxy not to log them.
Token-bearing HTTP is otherwise allowed only for loopback development addresses
(`localhost`, `127.0.0.1`, or `::1`).

Legacy saved panel addresses/keys and `SCRIBD_PANEL_URL` / `SCRIBD_PANEL_KEY` no
longer change this connection. The old admin configuration endpoint reports the
effective connection, but rejects attempts to save legacy settings.

### Behaviour and limitations

- Search proxies `GET /api/search` and preserves real cover URLs. Covers are
  fetched through the web service and dashboard; failed covers show a placeholder.
- **Show more results** reveals existing results in batches and requests the next
  search page. The web service does not report a page count, so the dashboard
  stops when a page returns no new items (at most 40 pages).
- Download submits document IDs, titles, and page counts to `POST /api/download`.
  The server ignores IDs already in its queue or history, including failures;
  the dashboard retains those selections and explains how to clear the queue.
  Its duplicate pre-check cannot be atomic with submissions by other clients,
  because the service does not return an explicit list of accepted IDs.
- Live job states, reported page counts, errors, cancel, and clear are mapped from
  `/api/job`, `/api/cancel`, and `/api/clear`. Clearing also removes waiting jobs
  and history but does not stop the currently running job. The current server's
  clear operation does not itself save the changed history to disk.
- Finished local PDFs are streamed through `/api/scribd/file`. A short-lived,
  file-specific HttpOnly ticket lets the browser download without putting a session
  token in the URL or buffering the entire PDF. When the server says a PDF was
  offloaded to Drime, the dashboard uses its share link if one was provided;
  otherwise the user must open the Drime folder. The dashboard cannot
  retrieve a deleted local file without a share link or a separate Drime integration.
- The web service does not support the old HMAC direct-file links. The legacy
  `SCRIBD_PUBLIC_URL` direct-download setting is not used. Very large streamed
  files or long searches can still exceed the deployment platform's limits.
- Scribd is private to the owner in the dashboard by default. Under **Members**,
  the owner can individually grant or revoke access for active members. Granted
  members can search and see the shared job status and files, but only owners can
  start, cancel, or clear downloads. Blocking a member also blocks Scribd regardless
  of the saved grant. These dashboard controls do **not** protect a directly
  reachable Scribd service; enforce its own token or restrict network access.
- Favourites, recent searches, and the current selection are stored in the browser
  on that device, separated by dashboard account. They do not sync across devices;
  clearing browser data removes them. Sorting applies only to already-loaded results.
- The existing service supports cancellation and clearing only for the shared queue,
  not retry/cancel of individual items. The dashboard does not invent those actions.
  The service reports whether a job completed; the dashboard cannot independently
  guarantee that every page is present in a PDF.

| file | role |
|---|---|
| `lib/scribd-panel.ts` | server-side adapter and web-service token |
| `lib/scribd-search.ts` / `lib/scribd-job.ts` | cover/document validation and job-file mapping |
| `lib/scribd-guard.ts` | session gate for the dashboard routes |
| `app/api/scribd/*/route.ts` | authenticated search, status, download, cancel, clear, cover and file proxies |
| `components/scribd-desk.tsx` | compact results, selection, progress, and file UI |
