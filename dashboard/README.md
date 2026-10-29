# ZaFar Control Room (Web Portal)

Standalone Next.js 16 application for member sign-in, WhatsApp number self-service, and the administrator console (`/admin`). It talks to the live bot over `/admin/api/*` (`utils/adminApi.js`, started directly by `index.js`) through a server-side proxy (`lib/bot-proxy.ts`) so `ADMIN_DASHBOARD_TOKEN` never leaves the server.

## Deploying on Vercel (or Self-Hosted Node)

The WhatsApp bot lives at the repository root (`node --expose-gc index.js`). This portal has its own `dashboard/package.json` and `dashboard/package-lock.json`:

1. **Vercel → Project → Settings → General → Root Directory** → set to `dashboard` and click **Save**.
2. Keep the framework preset on **Next.js** (`npm install` / `npm run build`).
3. Configure the environment variables below, then **Deploy**.

Self-hosting with `npm start` enforces `JWT_SECRET_KEY` (minimum 16 characters) before `next start` binds a port, and `instrumentation.ts` + `lib/jwt.ts` enforce the same check on serverless/edge cold starts.

## Environment Variables

| Variable | Required? | Purpose |
|---|---|---|
| `JWT_SECRET_KEY` | **Required in production** | Signs HS256 session cookies (min 16 chars; generate via `openssl rand -hex 32`). Production startup refuses to run without it. |
| `ADMIN_EMAIL` | Recommended | Comma-separated administrator email(s) allowed into `/admin` (default: `troykunsauka@gmail.com`). |
| `ADMIN_INITIAL_PASSWORD` | Optional | Bootstraps the verified `ADMIN_EMAIL` account in D1 on first sign-in before email delivery is configured. |
| `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID` / `CLOUDFLARE_API_TOKEN` | Recommended | Cloudflare D1 database storing verified accounts (`bcryptjs`), member permissions, approved WhatsApp numbers, and bot link settings. Falls back to `.data/zafar-db.json` in local dev. |
| `RESEND_API_KEY` + `EMAIL_FROM` | Pick Resend **or** SMTP | Sends 6-digit verification & password-reset codes over HTTPS (works cleanly on serverless/edge hosts). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Pick Resend **or** SMTP | Direct SMTP mail delivery (e.g. Gmail App Password on port `587` or `465`). |
| `ZAFAR_AUTH_API_URL` | Optional (legacy migration only) | Leave empty. If set during migration from an older external auth service, existing accounts are verified once (6 s cap) and migrated permanently into local D1. |
| `BOT_API_URL` / `ADMIN_DASHBOARD_TOKEN` | Optional | Defaults if not yet saved inside `/admin` → **Bot & Numbers**. |

## Linking the Bot Securely (HTTPS Tunnel Recommended)

1. **On the bot host / panel** (`.env` or Startup Variables):
   ```ini
   ADMIN_API_PORT=3000
   ADMIN_DASHBOARD_TOKEN=<long-random-shared-secret>
   DASHBOARD_URL=https://your-portal.vercel.app
   # Optional if any browser origin ever calls the bot directly:
   ADMIN_CORS_ORIGINS=https://your-portal.vercel.app
   ```
   Restart the bot and confirm `🌐 Dashboard API: on (port …)` in the console.
2. **Expose `/admin/api` over HTTPS (Cloudflare Tunnel recommended)**:
   Plain `http://<node-ip>:<port>` works through the server-side proxy, but sends `ADMIN_DASHBOARD_TOKEN` unencrypted across the network. Whenever possible, put `cloudflared` or an HTTPS reverse proxy in front of the bot port:
   ```bash
   # Quick tunnel test:
   cloudflared tunnel --url http://127.0.0.1:3000

   # Permanent production tunnel (Cloudflare Zero Trust → Networks → Tunnels):
   # Route https://bot-api.yourdomain.com → http://127.0.0.1:3000
   ```
3. **Save inside `/admin` → Bot & Numbers**:
   Paste the `https://` tunnel URL (or `http://<node-ip>:<allocated-port>`) and the same `ADMIN_DASHBOARD_TOKEN`, then click **Test & Save Bot Link**.
   - Status probes time out in **3 seconds** and distinguish **Online**, **Awaiting Pair**, **Bot Offline**, and **Not Linked** immediately.
   - If the bot is behind strict NAT with no inbound port or tunnel, keep `DASHBOARD_URL` set on the bot: `utils/allowlistSync.js` pulls `/api/bot/whitelist` every 5 minutes so member Allow/Disallow changes still apply.

## Local Development

```bash
cd dashboard
npm ci
npm run dev        # http://localhost:3000 (dev outbox prints 6-digit codes locally)
npm run typecheck
npm test
npm run build
```

The Scribd contract test requires Python 3 and the `working scribd` directory
from this repository. It runs the unmodified web handler against temporary
state, with search, covers, and conversion stubbed; it does not contact Scribd
or Drime.

## Scribd Library tab

The dashboard integrates with the **existing** `../working scribd/scribd_web.py`
service. Only the dashboard adapter changes; no server modification is required.
The browser talks to the dashboard's `/api/scribd/*` routes, and the dashboard
calls the web service server-to-server. The web service token is not sent to the
browser.

### Configure the dashboard

Set these **server-side** environment variables in the dashboard deployment
(e.g. Vercel), then redeploy:

```text
SCRIBD_WEB_URL=http://195.123.189.187:25811
SCRIBD_WEB_TOKEN=<the web server's WEB_TOKEN, if enabled>
```

Use the actual reachable server address if it differs. If the web server is
currently open, leave the token empty, but restrict access and enable its token
before exposing it publicly. Use HTTPS or a trusted private network: the existing
web service uses `?t=` authentication, so a token sent over plain HTTP is not
confidential and may appear in upstream access logs. Never put the token in a
`NEXT_PUBLIC_` variable or commit it. The server's `/health` is public; the
adapter checks `/api/job` to verify the protected service.

`SCRIBD_WEB_URL` overrides any legacy saved Scribd panel address. When it is not
set, the previous saved address / `SCRIBD_PANEL_URL` / built-in address remain a
fallback. `SCRIBD_WEB_TOKEN` overrides the previous saved panel key. If a new
`SCRIBD_WEB_URL` is set, an old saved key is **not** sent to that new host; set
`SCRIBD_WEB_TOKEN` explicitly when the new server is locked. The old Scribd-tab
settings card stays removed.

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
- Finished local PDFs are streamed through `/api/scribd/file`. When the server
  says a PDF was offloaded to Drime, the dashboard uses its share link if one was
  provided; otherwise the user must open the Drime folder. The dashboard cannot
  retrieve a deleted local file without a share link or a separate Drime integration.
- The web service does not support the old HMAC direct-file links. The legacy
  `SCRIBD_PUBLIC_URL` direct-download setting is not used. Very large streamed
  files or long searches can still exceed the deployment platform's limits.
- Starting, cancelling, and clearing downloads remain administrator-only. Search,
  job status, and file access require a signed-in dashboard session. The service
  reports whether a job completed; the dashboard cannot independently guarantee
  that every page is present in a PDF.

| file | role |
|---|---|
| `lib/scribd-panel.ts` | server-side adapter and web-service token |
| `lib/scribd-search.ts` / `lib/scribd-job.ts` | cover/document validation and job-file mapping |
| `lib/scribd-guard.ts` | session gate for the dashboard routes |
| `app/api/scribd/*/route.ts` | authenticated search, status, download, cancel, clear, cover and file proxies |
| `components/scribd-desk.tsx` | compact results, selection, progress, and file UI |
