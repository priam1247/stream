# Stream

This repository contains several related applications and tools:

- [`dashboard/`](./dashboard/) — the Next.js 16 operations dashboard: member sign-in, WhatsApp number self-service, and the owner console (`/admin`).
- [`the bot/`](./the%20bot/) — the WhatsApp bot, gateway, and media engine that the dashboard synchronizes with.
- [`scribd/`](./scribd/) — Scribd-related tools.
- [`.github/`](./.github/) — CI workflow plus repository-level safety tests.

To work on the dashboard:

```sh
cd dashboard
npm ci
npm run dev
```

See each application's README for its own setup and environment requirements.
