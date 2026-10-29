# ZaFar projects

This repository contains three separate projects:

- **[WhatsApp bot](./Whatsapp%20bot/README.md)** — commands, media engine, configuration, and bot startup files are all in `Whatsapp bot/`.
- **[Control Room dashboard](./dashboard/README.md)** — the standalone Next.js website.
- **[Scribd service](./working%20scribd/README.md)** — the separate Python search and download service.

## Starting the WhatsApp bot

From the repository root:

```bash
cd "Whatsapp bot"
cp .env.example .env   # set private values locally, or use your host's variables
npm ci
npm run selftest
npm run test:jobs
npm start
```

The bot's own README explains how to upload it to a panel and safely migrate an
existing session and database. The repository-level `.github/workflows/` stays
at the root because GitHub Actions requires it there; its deployment workflow
uploads only the contents of the bot folder to the configured panel.

### Bot upload

The workflow uploads automatically after bot code or configuration changes pass
the checks on `main`. Dashboard-only and bot documentation-only updates do not
upload or restart the bot. Uploads are serialized, and an older run will not
replace newer bot changes.

To upload manually, open **Actions → Deploy bot to XS Systems panel → Run
workflow** and select `main`. Before running it, privately add these GitHub Actions
secrets under **Settings → Secrets and variables → Actions**:

- `PANEL_SFTP_HOST` and `PANEL_SFTP_USER`
- `PANEL_SFTP_PASS` or `PANEL_SSH_KEY`
- `PANEL_SFTP_PORT` if the host uses a port other than the default `2022`

Verify the settings point to the intended server. A manual upload fails clearly
if they are missing. For an automatic restart, add the `PANEL_API_KEY` secret and
set the exact `PANEL_URL` (HTTPS) and `PANEL_SERVER_ID` as Actions variables or
secrets. No server is guessed; if these are missing, restart it yourself in the
panel. Never post credentials or commit them to the repository. Existing session,
environment, and database state is excluded from the upload.

The dashboard still deploys with `dashboard` as its project root. The Scribd
service runs independently; neither is started by the WhatsApp bot.
