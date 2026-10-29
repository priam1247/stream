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

The dashboard still deploys with `dashboard` as its project root. The Scribd
service runs independently; neither is started by the WhatsApp bot.
