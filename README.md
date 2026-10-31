# ZaFar projects

This repository contains three separate projects:

- **[WhatsApp bot](./Whatsapp%20bot/README.md)** — commands, media engine, configuration, and bot startup files are all in `Whatsapp bot/`.
- **[Control Room dashboard](./dashboard/README.md)** — the standalone Next.js website.
- **[Scribd service](./scribd/README.md)** — the separate Python search and download service.

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

The bot's README explains how to run the contents of `Whatsapp bot/` at the
Botkeep application root and protect existing sessions and databases. Repository
CI only tests code; merging does not upload or restart the bot. Updates to the
separate Botkeep deployment are managed by the owner.

The dashboard deploys separately with `dashboard` as its project root. The
Scribd service runs independently; neither is started by the WhatsApp bot.
