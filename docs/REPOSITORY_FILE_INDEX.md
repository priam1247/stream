# Complete repository file and connection index

This snapshot lists **all 349 repository files**: the 346 tracked files at commit `c6176af` plus three new provider-search files.
The linked [architecture overview](../REPOSITORY_MAP.md) contains the diagrams, complete tree, runtime flows, route list, and scope.

## How to read an entry

- **References** lists direct static imports, route URLs, documented file mentions, or explicitly identified build/runtime relationships. The label says which; it does not imply that a conditional feature always runs.
- **Referenced by** reverses those same relationships, including tests, documentation, and generated-file provenance. A file without a detected caller may still be loaded by a framework, an operator, or a computed path.
- **Outside modules** are literal imports that resolve to the language runtime, a third-party package, or another external module rather than a tracked repository file. They are not separate files in this repository.
- **Dynamic loading** means the parser found a non-literal `require` or `import`; relevant known links are also listed where identified. External HTTP services, database state, and files generated at runtime are described in the overview, not listed as tracked files.
- The index is a snapshot, not a proof of every possible runtime path: values built at runtime, remote services, and operator actions cannot all be inferred statically.

## Files

### Repository root

- [`.gitignore`](../.gitignore) — Repository-wide exclusions for generated files, credentials, databases, and runtime artifacts.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`README.md`](../README.md) — Repository entry point and links to the three projects; some deployment text is stale (see overview).
  - **References:**
    - [`dashboard/README.md`](../dashboard/README.md) — explicit relationship, documentation link, file path mentioned.
    - [`scribd/README.md`](../scribd/README.md) — explicit relationship, documentation link, file path mentioned.
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — explicit relationship, documentation link.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`REPOSITORY_MAP.md`](../REPOSITORY_MAP.md) — Architecture overview, full repository tree, service flows, routes, and reading guide.
  - **References:**
    - [`docs/REPOSITORY_FILE_INDEX.md`](REPOSITORY_FILE_INDEX.md) — explicit relationship.
  - **Referenced by:**
    - [`docs/REPOSITORY_FILE_INDEX.md`](REPOSITORY_FILE_INDEX.md) — explicit relationship.

### `.github/scripts/`

- [`bot-diff.sh`](../.github/scripts/bot-diff.sh) — Compares two commits for changes to bot runtime content.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`.github/scripts/check-bot-freshness.sh`](../.github/scripts/check-bot-freshness.sh) — file name mentioned.
    - [`.github/scripts/should-deploy-bot.sh`](../.github/scripts/should-deploy-bot.sh) — file name mentioned.

- [`check-bot-freshness.sh`](../.github/scripts/check-bot-freshness.sh) — Prevents an older workflow from uploading stale bot files.
  - **References:**
    - [`.github/scripts/bot-diff.sh`](../.github/scripts/bot-diff.sh) — file name mentioned.
  - **Referenced by:**
    - [`.github/tests/deploy-bot-gate.test.cjs`](../.github/tests/deploy-bot-gate.test.cjs) — file path mentioned.
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — explicit relationship, file path mentioned.

- [`check-panel-config.sh`](../.github/scripts/check-panel-config.sh) — Checks whether legacy panel SFTP credentials are configured without printing them.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`.github/tests/deploy-bot-gate.test.cjs`](../.github/tests/deploy-bot-gate.test.cjs) — file path mentioned.
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — explicit relationship, file path mentioned.

- [`restart-panel.sh`](../.github/scripts/restart-panel.sh) — Optionally restarts an explicitly configured legacy panel server over HTTPS.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`.github/tests/deploy-bot-gate.test.cjs`](../.github/tests/deploy-bot-gate.test.cjs) — file path mentioned.
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — explicit relationship, file path mentioned.

- [`should-deploy-bot.sh`](../.github/scripts/should-deploy-bot.sh) — Decides whether a workflow event should attempt the legacy bot deployment.
  - **References:**
    - [`.github/scripts/bot-diff.sh`](../.github/scripts/bot-diff.sh) — file name mentioned.
  - **Referenced by:**
    - [`.github/tests/deploy-bot-gate.test.cjs`](../.github/tests/deploy-bot-gate.test.cjs) — file path mentioned.
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — explicit relationship, file path mentioned.

### `.github/tests/`

- [`deploy-bot-gate.test.cjs`](../.github/tests/deploy-bot-gate.test.cjs) — Node tests for the workflow deployment, freshness, secret-check, and restart gates.
  - **References:**
    - [`.github/scripts/check-bot-freshness.sh`](../.github/scripts/check-bot-freshness.sh) — file path mentioned.
    - [`.github/scripts/check-panel-config.sh`](../.github/scripts/check-panel-config.sh) — file path mentioned.
    - [`.github/scripts/restart-panel.sh`](../.github/scripts/restart-panel.sh) — file path mentioned.
    - [`.github/scripts/should-deploy-bot.sh`](../.github/scripts/should-deploy-bot.sh) — file path mentioned.
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — file path mentioned.
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — file path mentioned.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — file path mentioned.
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — file path mentioned.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — explicit relationship, file path mentioned.
  - **Outside modules:** `node:assert/strict`, `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:test`.

### `.github/workflows/`

- [`deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — GitHub Actions test/build workflow and explicitly confirmed manual-only legacy SFTP upload.
  - **References:**
    - [`Whatsapp bot/scripts/test-provider-search-handler.js`](../Whatsapp%20bot/scripts/test-provider-search-handler.js) — invoked via npm test:media.
    - [`Whatsapp bot/scripts/test-provider-search.js`](../Whatsapp%20bot/scripts/test-provider-search.js) — invoked via npm test:media.
    - [`Whatsapp bot/scripts/test-media-shortcuts.js`](../Whatsapp%20bot/scripts/test-media-shortcuts.js) — invoked via npm test:media.
    - [`Whatsapp bot/scripts/test-media-extractors.py`](../Whatsapp%20bot/scripts/test-media-extractors.py) — test invocation.
    - [`Whatsapp bot/scripts/test-media-downloads.js`](../Whatsapp%20bot/scripts/test-media-downloads.js) — invoked via npm test:media.
    - [`.github/scripts/check-bot-freshness.sh`](../.github/scripts/check-bot-freshness.sh) — explicit relationship, file path mentioned.
    - [`.github/scripts/check-panel-config.sh`](../.github/scripts/check-panel-config.sh) — explicit relationship, file path mentioned.
    - [`.github/scripts/restart-panel.sh`](../.github/scripts/restart-panel.sh) — explicit relationship, file path mentioned.
    - [`.github/scripts/should-deploy-bot.sh`](../.github/scripts/should-deploy-bot.sh) — explicit relationship, file path mentioned.
    - [`.github/tests/deploy-bot-gate.test.cjs`](../.github/tests/deploy-bot-gate.test.cjs) — explicit relationship, file path mentioned.
    - [`dashboard/package-lock.json`](../dashboard/package-lock.json) — explicit relationship.
    - [`dashboard/package.json`](../dashboard/package.json) — explicit relationship.
    - [`Whatsapp bot/package-lock.json`](../Whatsapp%20bot/package-lock.json) — explicit relationship.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship.
    - [`Whatsapp bot/scripts/test-nm3u8dl-live.js`](../Whatsapp%20bot/scripts/test-nm3u8dl-live.js) — explicit relationship.
  - **Referenced by:**
    - [`.github/tests/deploy-bot-gate.test.cjs`](../.github/tests/deploy-bot-gate.test.cjs) — file path mentioned.

### `dashboard/`

- [`.env.example`](../dashboard/.env.example) — Template for dashboard server configuration; it does not contain live deployment secrets.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — explicit relationship.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — explicit relationship.
    - [`dashboard/lib/email-service.ts`](../dashboard/lib/email-service.ts) — explicit relationship.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — explicit relationship.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — explicit relationship.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`instrumentation.ts`](../dashboard/instrumentation.ts) — Next.js startup hook that validates the production JWT signing secret.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/package.json`](../dashboard/package.json) — Next.js/build discovery.
    - [`dashboard/README.md`](../dashboard/README.md) — file name mentioned.

- [`next.config.mjs`](../dashboard/next.config.mjs) — Next.js configuration including Turbopack root and preview development origins.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/package.json`](../dashboard/package.json) — explicit relationship.
  - **Outside modules:** `node:path`, `node:url`.

- [`package-lock.json`](../dashboard/package-lock.json) — Pinned npm dependency graph used by npm ci for the dashboard.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — explicit relationship.
    - [`dashboard/package.json`](../dashboard/package.json) — npm lockfile.

- [`package.json`](../dashboard/package.json) — Next.js dashboard package, dependencies, and dev/build/test scripts.
  - **References:**
    - [`dashboard/app/layout.tsx`](../dashboard/app/layout.tsx) — Next.js/build discovery.
    - [`dashboard/instrumentation.ts`](../dashboard/instrumentation.ts) — Next.js/build discovery.
    - [`dashboard/next.config.mjs`](../dashboard/next.config.mjs) — explicit relationship.
    - [`dashboard/package-lock.json`](../dashboard/package-lock.json) — npm lockfile.
    - [`dashboard/postcss.config.mjs`](../dashboard/postcss.config.mjs) — Next.js/build discovery.
    - [`dashboard/scripts/check-prod-env.mjs`](../dashboard/scripts/check-prod-env.mjs) — explicit relationship.
    - [`dashboard/tailwind.config.ts`](../dashboard/tailwind.config.ts) — Next.js/build discovery.
    - [`dashboard/tsconfig.json`](../dashboard/tsconfig.json) — explicit relationship.
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — explicit relationship.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — explicit relationship.
    - [`dashboard/README.md`](../dashboard/README.md) — file path mentioned, file name mentioned.

- [`postcss.config.mjs`](../dashboard/postcss.config.mjs) — PostCSS pipeline using Tailwind CSS and Autoprefixer.
  - **References:**
    - [`dashboard/tailwind.config.ts`](../dashboard/tailwind.config.ts) — Tailwind config discovery.
  - **Referenced by:**
    - [`dashboard/package.json`](../dashboard/package.json) — Next.js/build discovery.

- [`README.md`](../dashboard/README.md) — Setup, security, storage, bot bridge, and Scribd integration guidance for the dashboard.
  - **References:**
    - [`dashboard/instrumentation.ts`](../dashboard/instrumentation.ts) — file name mentioned.
    - [`dashboard/package.json`](../dashboard/package.json) — file path mentioned, file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — file path mentioned.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — file path mentioned.
    - [`Whatsapp bot/utils/adminApi.js`](../Whatsapp%20bot/utils/adminApi.js) — file path mentioned.
  - **Referenced by:**
    - [`README.md`](../README.md) — explicit relationship, documentation link, file path mentioned.
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — documentation link, file path mentioned.

- [`tailwind.config.ts`](../dashboard/tailwind.config.ts) — Tailwind source scanning and theme configuration.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/app/globals.css`](../dashboard/app/globals.css) — Tailwind build configuration.
    - [`dashboard/package.json`](../dashboard/package.json) — Next.js/build discovery.
    - [`dashboard/postcss.config.mjs`](../dashboard/postcss.config.mjs) — Tailwind config discovery.
  - **Outside modules:** `tailwindcss`.

- [`tsconfig.json`](../dashboard/tsconfig.json) — TypeScript options, Next plugin, and the @/ project-root import alias.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/package.json`](../dashboard/package.json) — explicit relationship.

- [`vitest.config.ts`](../dashboard/vitest.config.ts) — Vitest setup, jsdom default, @ alias, and test-file discovery.
  - **References:**
    - [`dashboard/tests/member-command-controls.test.tsx`](../dashboard/tests/member-command-controls.test.tsx) — test discovery.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — test discovery.
    - [`dashboard/tests/admin-route-authorization.test.ts`](../dashboard/tests/admin-route-authorization.test.ts) — test discovery.
    - [`dashboard/tests/auth-screen.test.tsx`](../dashboard/tests/auth-screen.test.tsx) — test discovery.
    - [`dashboard/tests/auth-security.test.ts`](../dashboard/tests/auth-security.test.ts) — test discovery.
    - [`dashboard/tests/client-session.test.ts`](../dashboard/tests/client-session.test.ts) — test discovery.
    - [`dashboard/tests/control-room-alerts.test.ts`](../dashboard/tests/control-room-alerts.test.ts) — test discovery.
    - [`dashboard/tests/control-room-security.test.ts`](../dashboard/tests/control-room-security.test.ts) — test discovery.
    - [`dashboard/tests/control-room-storage.test.ts`](../dashboard/tests/control-room-storage.test.ts) — test discovery.
    - [`dashboard/tests/d1-initialization.test.ts`](../dashboard/tests/d1-initialization.test.ts) — test discovery.
    - [`dashboard/tests/email-branding.test.ts`](../dashboard/tests/email-branding.test.ts) — test discovery.
    - [`dashboard/tests/member-features-security.test.ts`](../dashboard/tests/member-features-security.test.ts) — test discovery.
    - [`dashboard/tests/member-home.test.tsx`](../dashboard/tests/member-home.test.tsx) — test discovery.
    - [`dashboard/tests/member-link-api.test.ts`](../dashboard/tests/member-link-api.test.ts) — test discovery.
    - [`dashboard/tests/member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — test discovery.
    - [`dashboard/tests/member-scribd-navigation.test.tsx`](../dashboard/tests/member-scribd-navigation.test.tsx) — test discovery.
    - [`dashboard/tests/pairing-code-banner.test.tsx`](../dashboard/tests/pairing-code-banner.test.tsx) — test discovery.
    - [`dashboard/tests/pairing-security.test.ts`](../dashboard/tests/pairing-security.test.ts) — test discovery.
    - [`dashboard/tests/panel-client.test.ts`](../dashboard/tests/panel-client.test.ts) — test discovery.
    - [`dashboard/tests/panel-route.test.ts`](../dashboard/tests/panel-route.test.ts) — test discovery.
    - [`dashboard/tests/panel-status.test.ts`](../dashboard/tests/panel-status.test.ts) — test discovery.
    - [`dashboard/tests/room-alert-reads.test.ts`](../dashboard/tests/room-alert-reads.test.ts) — test discovery.
    - [`dashboard/tests/scribd-config.test.ts`](../dashboard/tests/scribd-config.test.ts) — test discovery.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — test discovery.
    - [`dashboard/tests/scribd-download-ticket.test.ts`](../dashboard/tests/scribd-download-ticket.test.ts) — test discovery.
    - [`dashboard/tests/scribd-panel.test.ts`](../dashboard/tests/scribd-panel.test.ts) — test discovery.
    - [`dashboard/tests/scribd-search.test.ts`](../dashboard/tests/scribd-search.test.ts) — test discovery.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — test discovery.
    - [`dashboard/tests/session-backup-api.test.ts`](../dashboard/tests/session-backup-api.test.ts) — test discovery.
    - [`dashboard/tests/session-backup-sqlite.test.ts`](../dashboard/tests/session-backup-sqlite.test.ts) — test discovery.
    - [`dashboard/tests/support-desk.test.tsx`](../dashboard/tests/support-desk.test.tsx) — test discovery.
    - [`dashboard/tests/sync-status.test.ts`](../dashboard/tests/sync-status.test.ts) — test discovery.
    - [`dashboard/tests/whatsapp-bridge.test.ts`](../dashboard/tests/whatsapp-bridge.test.ts) — test discovery.
    - [`dashboard/tests/whatsapp-status-privacy.test.ts`](../dashboard/tests/whatsapp-status-privacy.test.ts) — test discovery.
    - [`dashboard/tests/workspace-shell.test.tsx`](../dashboard/tests/workspace-shell.test.tsx) — test discovery.
    - [`dashboard/tests/zafar-robot.test.tsx`](../dashboard/tests/zafar-robot.test.tsx) — test discovery.
  - **Referenced by:**
    - [`dashboard/package.json`](../dashboard/package.json) — explicit relationship.
  - **Outside modules:** `node:url`, `vitest/config`.

### `dashboard/app/`

- [`globals.css`](../dashboard/app/globals.css) — Global styles and Tailwind layers shared by dashboard pages.
  - **References:**
    - [`dashboard/tailwind.config.ts`](../dashboard/tailwind.config.ts) — Tailwind build configuration.
  - **Referenced by:**
    - [`dashboard/app/layout.tsx`](../dashboard/app/layout.tsx) — import.

- [`icon.tsx`](../dashboard/app/icon.tsx) — Next.js-generated site icon.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.
  - **Outside modules:** `next/og`.

- [`layout.tsx`](../dashboard/app/layout.tsx) — Root Next.js layout, site metadata, fonts, and global stylesheet.
  - **References:**
    - [`dashboard/app/admin/page.tsx`](../dashboard/app/admin/page.tsx) — Next.js wraps page.
    - [`dashboard/app/dashboard/page.tsx`](../dashboard/app/dashboard/page.tsx) — Next.js wraps page.
    - [`dashboard/app/globals.css`](../dashboard/app/globals.css) — import.
    - [`dashboard/app/login/page.tsx`](../dashboard/app/login/page.tsx) — Next.js wraps page.
    - [`dashboard/app/page.tsx`](../dashboard/app/page.tsx) — Next.js wraps page.
    - [`dashboard/app/support/page.tsx`](../dashboard/app/support/page.tsx) — Next.js wraps page.
  - **Referenced by:**
    - [`dashboard/package.json`](../dashboard/package.json) — Next.js/build discovery.
  - **Outside modules:** `geist/font/mono`, `geist/font/sans`, `next`.

- [`page.tsx`](../dashboard/app/page.tsx) — Root page that routes a visitor to login, owner, or member workspace.
  - **References:**
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/layout.tsx`](../dashboard/app/layout.tsx) — Next.js wraps page.
  - **Outside modules:** `lucide-react`, `next/navigation`, `react`.

### `dashboard/app/admin/`

- [`page.tsx`](../dashboard/app/admin/page.tsx) — Owner workspace page wrapping AdminConsole.
  - **References:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
  - **Referenced by:**
    - [`dashboard/app/layout.tsx`](../dashboard/app/layout.tsx) — Next.js wraps page.

### `dashboard/app/api/admin/activity/`

- [`route.ts`](../dashboard/app/api/admin/activity/route.ts) — Read owner activity. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — route URL reference.
    - [`dashboard/tests/control-room-security.test.ts`](../dashboard/tests/control-room-security.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/approvals/`

- [`route.ts`](../dashboard/app/api/admin/approvals/route.ts) — Approve or decline pending member-linked accounts. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
    - [`dashboard/tests/member-features-security.test.ts`](../dashboard/tests/member-features-security.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/commands/`

- [`route.ts`](../dashboard/app/api/admin/commands/route.ts) — Read or change member command policy. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-data.ts`](../dashboard/lib/bot-data.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/member-command-controls.tsx`](../dashboard/components/member-command-controls.tsx) — route URL reference.
    - [`dashboard/tests/member-features-security.test.ts`](../dashboard/tests/member-features-security.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/members/`

- [`route.ts`](../dashboard/app/api/admin/members/route.ts) — Manage member access. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/members/scribd/`

- [`route.ts`](../dashboard/app/api/admin/members/scribd/route.ts) — Grant or revoke a member's Scribd access. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — route URL reference.
    - [`dashboard/tests/control-room-security.test.ts`](../dashboard/tests/control-room-security.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/pair/`

- [`route.ts`](../dashboard/app/api/admin/pair/route.ts) — Request or inspect owner/admin pairing. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/panel/`

- [`route.ts`](../dashboard/app/api/admin/panel/route.ts) — Test or save optional panel connection settings. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
    - [`dashboard/lib/panel-client.ts`](../dashboard/lib/panel-client.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — route URL reference.
    - [`dashboard/tests/panel-route.test.ts`](../dashboard/tests/panel-route.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/panel/status/`

- [`route.ts`](../dashboard/app/api/admin/panel/status/route.ts) — Read optional hosting-panel status. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/panel-client.ts`](../dashboard/lib/panel-client.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — route URL reference.
    - [`dashboard/tests/panel-status.test.ts`](../dashboard/tests/panel-status.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/settings/`

- [`route.ts`](../dashboard/app/api/admin/settings/route.ts) — Update owner service settings. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/status/`

- [`route.ts`](../dashboard/app/api/admin/status/route.ts) — Read owner overview and service health. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/sync-status.ts`](../dashboard/lib/sync-status.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/users/`

- [`route.ts`](../dashboard/app/api/admin/users/route.ts) — Add an approved WhatsApp number. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/users/[number]/`

- [`route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/route.ts) — Update or remove a specific approved number. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/admin/users/[number]/sync/`

- [`route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/sync/route.ts) — Request synchronization for a specific number. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/auth/forgot-password/`

- [`route.ts`](../dashboard/app/api/auth/forgot-password/route.ts) — Start password recovery. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/auth/login/`

- [`route.ts`](../dashboard/app/api/auth/login/route.ts) — Authenticate a dashboard user. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
    - [`dashboard/lib/rate-limit.ts`](../dashboard/lib/rate-limit.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — route URL reference.
    - [`dashboard/tests/auth-screen.test.tsx`](../dashboard/tests/auth-screen.test.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/auth/logout/`

- [`route.ts`](../dashboard/app/api/auth/logout/route.ts) — End the current dashboard session. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
  - **Referenced by:**
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/auth/me/`

- [`route.ts`](../dashboard/app/api/auth/me/route.ts) — Read or update the authenticated user. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — route URL reference.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — route URL reference.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — route URL reference.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — route URL reference.
    - [`dashboard/tests/auth-security.test.ts`](../dashboard/tests/auth-security.test.ts) — route URL reference.
    - [`dashboard/tests/client-session.test.ts`](../dashboard/tests/client-session.test.ts) — route URL reference.
    - [`dashboard/tests/member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — route URL reference.
    - [`dashboard/tests/member-scribd-navigation.test.tsx`](../dashboard/tests/member-scribd-navigation.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/auth/register/`

- [`route.ts`](../dashboard/app/api/auth/register/route.ts) — Register a dashboard account. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/rate-limit.ts`](../dashboard/lib/rate-limit.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/auth/resend/`

- [`route.ts`](../dashboard/app/api/auth/resend/route.ts) — Resend a verification message. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/auth/reset-password/`

- [`route.ts`](../dashboard/app/api/auth/reset-password/route.ts) — Complete password reset. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/auth/verify/`

- [`route.ts`](../dashboard/app/api/auth/verify/route.ts) — Verify a user account. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — route URL reference.
    - [`dashboard/tests/auth-security.test.ts`](../dashboard/tests/auth-security.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/bot/session-backups/`

- [`route.ts`](../dashboard/app/api/bot/session-backups/route.ts) — Accept authenticated session-backup operations using durable storage. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/bot-sync-auth.ts`](../dashboard/lib/bot-sync-auth.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/tests/session-backup-api.test.ts`](../dashboard/tests/session-backup-api.test.ts) — import, route URL reference.
    - [`Whatsapp bot/utils/sessionBackup.js`](../Whatsapp%20bot/utils/sessionBackup.js) — route URL reference, outbound HTTP.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/bot/sync/`

- [`route.ts`](../dashboard/app/api/bot/sync/route.ts) — Receive bot heartbeat/results and return queue, access, and command policy changes. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-sync-auth.ts`](../dashboard/lib/bot-sync-auth.ts) — import.
    - [`dashboard/lib/rate-limit.ts`](../dashboard/lib/rate-limit.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/whatsapp-accounts.ts`](../dashboard/lib/whatsapp-accounts.ts) — import.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — route URL reference.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — route URL reference, outbound HTTP.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/bot/whitelist/`

- [`route.ts`](../dashboard/app/api/bot/whitelist/route.ts) — Provide the authenticated bot allowlist snapshot. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/bot-sync-auth.ts`](../dashboard/lib/bot-sync-auth.ts) — import.
    - [`dashboard/lib/rate-limit.ts`](../dashboard/lib/rate-limit.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/member/numbers/`

- [`route.ts`](../dashboard/app/api/member/numbers/route.ts) — Add a member-owned WhatsApp number. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — route URL reference.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — route URL reference.
    - [`dashboard/tests/member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/member/numbers/[number]/`

- [`route.ts`](../dashboard/app/api/member/numbers/%5Bnumber%5D/route.ts) — Update or delete a member-owned number. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/member/pair/`

- [`route.ts`](../dashboard/app/api/member/pair/route.ts) — Request or inspect member linking and pairing. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — route URL reference.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — route URL reference.
    - [`dashboard/tests/member-link-api.test.ts`](../dashboard/tests/member-link-api.test.ts) — import, route URL reference.
    - [`dashboard/tests/member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — route URL reference.
    - [`dashboard/tests/pairing-security.test.ts`](../dashboard/tests/pairing-security.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/member/status/`

- [`route.ts`](../dashboard/app/api/member/status/route.ts) — Read member-specific bot and account status. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/sync-status.ts`](../dashboard/lib/sync-status.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — route URL reference.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — route URL reference.
    - [`dashboard/tests/member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — route URL reference.
    - [`dashboard/tests/member-scribd-navigation.test.tsx`](../dashboard/tests/member-scribd-navigation.test.tsx) — route URL reference.
    - [`dashboard/tests/whatsapp-status-privacy.test.ts`](../dashboard/tests/whatsapp-status-privacy.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/member/unlink/`

- [`route.ts`](../dashboard/app/api/member/unlink/route.ts) — Request or inspect unlinking of a member account. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — route URL reference.
    - [`dashboard/tests/member-link-api.test.ts`](../dashboard/tests/member-link-api.test.ts) — import, route URL reference.
    - [`dashboard/tests/member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/clear/`

- [`route.ts`](../dashboard/app/api/scribd/clear/route.ts) — Clear the shared Scribd queue/history (owner). Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — route URL reference.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/config/`

- [`route.ts`](../dashboard/app/api/scribd/config/route.ts) — Report effective Scribd connection status and reject legacy settings changes (owner). Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/tests/scribd-panel.test.ts`](../dashboard/tests/scribd-panel.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/file/`

- [`route.ts`](../dashboard/app/api/scribd/file/route.ts) — Stream a permitted PDF to the dashboard user. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
    - [`dashboard/lib/scribd-download-ticket.ts`](../dashboard/lib/scribd-download-ticket.ts) — import.
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/api/scribd/link/route.ts`](../dashboard/app/api/scribd/link/route.ts) — route URL reference.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — route URL reference.
    - [`dashboard/lib/scribd-download-ticket.ts`](../dashboard/lib/scribd-download-ticket.ts) — route URL reference.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-download-ticket.test.ts`](../dashboard/tests/scribd-download-ticket.test.ts) — import, route URL reference.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/file-ticket/`

- [`route.ts`](../dashboard/app/api/scribd/file-ticket/route.ts) — Issue a short-lived scoped PDF download ticket. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
    - [`dashboard/lib/scribd-download-ticket.ts`](../dashboard/lib/scribd-download-ticket.ts) — import.
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — route URL reference.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-download-ticket.test.ts`](../dashboard/tests/scribd-download-ticket.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/files/`

- [`route.ts`](../dashboard/app/api/scribd/files/route.ts) — List permitted Scribd output files. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/find/`

- [`route.ts`](../dashboard/app/api/scribd/find/route.ts) — Search Scribd through the service. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — route URL reference.
    - [`dashboard/tests/member-scribd-navigation.test.tsx`](../dashboard/tests/member-scribd-navigation.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/link/`

- [`route.ts`](../dashboard/app/api/scribd/link/route.ts) — Return a permitted offloaded file link. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — route URL reference.
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/reset/`

- [`route.ts`](../dashboard/app/api/scribd/reset/route.ts) — Cancel/reset the shared queue (owner). Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — route URL reference.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/run/`

- [`route.ts`](../dashboard/app/api/scribd/run/route.ts) — Submit a shared download job (owner). Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — route URL reference.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/status/`

- [`route.ts`](../dashboard/app/api/scribd/status/route.ts) — Read shared queue status. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — route URL reference.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — route URL reference.
    - [`dashboard/tests/member-scribd-navigation.test.tsx`](../dashboard/tests/member-scribd-navigation.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/scribd/thumb/`

- [`route.ts`](../dashboard/app/api/scribd/thumb/route.ts) — Proxy a validated Scribd thumbnail. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — route URL reference.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — route URL reference.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/api/support/`

- [`route.ts`](../dashboard/app/api/support/route.ts) — Read and send private support messages. Next.js discovers this API route by its path.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — route URL reference.
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — route URL reference.
    - [`dashboard/components/support-desk.tsx`](../dashboard/components/support-desk.tsx) — route URL reference.
    - [`dashboard/tests/member-features-security.test.ts`](../dashboard/tests/member-features-security.test.ts) — import, route URL reference.
  - **Outside modules:** `next/server`.

### `dashboard/app/dashboard/`

- [`page.tsx`](../dashboard/app/dashboard/page.tsx) — Member workspace page wrapping MemberPortal.
  - **References:**
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
  - **Referenced by:**
    - [`dashboard/app/layout.tsx`](../dashboard/app/layout.tsx) — Next.js wraps page.

### `dashboard/app/login/`

- [`page.tsx`](../dashboard/app/login/page.tsx) — Login page and existing-session redirect.
  - **References:**
    - [`dashboard/components/auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — import.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/layout.tsx`](../dashboard/app/layout.tsx) — Next.js wraps page.
  - **Outside modules:** `lucide-react`, `next/navigation`, `react`.

### `dashboard/app/support/`

- [`page.tsx`](../dashboard/app/support/page.tsx) — Member support page and sign-in/role redirect.
  - **References:**
    - [`dashboard/components/support-desk.tsx`](../dashboard/components/support-desk.tsx) — import.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/layout.tsx`](../dashboard/app/layout.tsx) — Next.js wraps page.
  - **Outside modules:** `lucide-react`, `next/navigation`, `react`.

### `dashboard/components/`

- [`account-modal.tsx`](../dashboard/components/account-modal.tsx) — Account/profile modal.
  - **References:**
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
  - **Outside modules:** `lucide-react`, `react`.

- [`admin-console.tsx`](../dashboard/components/admin-console.tsx) — Owner workspace controller and page composition.
  - **References:**
    - [`dashboard/app/api/admin/activity/route.ts`](../dashboard/app/api/admin/activity/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/approvals/route.ts`](../dashboard/app/api/admin/approvals/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/members/route.ts`](../dashboard/app/api/admin/members/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/members/scribd/route.ts`](../dashboard/app/api/admin/members/scribd/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/pair/route.ts`](../dashboard/app/api/admin/pair/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/panel/route.ts`](../dashboard/app/api/admin/panel/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/panel/status/route.ts`](../dashboard/app/api/admin/panel/status/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/settings/route.ts`](../dashboard/app/api/admin/settings/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/status/route.ts`](../dashboard/app/api/admin/status/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/users/[number]/route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/users/[number]/sync/route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/sync/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/users/route.ts`](../dashboard/app/api/admin/users/route.ts) — route URL reference.
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/status/route.ts`](../dashboard/app/api/scribd/status/route.ts) — route URL reference.
    - [`dashboard/app/api/support/route.ts`](../dashboard/app/api/support/route.ts) — route URL reference.
    - [`dashboard/components/account-modal.tsx`](../dashboard/components/account-modal.tsx) — import.
    - [`dashboard/components/control-room-activity.tsx`](../dashboard/components/control-room-activity.tsx) — import.
    - [`dashboard/components/control-room-home.tsx`](../dashboard/components/control-room-home.tsx) — import.
    - [`dashboard/components/live-analytics.tsx`](../dashboard/components/live-analytics.tsx) — import.
    - [`dashboard/components/member-command-controls.tsx`](../dashboard/components/member-command-controls.tsx) — import.
    - [`dashboard/components/pairing-code-banner.tsx`](../dashboard/components/pairing-code-banner.tsx) — import.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — import.
    - [`dashboard/components/section-nav.tsx`](../dashboard/components/section-nav.tsx) — import.
    - [`dashboard/components/support-desk.tsx`](../dashboard/components/support-desk.tsx) — import.
    - [`dashboard/components/use-room-alert-reads.ts`](../dashboard/components/use-room-alert-reads.ts) — import.
    - [`dashboard/components/workspace-shell.tsx`](../dashboard/components/workspace-shell.tsx) — import.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
    - [`dashboard/lib/control-room.ts`](../dashboard/lib/control-room.ts) — import.
    - [`dashboard/lib/room-alert-reads.ts`](../dashboard/lib/room-alert-reads.ts) — import.
    - [`dashboard/lib/scribd-types.ts`](../dashboard/lib/scribd-types.ts) — type import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — import.
    - [`dashboard/lib/whatsapp-accounts.ts`](../dashboard/lib/whatsapp-accounts.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/admin/page.tsx`](../dashboard/app/admin/page.tsx) — import.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — import.
  - **Outside modules:** `lucide-react`, `next/navigation`, `react`.

- [`auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — Sign-in, registration, verification, and password-reset interface.
  - **References:**
    - [`dashboard/app/api/auth/forgot-password/route.ts`](../dashboard/app/api/auth/forgot-password/route.ts) — route URL reference.
    - [`dashboard/app/api/auth/login/route.ts`](../dashboard/app/api/auth/login/route.ts) — route URL reference.
    - [`dashboard/app/api/auth/register/route.ts`](../dashboard/app/api/auth/register/route.ts) — route URL reference.
    - [`dashboard/app/api/auth/resend/route.ts`](../dashboard/app/api/auth/resend/route.ts) — route URL reference.
    - [`dashboard/app/api/auth/reset-password/route.ts`](../dashboard/app/api/auth/reset-password/route.ts) — route URL reference.
    - [`dashboard/app/api/auth/verify/route.ts`](../dashboard/app/api/auth/verify/route.ts) — route URL reference.
    - [`dashboard/components/zafar-robot.tsx`](../dashboard/components/zafar-robot.tsx) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/login/page.tsx`](../dashboard/app/login/page.tsx) — import.
    - [`dashboard/tests/auth-screen.test.tsx`](../dashboard/tests/auth-screen.test.tsx) — import.
  - **Outside modules:** `lucide-react`, `react`.

- [`command-directory.tsx`](../dashboard/components/command-directory.tsx) — Searchable categorized list of WhatsApp commands.
  - **References:**
    - [`dashboard/lib/bot-data.ts`](../dashboard/lib/bot-data.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
  - **Outside modules:** `lucide-react`, `react`.

- [`control-room-activity.tsx`](../dashboard/components/control-room-activity.tsx) — Owner activity and alert views.
  - **References:**
    - [`dashboard/components/section-nav.tsx`](../dashboard/components/section-nav.tsx) — import.
    - [`dashboard/lib/control-room.ts`](../dashboard/lib/control-room.ts) — type import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
    - [`dashboard/lib/whatsapp-accounts.ts`](../dashboard/lib/whatsapp-accounts.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
  - **Outside modules:** `lucide-react`, `react`.

- [`control-room-home.tsx`](../dashboard/components/control-room-home.tsx) — Owner overview and workspace shortcuts.
  - **References:**
    - [`dashboard/lib/control-room.ts`](../dashboard/lib/control-room.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
  - **Outside modules:** `lucide-react`.

- [`live-analytics.tsx`](../dashboard/components/live-analytics.tsx) — Live service analytics presentation.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
  - **Outside modules:** `lucide-react`, `react`.

- [`media-vault-desk.tsx`](../dashboard/components/media-vault-desk.tsx) — Owner media/vault interface.
  - **References:**
    - [`dashboard/components/section-nav.tsx`](../dashboard/components/section-nav.tsx) — import.
    - [`dashboard/lib/bot-data.ts`](../dashboard/lib/bot-data.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
  - **Outside modules:** `lucide-react`, `react`.

- [`member-command-controls.tsx`](../dashboard/components/member-command-controls.tsx) — Owner controls for member command availability.
  - **References:**
    - [`dashboard/app/api/admin/commands/route.ts`](../dashboard/app/api/admin/commands/route.ts) — route URL reference.
    - [`dashboard/lib/bot-data.ts`](../dashboard/lib/bot-data.ts) — import.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
  - **Referenced by:**
    - [`dashboard/tests/member-command-controls.test.tsx`](../dashboard/tests/member-command-controls.test.tsx) — import.
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
  - **Outside modules:** `lucide-react`, `react`.

- [`member-connection.tsx`](../dashboard/components/member-connection.tsx) — Member account connection, linking, pairing, and approval interface.
  - **References:**
    - [`dashboard/app/api/member/numbers/route.ts`](../dashboard/app/api/member/numbers/route.ts) — route URL reference.
    - [`dashboard/app/api/member/pair/route.ts`](../dashboard/app/api/member/pair/route.ts) — route URL reference.
    - [`dashboard/app/api/member/status/route.ts`](../dashboard/app/api/member/status/route.ts) — route URL reference.
    - [`dashboard/app/api/member/unlink/route.ts`](../dashboard/app/api/member/unlink/route.ts) — route URL reference.
    - [`dashboard/app/api/support/route.ts`](../dashboard/app/api/support/route.ts) — route URL reference.
    - [`dashboard/components/zafar-robot.tsx`](../dashboard/components/zafar-robot.tsx) — import.
    - [`dashboard/lib/bot-data.ts`](../dashboard/lib/bot-data.ts) — import.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
    - [`dashboard/lib/member-link.ts`](../dashboard/lib/member-link.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
  - **Outside modules:** `lucide-react`, `next/navigation`, `react`.

- [`member-home.tsx`](../dashboard/components/member-home.tsx) — Member workspace home.
  - **References:**
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
    - [`dashboard/tests/member-home.test.tsx`](../dashboard/tests/member-home.test.tsx) — import.
  - **Outside modules:** `lucide-react`.

- [`member-portal.tsx`](../dashboard/components/member-portal.tsx) — Member workspace controller and navigation.
  - **References:**
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — route URL reference.
    - [`dashboard/app/api/member/numbers/[number]/route.ts`](../dashboard/app/api/member/numbers/%5Bnumber%5D/route.ts) — route URL reference.
    - [`dashboard/app/api/member/numbers/route.ts`](../dashboard/app/api/member/numbers/route.ts) — route URL reference.
    - [`dashboard/app/api/member/pair/route.ts`](../dashboard/app/api/member/pair/route.ts) — route URL reference.
    - [`dashboard/app/api/member/status/route.ts`](../dashboard/app/api/member/status/route.ts) — route URL reference.
    - [`dashboard/components/account-modal.tsx`](../dashboard/components/account-modal.tsx) — import.
    - [`dashboard/components/command-directory.tsx`](../dashboard/components/command-directory.tsx) — import.
    - [`dashboard/components/live-analytics.tsx`](../dashboard/components/live-analytics.tsx) — import.
    - [`dashboard/components/media-vault-desk.tsx`](../dashboard/components/media-vault-desk.tsx) — import.
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — import.
    - [`dashboard/components/member-home.tsx`](../dashboard/components/member-home.tsx) — import.
    - [`dashboard/components/pairing-code-banner.tsx`](../dashboard/components/pairing-code-banner.tsx) — import.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — import.
    - [`dashboard/components/workspace-shell.tsx`](../dashboard/components/workspace-shell.tsx) — import.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — import.
    - [`dashboard/lib/whatsapp-accounts.ts`](../dashboard/lib/whatsapp-accounts.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/dashboard/page.tsx`](../dashboard/app/dashboard/page.tsx) — import.
    - [`dashboard/tests/member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — import.
    - [`dashboard/tests/member-scribd-navigation.test.tsx`](../dashboard/tests/member-scribd-navigation.test.tsx) — import.
  - **Outside modules:** `lucide-react`, `next/navigation`, `react`.

- [`pairing-code-banner.tsx`](../dashboard/components/pairing-code-banner.tsx) — Displays pairing code and timing feedback.
  - **References:**
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
    - [`dashboard/tests/pairing-code-banner.test.tsx`](../dashboard/tests/pairing-code-banner.test.tsx) — import.
  - **Outside modules:** `lucide-react`, `react`.

- [`scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — Scribd search, shared queue, file, and download interface.
  - **References:**
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/clear/route.ts`](../dashboard/app/api/scribd/clear/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/file-ticket/route.ts`](../dashboard/app/api/scribd/file-ticket/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/find/route.ts`](../dashboard/app/api/scribd/find/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/reset/route.ts`](../dashboard/app/api/scribd/reset/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/run/route.ts`](../dashboard/app/api/scribd/run/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/status/route.ts`](../dashboard/app/api/scribd/status/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/thumb/route.ts`](../dashboard/app/api/scribd/thumb/route.ts) — route URL reference.
    - [`dashboard/components/section-nav.tsx`](../dashboard/components/section-nav.tsx) — import.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
    - [`dashboard/lib/control-room.ts`](../dashboard/lib/control-room.ts) — type import.
    - [`dashboard/lib/scribd-job.ts`](../dashboard/lib/scribd-job.ts) — import.
    - [`dashboard/lib/scribd-search.ts`](../dashboard/lib/scribd-search.ts) — import.
    - [`dashboard/lib/scribd-types.ts`](../dashboard/lib/scribd-types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — test mock.
    - [`dashboard/tests/member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — test mock.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — import.
  - **Outside modules:** `lucide-react`, `react`.

- [`section-nav.tsx`](../dashboard/components/section-nav.tsx) — Shared section navigation.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/control-room-activity.tsx`](../dashboard/components/control-room-activity.tsx) — import.
    - [`dashboard/components/media-vault-desk.tsx`](../dashboard/components/media-vault-desk.tsx) — import.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — import.

- [`support-desk.tsx`](../dashboard/components/support-desk.tsx) — Private owner/member support messaging interface.
  - **References:**
    - [`dashboard/app/api/support/route.ts`](../dashboard/app/api/support/route.ts) — route URL reference.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — type import.
  - **Referenced by:**
    - [`dashboard/app/support/page.tsx`](../dashboard/app/support/page.tsx) — import.
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/tests/support-desk.test.tsx`](../dashboard/tests/support-desk.test.tsx) — import.
  - **Outside modules:** `lucide-react`, `react`.

- [`use-room-alert-reads.ts`](../dashboard/components/use-room-alert-reads.ts) — Client hook for tracking which owner alerts have been opened.
  - **References:**
    - [`dashboard/lib/control-room.ts`](../dashboard/lib/control-room.ts) — type import.
    - [`dashboard/lib/room-alert-reads.ts`](../dashboard/lib/room-alert-reads.ts) — import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
  - **Outside modules:** `react`.

- [`workspace-shell.tsx`](../dashboard/components/workspace-shell.tsx) — Responsive workspace navigation shell.
  - **References:**
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
    - [`dashboard/tests/workspace-shell.test.tsx`](../dashboard/tests/workspace-shell.test.tsx) — import.
  - **Outside modules:** `lucide-react`, `next/link`, `react`.

- [`zafar-robot.tsx`](../dashboard/components/zafar-robot.tsx) — Animated robot visual component.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/components/auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — import.
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — import.
    - [`dashboard/tests/zafar-robot.test.tsx`](../dashboard/tests/zafar-robot.test.tsx) — import.
  - **Outside modules:** `react`.

### `dashboard/lib/`

- [`activity.ts`](../dashboard/lib/activity.ts) — Records control-room events without exposing sensitive action details.
  - **References:**
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/app/api/admin/approvals/route.ts`](../dashboard/app/api/admin/approvals/route.ts) — import.
    - [`dashboard/app/api/admin/commands/route.ts`](../dashboard/app/api/admin/commands/route.ts) — import.
    - [`dashboard/app/api/admin/members/route.ts`](../dashboard/app/api/admin/members/route.ts) — import.
    - [`dashboard/app/api/admin/members/scribd/route.ts`](../dashboard/app/api/admin/members/scribd/route.ts) — import.
    - [`dashboard/app/api/admin/pair/route.ts`](../dashboard/app/api/admin/pair/route.ts) — import.
    - [`dashboard/app/api/admin/panel/route.ts`](../dashboard/app/api/admin/panel/route.ts) — import.
    - [`dashboard/app/api/admin/settings/route.ts`](../dashboard/app/api/admin/settings/route.ts) — import.
    - [`dashboard/app/api/admin/users/[number]/route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/route.ts) — import.
    - [`dashboard/app/api/admin/users/[number]/sync/route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/sync/route.ts) — import.
    - [`dashboard/app/api/admin/users/route.ts`](../dashboard/app/api/admin/users/route.ts) — import.
    - [`dashboard/app/api/auth/login/route.ts`](../dashboard/app/api/auth/login/route.ts) — import.
    - [`dashboard/app/api/auth/verify/route.ts`](../dashboard/app/api/auth/verify/route.ts) — import.
    - [`dashboard/app/api/member/numbers/[number]/route.ts`](../dashboard/app/api/member/numbers/%5Bnumber%5D/route.ts) — import.
    - [`dashboard/app/api/member/numbers/route.ts`](../dashboard/app/api/member/numbers/route.ts) — import.
    - [`dashboard/app/api/member/pair/route.ts`](../dashboard/app/api/member/pair/route.ts) — import.
    - [`dashboard/app/api/member/unlink/route.ts`](../dashboard/app/api/member/unlink/route.ts) — import.
    - [`dashboard/app/api/scribd/clear/route.ts`](../dashboard/app/api/scribd/clear/route.ts) — import.
    - [`dashboard/app/api/scribd/reset/route.ts`](../dashboard/app/api/scribd/reset/route.ts) — import.
    - [`dashboard/app/api/scribd/run/route.ts`](../dashboard/app/api/scribd/run/route.ts) — import.
    - [`dashboard/tests/auth-security.test.ts`](../dashboard/tests/auth-security.test.ts) — test mock.
    - [`dashboard/tests/control-room-security.test.ts`](../dashboard/tests/control-room-security.test.ts) — test mock.
    - [`dashboard/tests/control-room-storage.test.ts`](../dashboard/tests/control-room-storage.test.ts) — import.
    - [`dashboard/tests/member-features-security.test.ts`](../dashboard/tests/member-features-security.test.ts) — test mock.
    - [`dashboard/tests/member-link-api.test.ts`](../dashboard/tests/member-link-api.test.ts) — test mock.
    - [`dashboard/tests/pairing-security.test.ts`](../dashboard/tests/pairing-security.test.ts) — test mock.
    - [`dashboard/tests/panel-route.test.ts`](../dashboard/tests/panel-route.test.ts) — test mock.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — test mock.

- [`auth-engine.ts`](../dashboard/lib/auth-engine.ts) — Account registration, sign-in, verification, sessions, and role checks.
  - **References:**
    - [`dashboard/lib/email-service.ts`](../dashboard/lib/email-service.ts) — import.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — import.
  - **Referenced by:**
    - [`dashboard/.env.example`](../dashboard/.env.example) — explicit relationship.
    - [`dashboard/app/api/admin/activity/route.ts`](../dashboard/app/api/admin/activity/route.ts) — import.
    - [`dashboard/app/api/admin/approvals/route.ts`](../dashboard/app/api/admin/approvals/route.ts) — import.
    - [`dashboard/app/api/admin/commands/route.ts`](../dashboard/app/api/admin/commands/route.ts) — import.
    - [`dashboard/app/api/admin/members/route.ts`](../dashboard/app/api/admin/members/route.ts) — import.
    - [`dashboard/app/api/admin/members/scribd/route.ts`](../dashboard/app/api/admin/members/scribd/route.ts) — import.
    - [`dashboard/app/api/admin/pair/route.ts`](../dashboard/app/api/admin/pair/route.ts) — import.
    - [`dashboard/app/api/admin/panel/route.ts`](../dashboard/app/api/admin/panel/route.ts) — import.
    - [`dashboard/app/api/admin/panel/status/route.ts`](../dashboard/app/api/admin/panel/status/route.ts) — import.
    - [`dashboard/app/api/admin/settings/route.ts`](../dashboard/app/api/admin/settings/route.ts) — import.
    - [`dashboard/app/api/admin/status/route.ts`](../dashboard/app/api/admin/status/route.ts) — import.
    - [`dashboard/app/api/admin/users/[number]/route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/route.ts) — import.
    - [`dashboard/app/api/admin/users/[number]/sync/route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/sync/route.ts) — import.
    - [`dashboard/app/api/admin/users/route.ts`](../dashboard/app/api/admin/users/route.ts) — import.
    - [`dashboard/app/api/auth/forgot-password/route.ts`](../dashboard/app/api/auth/forgot-password/route.ts) — import.
    - [`dashboard/app/api/auth/login/route.ts`](../dashboard/app/api/auth/login/route.ts) — import.
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — import.
    - [`dashboard/app/api/auth/register/route.ts`](../dashboard/app/api/auth/register/route.ts) — import.
    - [`dashboard/app/api/auth/resend/route.ts`](../dashboard/app/api/auth/resend/route.ts) — import.
    - [`dashboard/app/api/auth/reset-password/route.ts`](../dashboard/app/api/auth/reset-password/route.ts) — import.
    - [`dashboard/app/api/auth/verify/route.ts`](../dashboard/app/api/auth/verify/route.ts) — import.
    - [`dashboard/app/api/bot/sync/route.ts`](../dashboard/app/api/bot/sync/route.ts) — import.
    - [`dashboard/app/api/member/numbers/[number]/route.ts`](../dashboard/app/api/member/numbers/%5Bnumber%5D/route.ts) — import.
    - [`dashboard/app/api/member/numbers/route.ts`](../dashboard/app/api/member/numbers/route.ts) — import.
    - [`dashboard/app/api/member/pair/route.ts`](../dashboard/app/api/member/pair/route.ts) — import.
    - [`dashboard/app/api/member/status/route.ts`](../dashboard/app/api/member/status/route.ts) — import.
    - [`dashboard/app/api/member/unlink/route.ts`](../dashboard/app/api/member/unlink/route.ts) — import.
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — import.
    - [`dashboard/app/api/support/route.ts`](../dashboard/app/api/support/route.ts) — import.
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/tests/admin-route-authorization.test.ts`](../dashboard/tests/admin-route-authorization.test.ts) — test mock.
    - [`dashboard/tests/auth-security.test.ts`](../dashboard/tests/auth-security.test.ts) — import.
    - [`dashboard/tests/control-room-security.test.ts`](../dashboard/tests/control-room-security.test.ts) — test mock.
    - [`dashboard/tests/member-features-security.test.ts`](../dashboard/tests/member-features-security.test.ts) — test mock.
    - [`dashboard/tests/member-link-api.test.ts`](../dashboard/tests/member-link-api.test.ts) — test mock.
    - [`dashboard/tests/pairing-security.test.ts`](../dashboard/tests/pairing-security.test.ts) — test mock.
    - [`dashboard/tests/panel-route.test.ts`](../dashboard/tests/panel-route.test.ts) — test mock.
    - [`dashboard/tests/panel-status.test.ts`](../dashboard/tests/panel-status.test.ts) — test mock.
    - [`dashboard/tests/scribd-download-ticket.test.ts`](../dashboard/tests/scribd-download-ticket.test.ts) — test mock.
    - [`dashboard/tests/scribd-panel.test.ts`](../dashboard/tests/scribd-panel.test.ts) — test mock.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — test mock.
    - [`dashboard/tests/whatsapp-status-privacy.test.ts`](../dashboard/tests/whatsapp-status-privacy.test.ts) — test mock.
  - **Outside modules:** `bcryptjs`, `next/server`, `node:crypto`.

- [`bot-data.ts`](../dashboard/lib/bot-data.ts) — Bot-facing dashboard data normalization and models.
  - **References:**
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — import.
  - **Referenced by:**
    - [`dashboard/tests/member-command-controls.test.tsx`](../dashboard/tests/member-command-controls.test.tsx) — import.
    - [`dashboard/app/api/admin/commands/route.ts`](../dashboard/app/api/admin/commands/route.ts) — import.
    - [`dashboard/components/command-directory.tsx`](../dashboard/components/command-directory.tsx) — import.
    - [`dashboard/components/media-vault-desk.tsx`](../dashboard/components/media-vault-desk.tsx) — import.
    - [`dashboard/components/member-command-controls.tsx`](../dashboard/components/member-command-controls.tsx) — import.
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — import.

- [`bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — Dashboard-to-bot HTTP proxy and queued-command fallback.
  - **References:**
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
    - [`dashboard/lib/whatsapp-accounts.ts`](../dashboard/lib/whatsapp-accounts.ts) — import.
    - [`Whatsapp bot/utils/adminApi.js`](../Whatsapp%20bot/utils/adminApi.js) — optional HTTP API.
  - **Referenced by:**
    - [`dashboard/.env.example`](../dashboard/.env.example) — explicit relationship.
    - [`dashboard/app/api/admin/approvals/route.ts`](../dashboard/app/api/admin/approvals/route.ts) — import.
    - [`dashboard/app/api/admin/members/route.ts`](../dashboard/app/api/admin/members/route.ts) — import.
    - [`dashboard/app/api/admin/pair/route.ts`](../dashboard/app/api/admin/pair/route.ts) — import.
    - [`dashboard/app/api/admin/settings/route.ts`](../dashboard/app/api/admin/settings/route.ts) — import.
    - [`dashboard/app/api/admin/status/route.ts`](../dashboard/app/api/admin/status/route.ts) — import.
    - [`dashboard/app/api/admin/users/[number]/route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/route.ts) — import.
    - [`dashboard/app/api/admin/users/[number]/sync/route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/sync/route.ts) — import.
    - [`dashboard/app/api/admin/users/route.ts`](../dashboard/app/api/admin/users/route.ts) — import.
    - [`dashboard/app/api/member/numbers/[number]/route.ts`](../dashboard/app/api/member/numbers/%5Bnumber%5D/route.ts) — import.
    - [`dashboard/app/api/member/numbers/route.ts`](../dashboard/app/api/member/numbers/route.ts) — import.
    - [`dashboard/app/api/member/pair/route.ts`](../dashboard/app/api/member/pair/route.ts) — import.
    - [`dashboard/app/api/member/status/route.ts`](../dashboard/app/api/member/status/route.ts) — import.
    - [`dashboard/app/api/member/unlink/route.ts`](../dashboard/app/api/member/unlink/route.ts) — import.
    - [`dashboard/tests/member-features-security.test.ts`](../dashboard/tests/member-features-security.test.ts) — test mock.
    - [`dashboard/tests/member-link-api.test.ts`](../dashboard/tests/member-link-api.test.ts) — test mock.
    - [`dashboard/tests/whatsapp-bridge.test.ts`](../dashboard/tests/whatsapp-bridge.test.ts) — import.
    - [`dashboard/tests/whatsapp-status-privacy.test.ts`](../dashboard/tests/whatsapp-status-privacy.test.ts) — test mock.

- [`bot-sync-auth.ts`](../dashboard/lib/bot-sync-auth.ts) — Authenticates bot-to-dashboard requests and validates optional HMAC/replay fields.
  - **References:**
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/api/bot/session-backups/route.ts`](../dashboard/app/api/bot/session-backups/route.ts) — import.
    - [`dashboard/app/api/bot/sync/route.ts`](../dashboard/app/api/bot/sync/route.ts) — import.
    - [`dashboard/app/api/bot/whitelist/route.ts`](../dashboard/app/api/bot/whitelist/route.ts) — import.
    - [`dashboard/tests/session-backup-api.test.ts`](../dashboard/tests/session-backup-api.test.ts) — test mock.
  - **Outside modules:** `next/server`, `node:crypto`.

- [`client-session.ts`](../dashboard/lib/client-session.ts) — Browser session token management and authenticated fetch helpers.
  - **References:**
    - [`dashboard/app/api/auth/logout/route.ts`](../dashboard/app/api/auth/logout/route.ts) — route URL reference.
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — route URL reference.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/login/page.tsx`](../dashboard/app/login/page.tsx) — import.
    - [`dashboard/app/page.tsx`](../dashboard/app/page.tsx) — import.
    - [`dashboard/app/support/page.tsx`](../dashboard/app/support/page.tsx) — import.
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/member-command-controls.tsx`](../dashboard/components/member-command-controls.tsx) — import.
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — import.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — import.
    - [`dashboard/components/support-desk.tsx`](../dashboard/components/support-desk.tsx) — import.
    - [`dashboard/tests/admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — import.
    - [`dashboard/tests/client-session.test.ts`](../dashboard/tests/client-session.test.ts) — dynamic import.
    - [`dashboard/tests/member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — import.
    - [`dashboard/tests/member-scribd-navigation.test.tsx`](../dashboard/tests/member-scribd-navigation.test.tsx) — import.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — import.

- [`control-room.ts`](../dashboard/lib/control-room.ts) — Owner navigation, summary, and alert derivation.
  - **References:**
    - [`dashboard/lib/scribd-types.ts`](../dashboard/lib/scribd-types.ts) — type import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/control-room-activity.tsx`](../dashboard/components/control-room-activity.tsx) — type import.
    - [`dashboard/components/control-room-home.tsx`](../dashboard/components/control-room-home.tsx) — import.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — type import.
    - [`dashboard/components/use-room-alert-reads.ts`](../dashboard/components/use-room-alert-reads.ts) — type import.
    - [`dashboard/lib/room-alert-reads.ts`](../dashboard/lib/room-alert-reads.ts) — type import.
    - [`dashboard/tests/control-room-alerts.test.ts`](../dashboard/tests/control-room-alerts.test.ts) — import.
    - [`dashboard/tests/room-alert-reads.test.ts`](../dashboard/tests/room-alert-reads.test.ts) — import.

- [`email-service.ts`](../dashboard/lib/email-service.ts) — Email delivery for authentication and verification flows.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/.env.example`](../dashboard/.env.example) — explicit relationship.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/tests/auth-security.test.ts`](../dashboard/tests/auth-security.test.ts) — test mock.
    - [`dashboard/tests/email-branding.test.ts`](../dashboard/tests/email-branding.test.ts) — import.
  - **Outside modules:** `nodemailer`.

- [`jwt.ts`](../dashboard/lib/jwt.ts) — JWT signing, verification, and production-secret handling.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/app/api/admin/panel/route.ts`](../dashboard/app/api/admin/panel/route.ts) — import.
    - [`dashboard/app/api/admin/status/route.ts`](../dashboard/app/api/admin/status/route.ts) — import.
    - [`dashboard/app/api/auth/login/route.ts`](../dashboard/app/api/auth/login/route.ts) — import.
    - [`dashboard/app/api/auth/logout/route.ts`](../dashboard/app/api/auth/logout/route.ts) — import.
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — import.
    - [`dashboard/app/api/auth/verify/route.ts`](../dashboard/app/api/auth/verify/route.ts) — import.
    - [`dashboard/app/api/member/status/route.ts`](../dashboard/app/api/member/status/route.ts) — import.
    - [`dashboard/app/api/scribd/file-ticket/route.ts`](../dashboard/app/api/scribd/file-ticket/route.ts) — import.
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/scribd-download-ticket.ts`](../dashboard/lib/scribd-download-ticket.ts) — import.
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — import.
    - [`dashboard/tests/auth-security.test.ts`](../dashboard/tests/auth-security.test.ts) — import.
  - **Outside modules:** `next/server`, `node:crypto`.

- [`member-link.ts`](../dashboard/lib/member-link.ts) — Member phone normalization, pairing, and account-link helpers.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — import.
    - [`dashboard/tests/member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — import.

- [`panel-client.ts`](../dashboard/lib/panel-client.ts) — Optional panel hosting API client.
  - **References:**
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/api/admin/panel/route.ts`](../dashboard/app/api/admin/panel/route.ts) — import.
    - [`dashboard/app/api/admin/panel/status/route.ts`](../dashboard/app/api/admin/panel/status/route.ts) — import.
    - [`dashboard/tests/panel-client.test.ts`](../dashboard/tests/panel-client.test.ts) — import.
    - [`dashboard/tests/panel-route.test.ts`](../dashboard/tests/panel-route.test.ts) — test mock.

- [`rate-limit.ts`](../dashboard/lib/rate-limit.ts) — In-process request rate limiting.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/app/api/auth/login/route.ts`](../dashboard/app/api/auth/login/route.ts) — import.
    - [`dashboard/app/api/auth/register/route.ts`](../dashboard/app/api/auth/register/route.ts) — import.
    - [`dashboard/app/api/bot/sync/route.ts`](../dashboard/app/api/bot/sync/route.ts) — import.
    - [`dashboard/app/api/bot/whitelist/route.ts`](../dashboard/app/api/bot/whitelist/route.ts) — import.
  - **Outside modules:** `next/server`.

- [`room-alert-reads.ts`](../dashboard/lib/room-alert-reads.ts) — Pure alert/read-state logic.
  - **References:**
    - [`dashboard/lib/control-room.ts`](../dashboard/lib/control-room.ts) — type import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/use-room-alert-reads.ts`](../dashboard/components/use-room-alert-reads.ts) — import.
    - [`dashboard/tests/room-alert-reads.test.ts`](../dashboard/tests/room-alert-reads.test.ts) — import.

- [`scribd-config.ts`](../dashboard/lib/scribd-config.ts) — Built-in HTTPS address of the selected Scribd service.
  - **References:**
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — configured external service.
  - **Referenced by:**
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import, re-export.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/tests/scribd-config.test.ts`](../dashboard/tests/scribd-config.test.ts) — import.
    - [`dashboard/tests/scribd-panel.test.ts`](../dashboard/tests/scribd-panel.test.ts) — test mock.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — test mock.

- [`scribd-download-ticket.ts`](../dashboard/lib/scribd-download-ticket.ts) — Short-lived filename-scoped PDF download tickets.
  - **References:**
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — route URL reference.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
  - **Referenced by:**
    - [`dashboard/app/api/scribd/file-ticket/route.ts`](../dashboard/app/api/scribd/file-ticket/route.ts) — import.
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — import.
    - [`dashboard/tests/auth-security.test.ts`](../dashboard/tests/auth-security.test.ts) — import.
    - [`dashboard/tests/scribd-download-ticket.test.ts`](../dashboard/tests/scribd-download-ticket.test.ts) — import.
  - **Outside modules:** `node:crypto`.

- [`scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — Common owner/member authorization gate for Scribd routes.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/app/api/scribd/clear/route.ts`](../dashboard/app/api/scribd/clear/route.ts) — import.
    - [`dashboard/app/api/scribd/config/route.ts`](../dashboard/app/api/scribd/config/route.ts) — import.
    - [`dashboard/app/api/scribd/file-ticket/route.ts`](../dashboard/app/api/scribd/file-ticket/route.ts) — import.
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — import.
    - [`dashboard/app/api/scribd/files/route.ts`](../dashboard/app/api/scribd/files/route.ts) — import.
    - [`dashboard/app/api/scribd/find/route.ts`](../dashboard/app/api/scribd/find/route.ts) — import.
    - [`dashboard/app/api/scribd/link/route.ts`](../dashboard/app/api/scribd/link/route.ts) — import.
    - [`dashboard/app/api/scribd/reset/route.ts`](../dashboard/app/api/scribd/reset/route.ts) — import.
    - [`dashboard/app/api/scribd/run/route.ts`](../dashboard/app/api/scribd/run/route.ts) — import.
    - [`dashboard/app/api/scribd/status/route.ts`](../dashboard/app/api/scribd/status/route.ts) — import.
    - [`dashboard/app/api/scribd/thumb/route.ts`](../dashboard/app/api/scribd/thumb/route.ts) — import.
  - **Outside modules:** `next/server`.

- [`scribd-job.ts`](../dashboard/lib/scribd-job.ts) — Scribd job/file normalization and safe PDF names.
  - **References:**
    - [`dashboard/lib/scribd-types.ts`](../dashboard/lib/scribd-types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import, re-export.

- [`scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — Server-only HTTP adapter for the separate Scribd web service.
  - **References:**
    - [`dashboard/lib/scribd-config.ts`](../dashboard/lib/scribd-config.ts) — import, re-export.
    - [`dashboard/lib/scribd-job.ts`](../dashboard/lib/scribd-job.ts) — import, re-export.
    - [`dashboard/lib/scribd-search.ts`](../dashboard/lib/scribd-search.ts) — import.
    - [`dashboard/lib/scribd-types.ts`](../dashboard/lib/scribd-types.ts) — type import.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — HTTP API contract.
  - **Referenced by:**
    - [`dashboard/.env.example`](../dashboard/.env.example) — explicit relationship.
    - [`dashboard/app/api/admin/status/route.ts`](../dashboard/app/api/admin/status/route.ts) — import.
    - [`dashboard/app/api/scribd/clear/route.ts`](../dashboard/app/api/scribd/clear/route.ts) — import.
    - [`dashboard/app/api/scribd/config/route.ts`](../dashboard/app/api/scribd/config/route.ts) — import.
    - [`dashboard/app/api/scribd/file-ticket/route.ts`](../dashboard/app/api/scribd/file-ticket/route.ts) — import.
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — import.
    - [`dashboard/app/api/scribd/files/route.ts`](../dashboard/app/api/scribd/files/route.ts) — import.
    - [`dashboard/app/api/scribd/find/route.ts`](../dashboard/app/api/scribd/find/route.ts) — import.
    - [`dashboard/app/api/scribd/link/route.ts`](../dashboard/app/api/scribd/link/route.ts) — import.
    - [`dashboard/app/api/scribd/reset/route.ts`](../dashboard/app/api/scribd/reset/route.ts) — import.
    - [`dashboard/app/api/scribd/run/route.ts`](../dashboard/app/api/scribd/run/route.ts) — import.
    - [`dashboard/app/api/scribd/status/route.ts`](../dashboard/app/api/scribd/status/route.ts) — import.
    - [`dashboard/app/api/scribd/thumb/route.ts`](../dashboard/app/api/scribd/thumb/route.ts) — import.
    - [`dashboard/tests/scribd-download-ticket.test.ts`](../dashboard/tests/scribd-download-ticket.test.ts) — test mock.
    - [`dashboard/tests/scribd-panel.test.ts`](../dashboard/tests/scribd-panel.test.ts) — import.
    - [`dashboard/tests/scribd-search.test.ts`](../dashboard/tests/scribd-search.test.ts) — import.

- [`scribd-search.ts`](../dashboard/lib/scribd-search.ts) — Scribd search-hit, document-link, and thumbnail validation.
  - **References:**
    - [`dashboard/lib/scribd-types.ts`](../dashboard/lib/scribd-types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
    - [`dashboard/tests/scribd-search.test.ts`](../dashboard/tests/scribd-search.test.ts) — import.

- [`scribd-types.ts`](../dashboard/lib/scribd-types.ts) — TypeScript types shared by Scribd dashboard features.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — type import.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — type import.
    - [`dashboard/lib/control-room.ts`](../dashboard/lib/control-room.ts) — type import.
    - [`dashboard/lib/scribd-job.ts`](../dashboard/lib/scribd-job.ts) — type import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — type import.
    - [`dashboard/lib/scribd-search.ts`](../dashboard/lib/scribd-search.ts) — type import.
    - [`dashboard/tests/scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — type import.

- [`storage.ts`](../dashboard/lib/storage.ts) — Dashboard persistence for accounts, permissions, queue, activity, support, recovery, and configuration.
  - **References:**
    - [`dashboard/lib/scribd-config.ts`](../dashboard/lib/scribd-config.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — import.
  - **Referenced by:**
    - [`dashboard/.env.example`](../dashboard/.env.example) — explicit relationship.
    - [`dashboard/app/api/admin/activity/route.ts`](../dashboard/app/api/admin/activity/route.ts) — import.
    - [`dashboard/app/api/admin/approvals/route.ts`](../dashboard/app/api/admin/approvals/route.ts) — import.
    - [`dashboard/app/api/admin/commands/route.ts`](../dashboard/app/api/admin/commands/route.ts) — import.
    - [`dashboard/app/api/admin/members/route.ts`](../dashboard/app/api/admin/members/route.ts) — import.
    - [`dashboard/app/api/admin/members/scribd/route.ts`](../dashboard/app/api/admin/members/scribd/route.ts) — import.
    - [`dashboard/app/api/admin/pair/route.ts`](../dashboard/app/api/admin/pair/route.ts) — import.
    - [`dashboard/app/api/admin/panel/route.ts`](../dashboard/app/api/admin/panel/route.ts) — import.
    - [`dashboard/app/api/admin/panel/status/route.ts`](../dashboard/app/api/admin/panel/status/route.ts) — import.
    - [`dashboard/app/api/admin/settings/route.ts`](../dashboard/app/api/admin/settings/route.ts) — import.
    - [`dashboard/app/api/admin/status/route.ts`](../dashboard/app/api/admin/status/route.ts) — import.
    - [`dashboard/app/api/admin/users/[number]/route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/route.ts) — import.
    - [`dashboard/app/api/admin/users/[number]/sync/route.ts`](../dashboard/app/api/admin/users/%5Bnumber%5D/sync/route.ts) — import.
    - [`dashboard/app/api/admin/users/route.ts`](../dashboard/app/api/admin/users/route.ts) — import.
    - [`dashboard/app/api/bot/session-backups/route.ts`](../dashboard/app/api/bot/session-backups/route.ts) — import.
    - [`dashboard/app/api/bot/sync/route.ts`](../dashboard/app/api/bot/sync/route.ts) — import.
    - [`dashboard/app/api/bot/whitelist/route.ts`](../dashboard/app/api/bot/whitelist/route.ts) — import.
    - [`dashboard/app/api/member/numbers/[number]/route.ts`](../dashboard/app/api/member/numbers/%5Bnumber%5D/route.ts) — import.
    - [`dashboard/app/api/member/numbers/route.ts`](../dashboard/app/api/member/numbers/route.ts) — import.
    - [`dashboard/app/api/member/pair/route.ts`](../dashboard/app/api/member/pair/route.ts) — import.
    - [`dashboard/app/api/member/status/route.ts`](../dashboard/app/api/member/status/route.ts) — import.
    - [`dashboard/app/api/member/unlink/route.ts`](../dashboard/app/api/member/unlink/route.ts) — import.
    - [`dashboard/app/api/support/route.ts`](../dashboard/app/api/support/route.ts) — import.
    - [`dashboard/components/support-desk.tsx`](../dashboard/components/support-desk.tsx) — type import.
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/bot-sync-auth.ts`](../dashboard/lib/bot-sync-auth.ts) — import.
    - [`dashboard/lib/panel-client.ts`](../dashboard/lib/panel-client.ts) — import.
    - [`dashboard/lib/sync-status.ts`](../dashboard/lib/sync-status.ts) — import.
    - [`dashboard/tests/auth-security.test.ts`](../dashboard/tests/auth-security.test.ts) — type import, test mock.
    - [`dashboard/tests/control-room-security.test.ts`](../dashboard/tests/control-room-security.test.ts) — test mock.
    - [`dashboard/tests/control-room-storage.test.ts`](../dashboard/tests/control-room-storage.test.ts) — import.
    - [`dashboard/tests/d1-initialization.test.ts`](../dashboard/tests/d1-initialization.test.ts) — import.
    - [`dashboard/tests/member-features-security.test.ts`](../dashboard/tests/member-features-security.test.ts) — test mock.
    - [`dashboard/tests/member-link-api.test.ts`](../dashboard/tests/member-link-api.test.ts) — test mock.
    - [`dashboard/tests/pairing-security.test.ts`](../dashboard/tests/pairing-security.test.ts) — test mock.
    - [`dashboard/tests/panel-client.test.ts`](../dashboard/tests/panel-client.test.ts) — test mock.
    - [`dashboard/tests/panel-route.test.ts`](../dashboard/tests/panel-route.test.ts) — test mock.
    - [`dashboard/tests/panel-status.test.ts`](../dashboard/tests/panel-status.test.ts) — test mock.
    - [`dashboard/tests/scribd-config.test.ts`](../dashboard/tests/scribd-config.test.ts) — import.
    - [`dashboard/tests/scribd-panel.test.ts`](../dashboard/tests/scribd-panel.test.ts) — test mock.
    - [`dashboard/tests/scribd-search.test.ts`](../dashboard/tests/scribd-search.test.ts) — test mock.
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — test mock.
    - [`dashboard/tests/session-backup-api.test.ts`](../dashboard/tests/session-backup-api.test.ts) — test mock.
    - [`dashboard/tests/session-backup-sqlite.test.ts`](../dashboard/tests/session-backup-sqlite.test.ts) — import.
    - [`dashboard/tests/sync-status.test.ts`](../dashboard/tests/sync-status.test.ts) — import.
    - [`dashboard/tests/whatsapp-bridge.test.ts`](../dashboard/tests/whatsapp-bridge.test.ts) — test mock.
    - [`dashboard/tests/whatsapp-status-privacy.test.ts`](../dashboard/tests/whatsapp-status-privacy.test.ts) — test mock.
  - **Outside modules:** `node:crypto`, `node:fs`, `node:path`.

- [`sync-status.ts`](../dashboard/lib/sync-status.ts) — Derives bot allowlist synchronization state from heartbeats.
  - **References:**
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/app/api/admin/status/route.ts`](../dashboard/app/api/admin/status/route.ts) — import.
    - [`dashboard/app/api/member/status/route.ts`](../dashboard/app/api/member/status/route.ts) — import.
    - [`dashboard/tests/sync-status.test.ts`](../dashboard/tests/sync-status.test.ts) — import.
    - [`dashboard/tests/whatsapp-status-privacy.test.ts`](../dashboard/tests/whatsapp-status-privacy.test.ts) — test mock.

- [`types.ts`](../dashboard/lib/types.ts) — Shared dashboard data and API types.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/app/api/admin/panel/status/route.ts`](../dashboard/app/api/admin/panel/status/route.ts) — type import.
    - [`dashboard/components/account-modal.tsx`](../dashboard/components/account-modal.tsx) — import.
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — import.
    - [`dashboard/components/control-room-activity.tsx`](../dashboard/components/control-room-activity.tsx) — type import.
    - [`dashboard/components/control-room-home.tsx`](../dashboard/components/control-room-home.tsx) — type import.
    - [`dashboard/components/member-connection.tsx`](../dashboard/components/member-connection.tsx) — type import.
    - [`dashboard/components/member-home.tsx`](../dashboard/components/member-home.tsx) — type import.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
    - [`dashboard/components/pairing-code-banner.tsx`](../dashboard/components/pairing-code-banner.tsx) — import.
    - [`dashboard/components/workspace-shell.tsx`](../dashboard/components/workspace-shell.tsx) — type import.
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — type import.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/bot-data.ts`](../dashboard/lib/bot-data.ts) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — type import.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
    - [`dashboard/lib/control-room.ts`](../dashboard/lib/control-room.ts) — type import.
    - [`dashboard/lib/panel-client.ts`](../dashboard/lib/panel-client.ts) — import.
    - [`dashboard/lib/room-alert-reads.ts`](../dashboard/lib/room-alert-reads.ts) — type import.
    - [`dashboard/lib/scribd-guard.ts`](../dashboard/lib/scribd-guard.ts) — type import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/sync-status.ts`](../dashboard/lib/sync-status.ts) — type import.
    - [`dashboard/lib/whatsapp-accounts.ts`](../dashboard/lib/whatsapp-accounts.ts) — type import.
    - [`dashboard/tests/control-room-alerts.test.ts`](../dashboard/tests/control-room-alerts.test.ts) — type import.
    - [`dashboard/tests/member-home.test.tsx`](../dashboard/tests/member-home.test.tsx) — type import.
    - [`dashboard/tests/member-link-api.test.ts`](../dashboard/tests/member-link-api.test.ts) — type import.
    - [`dashboard/tests/pairing-security.test.ts`](../dashboard/tests/pairing-security.test.ts) — type import.
    - [`dashboard/tests/room-alert-reads.test.ts`](../dashboard/tests/room-alert-reads.test.ts) — type import.
    - [`dashboard/tests/scribd-download-ticket.test.ts`](../dashboard/tests/scribd-download-ticket.test.ts) — type import.
    - [`dashboard/tests/whatsapp-bridge.test.ts`](../dashboard/tests/whatsapp-bridge.test.ts) — type import.
    - [`dashboard/tests/whatsapp-status-privacy.test.ts`](../dashboard/tests/whatsapp-status-privacy.test.ts) — type import.
    - [`dashboard/tests/workspace-shell.test.tsx`](../dashboard/tests/workspace-shell.test.tsx) — type import.

- [`whatsapp-accounts.ts`](../dashboard/lib/whatsapp-accounts.ts) — Normalizes and labels account-specific WhatsApp connection state.
  - **References:**
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/app/api/bot/sync/route.ts`](../dashboard/app/api/bot/sync/route.ts) — import.
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/control-room-activity.tsx`](../dashboard/components/control-room-activity.tsx) — import.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/tests/whatsapp-bridge.test.ts`](../dashboard/tests/whatsapp-bridge.test.ts) — import.

### `dashboard/scripts/`

- [`check-prod-env.mjs`](../dashboard/scripts/check-prod-env.mjs) — Checks required production settings before the standalone dashboard server starts.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`dashboard/package.json`](../dashboard/package.json) — explicit relationship.

### `dashboard/tests/`

- [`admin-console.test.tsx`](../dashboard/tests/admin-console.test.tsx) — Vitest regression tests for admin console; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/admin/activity/route.ts`](../dashboard/app/api/admin/activity/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/members/scribd/route.ts`](../dashboard/app/api/admin/members/scribd/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/pair/route.ts`](../dashboard/app/api/admin/pair/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/panel/route.ts`](../dashboard/app/api/admin/panel/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/panel/status/route.ts`](../dashboard/app/api/admin/panel/status/route.ts) — route URL reference.
    - [`dashboard/app/api/admin/status/route.ts`](../dashboard/app/api/admin/status/route.ts) — route URL reference.
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/status/route.ts`](../dashboard/app/api/scribd/status/route.ts) — route URL reference.
    - [`dashboard/components/admin-console.tsx`](../dashboard/components/admin-console.tsx) — import.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — test mock.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `next/link`, `next/navigation`, `vitest`.

- [`admin-route-authorization.test.ts`](../dashboard/tests/admin-route-authorization.test.ts) — Vitest regression tests for admin route authorization; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `vitest`.

- [`auth-screen.test.tsx`](../dashboard/tests/auth-screen.test.tsx) — Vitest regression tests for auth screen; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/auth/login/route.ts`](../dashboard/app/api/auth/login/route.ts) — route URL reference.
    - [`dashboard/components/auth-screen.tsx`](../dashboard/components/auth-screen.tsx) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `vitest`.

- [`auth-security.test.ts`](../dashboard/tests/auth-security.test.ts) — Vitest regression tests for auth security; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — route URL reference.
    - [`dashboard/app/api/auth/verify/route.ts`](../dashboard/app/api/auth/verify/route.ts) — import, route URL reference.
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — test mock.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — import.
    - [`dashboard/lib/email-service.ts`](../dashboard/lib/email-service.ts) — test mock.
    - [`dashboard/lib/jwt.ts`](../dashboard/lib/jwt.ts) — import.
    - [`dashboard/lib/scribd-download-ticket.ts`](../dashboard/lib/scribd-download-ticket.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — type import, test mock.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `bcryptjs`, `next/server`, `node:crypto`, `vitest`.

- [`client-session.test.ts`](../dashboard/tests/client-session.test.ts) — Vitest regression tests for client session; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — route URL reference.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — dynamic import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `vitest`.

- [`control-room-alerts.test.ts`](../dashboard/tests/control-room-alerts.test.ts) — Vitest regression tests for control room alerts; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/control-room.ts`](../dashboard/lib/control-room.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `vitest`.

- [`control-room-security.test.ts`](../dashboard/tests/control-room-security.test.ts) — Vitest regression tests for control room security; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/admin/activity/route.ts`](../dashboard/app/api/admin/activity/route.ts) — import, route URL reference.
    - [`dashboard/app/api/admin/members/scribd/route.ts`](../dashboard/app/api/admin/members/scribd/route.ts) — import, route URL reference.
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — test mock.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `vitest`.

- [`control-room-storage.test.ts`](../dashboard/tests/control-room-storage.test.ts) — Vitest regression tests for control room storage; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `node:fs`, `vitest`.

- [`d1-initialization.test.ts`](../dashboard/tests/d1-initialization.test.ts) — Vitest regression tests for d1 initialization; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `vitest`.

- [`email-branding.test.ts`](../dashboard/tests/email-branding.test.ts) — Vitest regression tests for email branding; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/email-service.ts`](../dashboard/lib/email-service.ts) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `vitest`.

- [`member-command-controls.test.tsx`](../dashboard/tests/member-command-controls.test.tsx) — Tests admin command controls, alias search, the canonical Bilibili switch, and all 14 title-search catalog entries.
  - **References:**
    - [`dashboard/lib/bot-data.ts`](../dashboard/lib/bot-data.ts) — import.
    - [`dashboard/components/member-command-controls.tsx`](../dashboard/components/member-command-controls.tsx) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `vitest`.

- [`member-features-security.test.ts`](../dashboard/tests/member-features-security.test.ts) — Vitest regression tests for member features security; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/admin/approvals/route.ts`](../dashboard/app/api/admin/approvals/route.ts) — import, route URL reference.
    - [`dashboard/app/api/admin/commands/route.ts`](../dashboard/app/api/admin/commands/route.ts) — import, route URL reference.
    - [`dashboard/app/api/support/route.ts`](../dashboard/app/api/support/route.ts) — import, route URL reference.
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — test mock.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — test mock.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `vitest`.

- [`member-home.test.tsx`](../dashboard/tests/member-home.test.tsx) — Vitest regression tests for member home; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/components/member-home.tsx`](../dashboard/components/member-home.tsx) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `vitest`.

- [`member-link-api.test.ts`](../dashboard/tests/member-link-api.test.ts) — Vitest regression tests for member link api; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/member/pair/route.ts`](../dashboard/app/api/member/pair/route.ts) — import, route URL reference.
    - [`dashboard/app/api/member/unlink/route.ts`](../dashboard/app/api/member/unlink/route.ts) — import, route URL reference.
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — test mock.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — test mock.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `vitest`.

- [`member-portal.test.tsx`](../dashboard/tests/member-portal.test.tsx) — Vitest regression tests for member portal; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — route URL reference.
    - [`dashboard/app/api/member/numbers/route.ts`](../dashboard/app/api/member/numbers/route.ts) — route URL reference.
    - [`dashboard/app/api/member/pair/route.ts`](../dashboard/app/api/member/pair/route.ts) — route URL reference.
    - [`dashboard/app/api/member/status/route.ts`](../dashboard/app/api/member/status/route.ts) — route URL reference.
    - [`dashboard/app/api/member/unlink/route.ts`](../dashboard/app/api/member/unlink/route.ts) — route URL reference.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — test mock.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
    - [`dashboard/lib/member-link.ts`](../dashboard/lib/member-link.ts) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `next/link`, `next/navigation`, `vitest`.

- [`member-scribd-navigation.test.tsx`](../dashboard/tests/member-scribd-navigation.test.tsx) — Vitest regression tests for member scribd navigation; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — route URL reference.
    - [`dashboard/app/api/member/status/route.ts`](../dashboard/app/api/member/status/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/find/route.ts`](../dashboard/app/api/scribd/find/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/status/route.ts`](../dashboard/app/api/scribd/status/route.ts) — route URL reference.
    - [`dashboard/components/member-portal.tsx`](../dashboard/components/member-portal.tsx) — import.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `next/link`, `next/navigation`, `vitest`.

- [`pairing-code-banner.test.tsx`](../dashboard/tests/pairing-code-banner.test.tsx) — Vitest regression tests for pairing code banner; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/components/pairing-code-banner.tsx`](../dashboard/components/pairing-code-banner.tsx) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `vitest`.

- [`pairing-security.test.ts`](../dashboard/tests/pairing-security.test.ts) — Vitest regression tests for pairing security; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/member/pair/route.ts`](../dashboard/app/api/member/pair/route.ts) — import, route URL reference.
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — test mock.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `vitest`.

- [`panel-client.test.ts`](../dashboard/tests/panel-client.test.ts) — Vitest regression tests for panel client; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/panel-client.ts`](../dashboard/lib/panel-client.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `vitest`.

- [`panel-route.test.ts`](../dashboard/tests/panel-route.test.ts) — Vitest regression tests for panel route; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/admin/panel/route.ts`](../dashboard/app/api/admin/panel/route.ts) — import, route URL reference.
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — test mock.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
    - [`dashboard/lib/panel-client.ts`](../dashboard/lib/panel-client.ts) — test mock.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `vitest`.

- [`panel-status.test.ts`](../dashboard/tests/panel-status.test.ts) — Vitest regression tests for panel status; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/admin/panel/status/route.ts`](../dashboard/app/api/admin/panel/status/route.ts) — import, route URL reference.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `vitest`.

- [`room-alert-reads.test.ts`](../dashboard/tests/room-alert-reads.test.ts) — Vitest regression tests for room alert reads; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/control-room.ts`](../dashboard/lib/control-room.ts) — import.
    - [`dashboard/lib/room-alert-reads.ts`](../dashboard/lib/room-alert-reads.ts) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `vitest`.

- [`scribd-config.test.ts`](../dashboard/tests/scribd-config.test.ts) — Vitest regression tests for scribd config; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/scribd-config.ts`](../dashboard/lib/scribd-config.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `vitest`.

- [`scribd-desk.test.tsx`](../dashboard/tests/scribd-desk.test.tsx) — Vitest regression tests for scribd desk; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/auth/me/route.ts`](../dashboard/app/api/auth/me/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/clear/route.ts`](../dashboard/app/api/scribd/clear/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/file-ticket/route.ts`](../dashboard/app/api/scribd/file-ticket/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/files/route.ts`](../dashboard/app/api/scribd/files/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/find/route.ts`](../dashboard/app/api/scribd/find/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/reset/route.ts`](../dashboard/app/api/scribd/reset/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/run/route.ts`](../dashboard/app/api/scribd/run/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/status/route.ts`](../dashboard/app/api/scribd/status/route.ts) — route URL reference.
    - [`dashboard/app/api/scribd/thumb/route.ts`](../dashboard/app/api/scribd/thumb/route.ts) — route URL reference.
    - [`dashboard/components/scribd-desk.tsx`](../dashboard/components/scribd-desk.tsx) — import.
    - [`dashboard/lib/client-session.ts`](../dashboard/lib/client-session.ts) — import.
    - [`dashboard/lib/scribd-types.ts`](../dashboard/lib/scribd-types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `vitest`.

- [`scribd-download-ticket.test.ts`](../dashboard/tests/scribd-download-ticket.test.ts) — Vitest regression tests for scribd download ticket; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/scribd/file-ticket/route.ts`](../dashboard/app/api/scribd/file-ticket/route.ts) — import, route URL reference.
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — import, route URL reference.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
    - [`dashboard/lib/scribd-download-ticket.ts`](../dashboard/lib/scribd-download-ticket.ts) — import.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — test mock.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `vitest`.

- [`scribd-panel.test.ts`](../dashboard/tests/scribd-panel.test.ts) — Vitest regression tests for scribd panel; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/scribd/config/route.ts`](../dashboard/app/api/scribd/config/route.ts) — import, route URL reference.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
    - [`dashboard/lib/scribd-config.ts`](../dashboard/lib/scribd-config.ts) — test mock.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `vitest`.

- [`scribd-search.test.ts`](../dashboard/tests/scribd-search.test.ts) — Vitest regression tests for scribd search; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — import.
    - [`dashboard/lib/scribd-search.ts`](../dashboard/lib/scribd-search.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `vitest`.

- [`scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — Vitest regression tests for scribd web contract; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/scribd/clear/route.ts`](../dashboard/app/api/scribd/clear/route.ts) — import, route URL reference.
    - [`dashboard/app/api/scribd/file/route.ts`](../dashboard/app/api/scribd/file/route.ts) — import, route URL reference.
    - [`dashboard/app/api/scribd/files/route.ts`](../dashboard/app/api/scribd/files/route.ts) — import, route URL reference.
    - [`dashboard/app/api/scribd/find/route.ts`](../dashboard/app/api/scribd/find/route.ts) — import, route URL reference.
    - [`dashboard/app/api/scribd/link/route.ts`](../dashboard/app/api/scribd/link/route.ts) — import, route URL reference.
    - [`dashboard/app/api/scribd/reset/route.ts`](../dashboard/app/api/scribd/reset/route.ts) — import, route URL reference.
    - [`dashboard/app/api/scribd/run/route.ts`](../dashboard/app/api/scribd/run/route.ts) — import, route URL reference.
    - [`dashboard/app/api/scribd/status/route.ts`](../dashboard/app/api/scribd/status/route.ts) — import, route URL reference.
    - [`dashboard/app/api/scribd/thumb/route.ts`](../dashboard/app/api/scribd/thumb/route.ts) — import, route URL reference.
    - [`dashboard/lib/activity.ts`](../dashboard/lib/activity.ts) — test mock.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
    - [`dashboard/lib/scribd-config.ts`](../dashboard/lib/scribd-config.ts) — test mock.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
    - [`dashboard/tests/fixtures/scribd_web_contract.py`](../dashboard/tests/fixtures/scribd_web_contract.py) — starts loopback fixture, file URL.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `node:child_process`, `node:events`, `node:url`, `vitest`.

- [`session-backup-api.test.ts`](../dashboard/tests/session-backup-api.test.ts) — Vitest regression tests for session backup api; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/bot/session-backups/route.ts`](../dashboard/app/api/bot/session-backups/route.ts) — import, route URL reference.
    - [`dashboard/lib/bot-sync-auth.ts`](../dashboard/lib/bot-sync-auth.ts) — test mock.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `node:crypto`, `vitest`.

- [`session-backup-sqlite.test.ts`](../dashboard/tests/session-backup-sqlite.test.ts) — Vitest regression tests for session backup sqlite; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `node:sqlite`, `vitest`.

- [`support-desk.test.tsx`](../dashboard/tests/support-desk.test.tsx) — Vitest regression tests for support desk; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/components/support-desk.tsx`](../dashboard/components/support-desk.tsx) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `vitest`.

- [`sync-status.test.ts`](../dashboard/tests/sync-status.test.ts) — Vitest regression tests for sync status; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — import.
    - [`dashboard/lib/sync-status.ts`](../dashboard/lib/sync-status.ts) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `vitest`.

- [`whatsapp-bridge.test.ts`](../dashboard/tests/whatsapp-bridge.test.ts) — Vitest regression tests for whatsapp bridge; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — import.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
    - [`dashboard/lib/whatsapp-accounts.ts`](../dashboard/lib/whatsapp-accounts.ts) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `vitest`.

- [`whatsapp-status-privacy.test.ts`](../dashboard/tests/whatsapp-status-privacy.test.ts) — Vitest regression tests for whatsapp status privacy; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/app/api/member/status/route.ts`](../dashboard/app/api/member/status/route.ts) — import, route URL reference.
    - [`dashboard/lib/auth-engine.ts`](../dashboard/lib/auth-engine.ts) — test mock.
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — test mock.
    - [`dashboard/lib/storage.ts`](../dashboard/lib/storage.ts) — test mock.
    - [`dashboard/lib/sync-status.ts`](../dashboard/lib/sync-status.ts) — test mock.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `next/server`, `vitest`.

- [`workspace-shell.test.tsx`](../dashboard/tests/workspace-shell.test.tsx) — Vitest regression tests for workspace shell; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/components/workspace-shell.tsx`](../dashboard/components/workspace-shell.tsx) — import.
    - [`dashboard/lib/types.ts`](../dashboard/lib/types.ts) — type import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `lucide-react`, `next/link`, `react`, `vitest`.

- [`zafar-robot.test.tsx`](../dashboard/tests/zafar-robot.test.tsx) — Vitest regression tests for zafar robot; see direct references below for the exercised modules.
  - **References:**
    - [`dashboard/components/zafar-robot.tsx`](../dashboard/components/zafar-robot.tsx) — import.
  - **Referenced by:**
    - [`dashboard/vitest.config.ts`](../dashboard/vitest.config.ts) — test discovery.
  - **Outside modules:** `@testing-library/react`, `node:fs`, `node:path`, `postcss`, `vitest`.

### `dashboard/tests/fixtures/`

- [`scribd_web_contract.py`](../dashboard/tests/fixtures/scribd_web_contract.py) — Loopback fixture using the real Python Scribd HTTP handler with expensive and external operations stubbed.
  - **References:**
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — import, fixture imports real handler.
  - **Referenced by:**
    - [`dashboard/tests/scribd-web-contract.test.ts`](../dashboard/tests/scribd-web-contract.test.ts) — starts loopback fixture, file URL.
  - **Outside modules:** `__future__`, `base64`, `http.server`, `pathlib`, `signal`, `sys`, `tempfile`, `threading`, `time`.

### `docs/`

- [`REPOSITORY_FILE_INDEX.md`](REPOSITORY_FILE_INDEX.md) — Exhaustive per-file role and reference index accompanying the repository map.
  - **References:**
    - [`REPOSITORY_MAP.md`](../REPOSITORY_MAP.md) — explicit relationship.
  - **Referenced by:**
    - [`REPOSITORY_MAP.md`](../REPOSITORY_MAP.md) — explicit relationship.

### `scribd/`

- [`.env.example`](../scribd/.env.example) — Template for the separate Scribd service and optional integrations.
  - **References:**
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — explicit relationship.
    - [`scribd/drime.py`](../scribd/drime.py) — explicit relationship.
    - [`scribd/envfile.py`](../scribd/envfile.py) — explicit relationship.
    - [`scribd/run.py`](../scribd/run.py) — explicit relationship.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — explicit relationship.
  - **Referenced by:**
    - [`scribd/bootstrap.sh`](../scribd/bootstrap.sh) — file name mentioned.
    - [`scribd/panel_setup.sh`](../scribd/panel_setup.sh) — file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/test_discord_bot.py`](../scribd/test_discord_bot.py) — file name mentioned.

- [`.gitignore`](../scribd/.gitignore) — Excludes Scribd output, credentials, installed tools, caches, and local runtime state.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`scribd/test_discord_bot.py`](../scribd/test_discord_bot.py) — file name mentioned.

- [`bootstrap.sh`](../scribd/bootstrap.sh) — Installs core Python requirements and sets up a browser on a hosting panel.
  - **References:**
    - [`scribd/.env.example`](../scribd/.env.example) — file name mentioned.
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — explicit relationship, file name mentioned.
    - [`scribd/drime.py`](../scribd/drime.py) — file name mentioned.
    - [`scribd/requirements.txt`](../scribd/requirements.txt) — explicit relationship, file name mentioned.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — file name mentioned.
    - [`scribd/start.sh`](../scribd/start.sh) — explicit relationship, file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.

- [`bot-requirements.txt`](../scribd/bot-requirements.txt) — Optional discord.py dependency for the Discord front end.
  - **References:**
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — dependency manifest.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.

- [`chromium_launch.py`](../scribd/chromium_launch.py) — Selects, diagnoses, and launches the Chromium/CloakBrowser backend.
  - **References:**
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — import, file name mentioned.
    - [`scribd/logfmt.py`](../scribd/logfmt.py) — import.
  - **Referenced by:**
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — import.
    - [`scribd/make_bundle.py`](../scribd/make_bundle.py) — reads bundle source, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/requirements.txt`](../scribd/requirements.txt) — dependency manifest.
    - [`scribd/run.py`](../scribd/run.py) — import.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — generated from source, embedded source (generated).
    - [`scribd/scribd_pdf.py`](../scribd/scribd_pdf.py) — import.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — import.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — import.
    - [`scribd/test_chromium.py`](../scribd/test_chromium.py) — import, file name mentioned.
  - **Outside modules:** `__future__`, `cloakbrowser`, `cloakbrowser.browser`, `importlib.util`, `os`, `pathlib`, `platform`, `shutil`, `struct`.

- [`chromium_setup.py`](../scribd/chromium_setup.py) — Downloads or prepares a compatible browser and its panel-host dependencies.
  - **References:**
    - [`scribd/logfmt.py`](../scribd/logfmt.py) — import.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — file name mentioned.
  - **Referenced by:**
    - [`scribd/bootstrap.sh`](../scribd/bootstrap.sh) — explicit relationship, file name mentioned.
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — import, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/requirements.txt`](../scribd/requirements.txt) — dependency manifest.
    - [`scribd/run.py`](../scribd/run.py) — file name mentioned.
    - [`scribd/scribd_pdf.py`](../scribd/scribd_pdf.py) — file name mentioned.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — file name mentioned.
    - [`scribd/test_chromium.py`](../scribd/test_chromium.py) — import, file name mentioned.
    - [`scribd/test_run.py`](../scribd/test_run.py) — file name mentioned.
  - **Outside modules:** `__future__`, `argparse`, `brotli`, `brotlicffi`, `cloakbrowser`, `cloakbrowser.browser`, `glob`, `importlib.util`, `io`, `json`, `os`, `pathlib`, `platform`, `re`, `requests`, `shutil`, `subprocess`, `sys`, `tarfile`, `tempfile`, `urllib.request`, `zipfile`.

- [`clean.sh`](../scribd/clean.sh) — Removes Scribd-generated output and optionally the downloaded browser.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.

- [`discord_bot.py`](../scribd/discord_bot.py) — Optional Discord slash-command front end; can start the web service and converter.
  - **References:**
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — import.
    - [`scribd/drime.py`](../scribd/drime.py) — import.
    - [`scribd/envfile.py`](../scribd/envfile.py) — import.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — starts converter when available, file name mentioned.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — fallback converter source, file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — import, file name mentioned.
  - **Referenced by:**
    - [`scribd/.env.example`](../scribd/.env.example) — explicit relationship.
    - [`scribd/bot-requirements.txt`](../scribd/bot-requirements.txt) — dependency manifest.
    - [`scribd/panel_setup.sh`](../scribd/panel_setup.sh) — file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/run.py`](../scribd/run.py) — selected startup mode, file name mentioned.
    - [`scribd/start.sh`](../scribd/start.sh) — selected startup mode, file name mentioned.
    - [`scribd/test_discord_bot.py`](../scribd/test_discord_bot.py) — import, file name mentioned.
    - [`scribd/test_run.py`](../scribd/test_run.py) — file name mentioned.
    - [`scribd/test_scribd_shot.py`](../scribd/test_scribd_shot.py) — file name mentioned.
  - **Outside modules:** `__future__`, `argparse`, `asyncio`, `discord`, `os`, `pathlib`, `re`, `subprocess`, `sys`, `threading`, `time`.

- [`drime.py`](../scribd/drime.py) — Optional Drime upload, sharing, and post-upload offload support.
  - **References:**
    - [`scribd/envfile.py`](../scribd/envfile.py) — import.
  - **Referenced by:**
    - [`scribd/.env.example`](../scribd/.env.example) — explicit relationship.
    - [`scribd/bootstrap.sh`](../scribd/bootstrap.sh) — file name mentioned.
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — import.
    - [`scribd/make_bundle.py`](../scribd/make_bundle.py) — reads bundle source, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — generated from source, embedded source (generated).
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — import.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — import.
    - [`scribd/test_drime.py`](../scribd/test_drime.py) — import, file name mentioned.
  - **Outside modules:** `__future__`, `argparse`, `base64`, `json`, `mimetypes`, `os`, `pathlib`, `re`, `sys`, `time`, `urllib.error`, `urllib.request`.

- [`envfile.py`](../scribd/envfile.py) — Reads local Scribd .env settings without overriding existing environment values.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`scribd/.env.example`](../scribd/.env.example) — explicit relationship.
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — import.
    - [`scribd/drime.py`](../scribd/drime.py) — import.
    - [`scribd/make_bundle.py`](../scribd/make_bundle.py) — reads bundle source, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/run.py`](../scribd/run.py) — import.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — generated from source, embedded source (generated).
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — import.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — import.
    - [`scribd/test_discord_bot.py`](../scribd/test_discord_bot.py) — import.
  - **Outside modules:** `__future__`, `os`, `pathlib`.

- [`logfmt.py`](../scribd/logfmt.py) — Shared console formatting and machine-readable progress/event records.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — import.
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — import.
    - [`scribd/make_bundle.py`](../scribd/make_bundle.py) — reads bundle source, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/run.py`](../scribd/run.py) — import.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — generated from source, embedded source (generated).
    - [`scribd/scribd_pdf.py`](../scribd/scribd_pdf.py) — import.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — import.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — import.
    - [`scribd/test_logfmt.py`](../scribd/test_logfmt.py) — import, file name mentioned.
  - **Outside modules:** `__future__`, `contextlib`, `os`, `sys`, `time`.

- [`make_bundle.py`](../scribd/make_bundle.py) — Builds scribd_all.py from the screenshot converter and embedded helper sources.
  - **References:**
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — reads bundle source, file name mentioned.
    - [`scribd/drime.py`](../scribd/drime.py) — reads bundle source, file name mentioned.
    - [`scribd/envfile.py`](../scribd/envfile.py) — reads bundle source, file name mentioned.
    - [`scribd/logfmt.py`](../scribd/logfmt.py) — reads bundle source, file name mentioned.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — writes generated bundle, file name mentioned.
    - [`scribd/scribd_pdf.py`](../scribd/scribd_pdf.py) — reads bundle source, file name mentioned.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — reads bundle source, file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/test_scribd_shot.py`](../scribd/test_scribd_shot.py) — file name mentioned.
  - **Outside modules:** `__future__`, `base64`, `pathlib`, `textwrap`.

- [`panel_setup.sh`](../scribd/panel_setup.sh) — Installs the core and optional PDF dependencies for a hosting panel.
  - **References:**
    - [`scribd/.env.example`](../scribd/.env.example) — file name mentioned.
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — file name mentioned.
    - [`scribd/requirements-mupdf.txt`](../scribd/requirements-mupdf.txt) — explicit relationship, file name mentioned.
    - [`scribd/requirements.txt`](../scribd/requirements.txt) — explicit relationship, file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.

- [`README.md`](../scribd/README.md) — Detailed instructions, architecture, setup, and troubleshooting for Scribd tools.
  - **References:**
    - [`scribd/.env.example`](../scribd/.env.example) — file name mentioned.
    - [`scribd/bootstrap.sh`](../scribd/bootstrap.sh) — file name mentioned.
    - [`scribd/bot-requirements.txt`](../scribd/bot-requirements.txt) — file name mentioned.
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — file name mentioned.
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — file name mentioned.
    - [`scribd/clean.sh`](../scribd/clean.sh) — file name mentioned.
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — file name mentioned.
    - [`scribd/drime.py`](../scribd/drime.py) — file name mentioned.
    - [`scribd/envfile.py`](../scribd/envfile.py) — file name mentioned.
    - [`scribd/logfmt.py`](../scribd/logfmt.py) — file name mentioned.
    - [`scribd/make_bundle.py`](../scribd/make_bundle.py) — file name mentioned.
    - [`scribd/panel_setup.sh`](../scribd/panel_setup.sh) — file name mentioned.
    - [`scribd/requirements.txt`](../scribd/requirements.txt) — file name mentioned.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — file name mentioned.
    - [`scribd/scribd_job.sh`](../scribd/scribd_job.sh) — file name mentioned.
    - [`scribd/scribd_pdf.py`](../scribd/scribd_pdf.py) — file name mentioned.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — file name mentioned.
    - [`scribd/start.sh`](../scribd/start.sh) — file name mentioned.
    - [`scribd/test_chromium.py`](../scribd/test_chromium.py) — file name mentioned.
    - [`scribd/test_discord_bot.py`](../scribd/test_discord_bot.py) — file name mentioned.
    - [`scribd/test_drime.py`](../scribd/test_drime.py) — file name mentioned.
    - [`scribd/test_logfmt.py`](../scribd/test_logfmt.py) — file name mentioned.
    - [`scribd/test_run.py`](../scribd/test_run.py) — file name mentioned.
    - [`scribd/test_scribd_pdf.py`](../scribd/test_scribd_pdf.py) — file name mentioned.
    - [`scribd/test_scribd_shot.py`](../scribd/test_scribd_shot.py) — file name mentioned.
    - [`scribd/test_scribd_web.py`](../scribd/test_scribd_web.py) — file name mentioned.
    - [`scribd/web-ui.png`](../scribd/web-ui.png) — documentation link, file name mentioned.
  - **Referenced by:**
    - [`README.md`](../README.md) — explicit relationship, documentation link, file path mentioned.
    - [`scribd/test_chromium.py`](../scribd/test_chromium.py) — file name mentioned.
    - [`scribd/test_discord_bot.py`](../scribd/test_discord_bot.py) — file name mentioned.
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — file path mentioned.

- [`requirements-mupdf.txt`](../scribd/requirements-mupdf.txt) — Optional PyMuPDF dependency for an alternate PDF assembly engine.
  - **References:**
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — optional dependency manifest.
  - **Referenced by:**
    - [`scribd/panel_setup.sh`](../scribd/panel_setup.sh) — explicit relationship, file name mentioned.

- [`requirements.txt`](../scribd/requirements.txt) — Core Scribd browser, PDF, image, HTTP, and setup dependencies.
  - **References:**
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — dependency manifest.
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — dependency manifest.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — dependency manifest.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — dependency manifest.
  - **Referenced by:**
    - [`scribd/bootstrap.sh`](../scribd/bootstrap.sh) — explicit relationship, file name mentioned.
    - [`scribd/panel_setup.sh`](../scribd/panel_setup.sh) — explicit relationship, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/run.py`](../scribd/run.py) — file name mentioned.
    - [`scribd/test_run.py`](../scribd/test_run.py) — file name mentioned.

- [`run.py`](../scribd/run.py) — Panel Python entry point: loads environment, prepares browser, and starts the selected web, Discord, or tool mode.
  - **References:**
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — import.
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — file name mentioned.
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — selected startup mode, file name mentioned.
    - [`scribd/envfile.py`](../scribd/envfile.py) — import.
    - [`scribd/logfmt.py`](../scribd/logfmt.py) — import.
    - [`scribd/requirements.txt`](../scribd/requirements.txt) — file name mentioned.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — selected startup mode, file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — selected startup mode, file name mentioned.
  - **Referenced by:**
    - [`scribd/.env.example`](../scribd/.env.example) — explicit relationship.
  - **Outside modules:** `__future__`, `cloakbrowser`, `importlib.util`, `os`, `pathlib`, `subprocess`, `sys`.

- [`scribd_all.py`](../scribd/scribd_all.py) — Generated single-file screenshot converter containing scribd_shot.py and embedded helper modules.
  - **References:**
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — generated from source, embedded source (generated).
    - [`scribd/drime.py`](../scribd/drime.py) — generated from source, embedded source (generated).
    - [`scribd/envfile.py`](../scribd/envfile.py) — generated from source, embedded source (generated).
    - [`scribd/logfmt.py`](../scribd/logfmt.py) — generated from source, embedded source (generated).
    - [`scribd/scribd_pdf.py`](../scribd/scribd_pdf.py) — generated from source, embedded source (generated).
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — generated from source.
  - **Referenced by:**
    - [`scribd/bootstrap.sh`](../scribd/bootstrap.sh) — file name mentioned.
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — starts converter when available, file name mentioned.
    - [`scribd/make_bundle.py`](../scribd/make_bundle.py) — writes generated bundle, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/run.py`](../scribd/run.py) — selected startup mode, file name mentioned.
    - [`scribd/scribd_job.sh`](../scribd/scribd_job.sh) — starts converter when available, file name mentioned.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — starts converter when available, file name mentioned.
    - [`scribd/start.sh`](../scribd/start.sh) — selected startup mode, file name mentioned.
    - [`scribd/test_discord_bot.py`](../scribd/test_discord_bot.py) — file name mentioned.
    - [`scribd/test_run.py`](../scribd/test_run.py) — file name mentioned.
    - [`scribd/test_scribd_shot.py`](../scribd/test_scribd_shot.py) — file name mentioned.
  - **Outside modules:** `__future__`, `argparse`, `base64`, `collections.abc`, `concurrent.futures`, `dataclasses`, `hashlib`, `img2pdf`, `json`, `os`, `pathlib`, `PIL`, `playwright.sync_api`, `pymupdf`, `pypdf`, `re`, `requests`, `shutil`, `sys`, `tempfile`, `threading`, `time`, `traceback`, `types`, `urllib.parse`, `uuid`.

- [`scribd_job.sh`](../scribd/scribd_job.sh) — Starts, checks, or stops a background converter process on a shell-based panel.
  - **References:**
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — starts converter when available, file name mentioned.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — fallback converter source, file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.

- [`scribd_pdf.py`](../scribd/scribd_pdf.py) — Document-fragment fetching, parsing, and PDF/HTML reconstruction helpers.
  - **References:**
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — import.
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — file name mentioned.
    - [`scribd/logfmt.py`](../scribd/logfmt.py) — import.
  - **Referenced by:**
    - [`scribd/make_bundle.py`](../scribd/make_bundle.py) — reads bundle source, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — generated from source, embedded source (generated).
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — import, file name mentioned.
    - [`scribd/test_chromium.py`](../scribd/test_chromium.py) — file name mentioned.
    - [`scribd/test_scribd_pdf.py`](../scribd/test_scribd_pdf.py) — import, file name mentioned.
    - [`scribd/test_scribd_shot.py`](../scribd/test_scribd_shot.py) — import.
  - **Outside modules:** `__future__`, `argparse`, `base64`, `collections.abc`, `concurrent.futures`, `dataclasses`, `img2pdf`, `io`, `json`, `pathlib`, `PIL`, `playwright.sync_api`, `pypdf`, `random`, `re`, `requests`, `shutil`, `sys`, `tempfile`, `time`, `traceback`, `urllib.parse`.

- [`scribd_shot.py`](../scribd/scribd_shot.py) — Source for reader/fragment screenshot capture, page audit, and PDF assembly.
  - **References:**
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — import.
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — file name mentioned.
    - [`scribd/drime.py`](../scribd/drime.py) — import.
    - [`scribd/envfile.py`](../scribd/envfile.py) — import.
    - [`scribd/logfmt.py`](../scribd/logfmt.py) — import.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — file name mentioned.
    - [`scribd/scribd_pdf.py`](../scribd/scribd_pdf.py) — import, file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — file name mentioned.
  - **Referenced by:**
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — file name mentioned.
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — fallback converter source, file name mentioned.
    - [`scribd/make_bundle.py`](../scribd/make_bundle.py) — reads bundle source, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/requirements-mupdf.txt`](../scribd/requirements-mupdf.txt) — optional dependency manifest.
    - [`scribd/requirements.txt`](../scribd/requirements.txt) — dependency manifest.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — generated from source.
    - [`scribd/scribd_job.sh`](../scribd/scribd_job.sh) — fallback converter source, file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — import, fallback converter source, file name mentioned.
    - [`scribd/test_chromium.py`](../scribd/test_chromium.py) — file name mentioned.
    - [`scribd/test_discord_bot.py`](../scribd/test_discord_bot.py) — file name mentioned.
    - [`scribd/test_render_policy.py`](../scribd/test_render_policy.py) — import.
    - [`scribd/test_scribd_shot.py`](../scribd/test_scribd_shot.py) — import, file name mentioned.
  - **Outside modules:** `__future__`, `argparse`, `collections.abc`, `concurrent.futures`, `dataclasses`, `hashlib`, `img2pdf`, `json`, `os`, `pathlib`, `PIL`, `playwright.sync_api`, `pymupdf`, `pypdf`, `re`, `requests`, `shutil`, `sys`, `tempfile`, `threading`, `time`, `traceback`, `urllib.parse`, `uuid`.

- [`scribd_web.py`](../scribd/scribd_web.py) — HTTP service, embedded web UI, search, shared job queue, converter subprocess, and file endpoints.
  - **References:**
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — import.
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — file name mentioned.
    - [`scribd/drime.py`](../scribd/drime.py) — import.
    - [`scribd/envfile.py`](../scribd/envfile.py) — import.
    - [`scribd/logfmt.py`](../scribd/logfmt.py) — import.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — starts converter when available, file name mentioned.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — import, fallback converter source, file name mentioned.
  - **Referenced by:**
    - [`dashboard/lib/scribd-config.ts`](../dashboard/lib/scribd-config.ts) — configured external service.
    - [`dashboard/lib/scribd-panel.ts`](../dashboard/lib/scribd-panel.ts) — HTTP API contract.
    - [`dashboard/README.md`](../dashboard/README.md) — file path mentioned.
    - [`dashboard/tests/fixtures/scribd_web_contract.py`](../dashboard/tests/fixtures/scribd_web_contract.py) — import, fixture imports real handler.
    - [`scribd/.env.example`](../scribd/.env.example) — explicit relationship.
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — import, file name mentioned.
    - [`scribd/panel_setup.sh`](../scribd/panel_setup.sh) — file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/requirements.txt`](../scribd/requirements.txt) — dependency manifest.
    - [`scribd/run.py`](../scribd/run.py) — selected startup mode, file name mentioned.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — file name mentioned.
    - [`scribd/start.sh`](../scribd/start.sh) — selected startup mode, file name mentioned.
    - [`scribd/test_chromium.py`](../scribd/test_chromium.py) — file name mentioned.
    - [`scribd/test_discord_bot.py`](../scribd/test_discord_bot.py) — file name mentioned.
    - [`scribd/test_run.py`](../scribd/test_run.py) — file name mentioned.
    - [`scribd/test_scribd_shot.py`](../scribd/test_scribd_shot.py) — file name mentioned.
    - [`scribd/test_scribd_web.py`](../scribd/test_scribd_web.py) — import, file name mentioned.
  - **Outside modules:** `__future__`, `argparse`, `http.server`, `json`, `os`, `pathlib`, `playwright.sync_api`, `re`, `secrets`, `subprocess`, `sys`, `threading`, `time`, `traceback`, `urllib.parse`, `urllib.request`, `zipfile`.

- [`start.sh`](../scribd/start.sh) — Shell launcher for web, Discord-with-web, or direct converter modes.
  - **References:**
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — selected startup mode, file name mentioned.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — selected startup mode, file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — selected startup mode, file name mentioned.
  - **Referenced by:**
    - [`scribd/bootstrap.sh`](../scribd/bootstrap.sh) — explicit relationship, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.

- [`test_chromium.py`](../scribd/test_chromium.py) — Python regression tests for chromium; see direct references below for the exercised modules.
  - **References:**
    - [`scribd/chromium_launch.py`](../scribd/chromium_launch.py) — import, file name mentioned.
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — import, file name mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/scribd_pdf.py`](../scribd/scribd_pdf.py) — file name mentioned.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
  - **Outside modules:** `__future__`, `cloakbrowser.browser`, `http.server`, `io`, `os`, `pathlib`, `shutil`, `struct`, `sys`, `tarfile`, `tempfile`, `threading`.

- [`test_discord_bot.py`](../scribd/test_discord_bot.py) — Python regression tests for discord bot; see direct references below for the exercised modules.
  - **References:**
    - [`scribd/.env.example`](../scribd/.env.example) — file name mentioned.
    - [`scribd/.gitignore`](../scribd/.gitignore) — file name mentioned.
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — import, file name mentioned.
    - [`scribd/envfile.py`](../scribd/envfile.py) — import.
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — file name mentioned.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
  - **Outside modules:** `__future__`, `discord`, `os`, `pathlib`, `shutil`, `sys`, `tempfile`, `time`.

- [`test_drime.py`](../scribd/test_drime.py) — Python regression tests for drime; see direct references below for the exercised modules.
  - **References:**
    - [`scribd/drime.py`](../scribd/drime.py) — import, file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
  - **Outside modules:** `http.server`, `json`, `os`, `pathlib`, `sys`, `tempfile`, `threading`, `urllib.parse`.

- [`test_logfmt.py`](../scribd/test_logfmt.py) — Python regression tests for logfmt; see direct references below for the exercised modules.
  - **References:**
    - [`scribd/logfmt.py`](../scribd/logfmt.py) — import, file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
  - **Outside modules:** `__future__`, `contextlib`, `io`, `os`, `pathlib`, `sys`, `time`.

- [`test_render_policy.py`](../scribd/test_render_policy.py) — Python regression tests for render policy; see direct references below for the exercised modules.
  - **References:**
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — import.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.
  - **Outside modules:** `__future__`, `pathlib`, `tempfile`, `types`.

- [`test_run.py`](../scribd/test_run.py) — Python regression tests for run; see direct references below for the exercised modules.
  - **References:**
    - [`scribd/chromium_setup.py`](../scribd/chromium_setup.py) — file name mentioned.
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — file name mentioned.
    - [`scribd/requirements.txt`](../scribd/requirements.txt) — file name mentioned.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
  - **Outside modules:** `__future__`, `importlib.util`, `pathlib`, `subprocess`, `sys`, `tempfile`.

- [`test_scribd_pdf.py`](../scribd/test_scribd_pdf.py) — Python regression tests for scribd pdf; see direct references below for the exercised modules.
  - **References:**
    - [`scribd/scribd_pdf.py`](../scribd/scribd_pdf.py) — import, file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
  - **Outside modules:** `io`, `json`, `os`, `PIL`, `sys`, `tempfile`, `time`.

- [`test_scribd_shot.py`](../scribd/test_scribd_shot.py) — Python regression tests for scribd shot; see direct references below for the exercised modules.
  - **References:**
    - [`scribd/discord_bot.py`](../scribd/discord_bot.py) — file name mentioned.
    - [`scribd/make_bundle.py`](../scribd/make_bundle.py) — file name mentioned.
    - [`scribd/scribd_all.py`](../scribd/scribd_all.py) — file name mentioned.
    - [`scribd/scribd_pdf.py`](../scribd/scribd_pdf.py) — import.
    - [`scribd/scribd_shot.py`](../scribd/scribd_shot.py) — import, file name mentioned.
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
  - **Outside modules:** `ast`, `json`, `os`, `pathlib`, `PIL`, `pypdf`, `re`, `shutil`, `subprocess`, `sys`, `tempfile`.

- [`test_scribd_web.py`](../scribd/test_scribd_web.py) — Python regression tests for scribd web; see direct references below for the exercised modules.
  - **References:**
    - [`scribd/scribd_web.py`](../scribd/scribd_web.py) — import, file name mentioned.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — file name mentioned.
  - **Outside modules:** `__future__`, `http.server`, `json`, `os`, `pathlib`, `re`, `shutil`, `sys`, `tempfile`, `threading`, `urllib.error`, `urllib.request`.

- [`web-ui.png`](../scribd/web-ui.png) — Screenshot embedded in the Scribd README.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`scribd/README.md`](../scribd/README.md) — documentation link, file name mentioned.

### `scribd/uploads/`

- [`build_pdf.py`](../scribd/uploads/build_pdf.py) — Builds a PDF from downloaded page images for the uploads pipeline.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`scribd/uploads/main.py`](../scribd/uploads/main.py) — import.
    - [`scribd/uploads/requirements.txt`](../scribd/uploads/requirements.txt) — dependency manifest.
  - **Outside modules:** `__future__`, `img2pdf`, `pathlib`, `PIL`, `typing`.

- [`cookies.py`](../scribd/uploads/cookies.py) — Builds the uploads pipeline's HTTP session and cookie handling.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`scribd/uploads/main.py`](../scribd/uploads/main.py) — import.
    - [`scribd/uploads/requirements.txt`](../scribd/uploads/requirements.txt) — dependency manifest.
  - **Outside modules:** `__future__`, `pathlib`, `requests`, `requests.cookies`.

- [`download.py`](../scribd/uploads/download.py) — Downloads page images and refreshes asset tokens for the uploads pipeline.
  - **References:**
    - [`scribd/uploads/token.py`](../scribd/uploads/token.py) — import.
  - **Referenced by:**
    - [`scribd/uploads/extract.py`](../scribd/uploads/extract.py) — file name mentioned.
    - [`scribd/uploads/main.py`](../scribd/uploads/main.py) — import.
    - [`scribd/uploads/requirements.txt`](../scribd/uploads/requirements.txt) — dependency manifest.
  - **Outside modules:** `__future__`, `pathlib`, `requests`, `time`, `typing`.

- [`extract.py`](../scribd/uploads/extract.py) — Extracts document metadata, page details, and URLs for the uploads pipeline.
  - **References:**
    - [`scribd/uploads/download.py`](../scribd/uploads/download.py) — file name mentioned.
  - **Referenced by:**
    - [`scribd/uploads/main.py`](../scribd/uploads/main.py) — import.
    - [`scribd/uploads/requirements.txt`](../scribd/uploads/requirements.txt) — dependency manifest.
  - **Outside modules:** `__future__`, `dataclasses`, `re`, `typing`.

- [`image-1.png`](../scribd/uploads/image-1.png) — Tracked PNG reference asset in uploads; no consumer is implied merely by its presence.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`image-2.png`](../scribd/uploads/image-2.png) — Tracked PNG reference asset in uploads; no consumer is implied merely by its presence.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`image-3.png`](../scribd/uploads/image-3.png) — Tracked PNG reference asset in uploads; no consumer is implied merely by its presence.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`image-4.png`](../scribd/uploads/image-4.png) — Tracked PNG reference asset in uploads; no consumer is implied merely by its presence.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`image-5.png`](../scribd/uploads/image-5.png) — Tracked PNG reference asset in uploads; no consumer is implied merely by its presence.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`image-6.png`](../scribd/uploads/image-6.png) — Tracked PNG reference asset in uploads; no consumer is implied merely by its presence.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`image-7.png`](../scribd/uploads/image-7.png) — Tracked PNG reference asset in uploads; no consumer is implied merely by its presence.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`main.py`](../scribd/uploads/main.py) — Separate image-based bulk Scribd-to-PDF command-line pipeline.
  - **References:**
    - [`scribd/uploads/build_pdf.py`](../scribd/uploads/build_pdf.py) — import.
    - [`scribd/uploads/cookies.py`](../scribd/uploads/cookies.py) — import.
    - [`scribd/uploads/download.py`](../scribd/uploads/download.py) — import.
    - [`scribd/uploads/extract.py`](../scribd/uploads/extract.py) — import.
    - [`scribd/uploads/requirements.txt`](../scribd/uploads/requirements.txt) — explicit relationship.
    - [`scribd/uploads/token.py`](../scribd/uploads/token.py) — import.
  - **Referenced by:**
    - [`scribd/uploads/requirements.txt`](../scribd/uploads/requirements.txt) — dependency manifest.
  - **Outside modules:** `__future__`, `argparse`, `pathlib`, `re`, `sys`.

- [`requirements.txt`](../scribd/uploads/requirements.txt) — Python dependencies for the separate uploads image-to-PDF pipeline.
  - **References:**
    - [`scribd/uploads/build_pdf.py`](../scribd/uploads/build_pdf.py) — dependency manifest.
    - [`scribd/uploads/cookies.py`](../scribd/uploads/cookies.py) — dependency manifest.
    - [`scribd/uploads/download.py`](../scribd/uploads/download.py) — dependency manifest.
    - [`scribd/uploads/extract.py`](../scribd/uploads/extract.py) — dependency manifest.
    - [`scribd/uploads/main.py`](../scribd/uploads/main.py) — dependency manifest.
    - [`scribd/uploads/token.py`](../scribd/uploads/token.py) — dependency manifest.
  - **Referenced by:**
    - [`scribd/uploads/main.py`](../scribd/uploads/main.py) — explicit relationship.

- [`ruff.toml`](../scribd/uploads/ruff.toml) — Ruff lint configuration scoped to the uploads pipeline.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`token.py`](../scribd/uploads/token.py) — Obtains and refreshes asset tokens and preserves the stdlib token interface when the local module shadows it.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`scribd/uploads/download.py`](../scribd/uploads/download.py) — import.
    - [`scribd/uploads/main.py`](../scribd/uploads/main.py) — import.
    - [`scribd/uploads/requirements.txt`](../scribd/uploads/requirements.txt) — dependency manifest.
  - **Outside modules:** `__future__`, `importlib.util`, `os`, `re`, `requests`, `sysconfig`, `urllib.parse`.

### `Whatsapp bot/`

- [`.env.example`](../Whatsapp%20bot/.env.example) — Template of the WhatsApp service environment settings; not the live secrets.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — explicit relationship.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — explicit relationship.
    - [`Whatsapp bot/utils/sessionBackup.js`](../Whatsapp%20bot/utils/sessionBackup.js) — explicit relationship.
  - **Referenced by:**
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — file name mentioned.

- [`.gitignore`](../Whatsapp%20bot/.gitignore) — Excludes bot dependencies, private credentials, session files, runtime databases, and scratch files.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`.npmrc`](../Whatsapp%20bot/.npmrc) — npm configuration for installing the bot project.
  - **References:** none detected in this snapshot.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`config.js`](../Whatsapp%20bot/config.js) — Loads bot configuration, defaults, environment values, and feature settings.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-media-downloads.js`](../Whatsapp%20bot/scripts/test-media-downloads.js) — computed bot-root path.
    - [`.github/tests/deploy-bot-gate.test.cjs`](../.github/tests/deploy-bot-gate.test.cjs) — file path mentioned.
    - [`Whatsapp bot/.env.example`](../Whatsapp%20bot/.env.example) — explicit relationship.
    - [`Whatsapp bot/commands/admin/botmanage.js`](../Whatsapp%20bot/commands/admin/botmanage.js) — require.
    - [`Whatsapp bot/commands/admin/toggle.js`](../Whatsapp%20bot/commands/admin/toggle.js) — require.
    - [`Whatsapp bot/commands/admin/ytdl.js`](../Whatsapp%20bot/commands/admin/ytdl.js) — require.
    - [`Whatsapp bot/commands/admin/ytlogin.js`](../Whatsapp%20bot/commands/admin/ytlogin.js) — require.
    - [`Whatsapp bot/commands/general/debrid.js`](../Whatsapp%20bot/commands/general/debrid.js) — require.
    - [`Whatsapp bot/commands/general/menu.js`](../Whatsapp%20bot/commands/general/menu.js) — require.
    - [`Whatsapp bot/commands/general/paper.js`](../Whatsapp%20bot/commands/general/paper.js) — require.
    - [`Whatsapp bot/commands/general/ping.js`](../Whatsapp%20bot/commands/general/ping.js) — require.
    - [`Whatsapp bot/commands/general/sticker.js`](../Whatsapp%20bot/commands/general/sticker.js) — require.
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — require.
    - [`Whatsapp bot/commands/media/shortcuts.js`](../Whatsapp%20bot/commands/media/shortcuts.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/spotify.js`](../Whatsapp%20bot/commands/media/spotify.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — file name mentioned.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/api.js`](../Whatsapp%20bot/utils/api.js) — require.
    - [`Whatsapp bot/utils/cleanup.js`](../Whatsapp%20bot/utils/cleanup.js) — require.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/downloadProviders.js`](../Whatsapp%20bot/utils/downloadProviders.js) — require.
    - [`Whatsapp bot/utils/jid.js`](../Whatsapp%20bot/utils/jid.js) — require.
    - [`Whatsapp bot/utils/jobQueue.js`](../Whatsapp%20bot/utils/jobQueue.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — require.
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — lazy import.
    - [`Whatsapp bot/utils/nm3u8dl.js`](../Whatsapp%20bot/utils/nm3u8dl.js) — require.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require.
    - [`Whatsapp bot/utils/spotify.js`](../Whatsapp%20bot/utils/spotify.js) — require.
    - [`Whatsapp bot/utils/userErrors.js`](../Whatsapp%20bot/utils/userErrors.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
    - [`Whatsapp bot/utils/youtubeSearch.js`](../Whatsapp%20bot/utils/youtubeSearch.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`database.js`](../Whatsapp%20bot/database.js) — Bot-local data and persisted WhatsApp service state.
  - **References:**
    - [`Whatsapp bot/utils/jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-provider-search-handler.js`](../Whatsapp%20bot/scripts/test-provider-search-handler.js) — require and test-only instrumentation.
    - [`Whatsapp bot/commands/admin/toggle.js`](../Whatsapp%20bot/commands/admin/toggle.js) — require.
    - [`Whatsapp bot/commands/general/paper.js`](../Whatsapp%20bot/commands/general/paper.js) — require.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — file name mentioned.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`handler.js`](../Whatsapp%20bot/handler.js) — Dispatches prefixed messages from each linked account to loaded commands, selections, and policy checks.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/database.js`](../Whatsapp%20bot/database.js) — require.
    - [`Whatsapp bot/utils/accountSockets.js`](../Whatsapp%20bot/utils/accountSockets.js) — require.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — require.
    - [`Whatsapp bot/utils/jid.js`](../Whatsapp%20bot/utils/jid.js) — require.
    - [`Whatsapp bot/utils/memberCommandPolicy.js`](../Whatsapp%20bot/utils/memberCommandPolicy.js) — require.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
    - [`Whatsapp bot/utils/userErrors.js`](../Whatsapp%20bot/utils/userErrors.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-provider-search-handler.js`](../Whatsapp%20bot/scripts/test-provider-search-handler.js) — require and test-only instrumentation.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — file name mentioned.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — require.
    - [`Whatsapp bot/utils/hotReload.js`](../Whatsapp%20bot/utils/hotReload.js) — computed bot-root path.

- [`index.js`](../Whatsapp%20bot/index.js) — Bot process entry point: initializes storage, recovery, sessions, sync, message handling, and media helpers.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/utils/accessControl.js`](../Whatsapp%20bot/utils/accessControl.js) — require.
    - [`Whatsapp bot/utils/adminApi.js`](../Whatsapp%20bot/utils/adminApi.js) — require.
    - [`Whatsapp bot/utils/cleanup.js`](../Whatsapp%20bot/utils/cleanup.js) — require.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
    - [`Whatsapp bot/utils/diskGuard.js`](../Whatsapp%20bot/utils/diskGuard.js) — require.
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — require.
    - [`Whatsapp bot/utils/hotReload.js`](../Whatsapp%20bot/utils/hotReload.js) — require.
    - [`Whatsapp bot/utils/jid.js`](../Whatsapp%20bot/utils/jid.js) — require.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
    - [`Whatsapp bot/utils/nm3u8dl.js`](../Whatsapp%20bot/utils/nm3u8dl.js) — require.
    - [`Whatsapp bot/utils/safeLog.js`](../Whatsapp%20bot/utils/safeLog.js) — require.
    - [`Whatsapp bot/utils/serviceStartup.js`](../Whatsapp%20bot/utils/serviceStartup.js) — require.
    - [`Whatsapp bot/utils/sessionBackup.js`](../Whatsapp%20bot/utils/sessionBackup.js) — require.
    - [`Whatsapp bot/utils/sessionManager.js`](../Whatsapp%20bot/utils/sessionManager.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
  - **Referenced by:**
    - [`.github/tests/deploy-bot-gate.test.cjs`](../.github/tests/deploy-bot-gate.test.cjs) — file path mentioned.
    - [`dashboard/README.md`](../dashboard/README.md) — file path mentioned.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship, file name mentioned.
    - [`Whatsapp bot/Procfile`](../Whatsapp%20bot/Procfile) — explicit relationship.
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — file name mentioned.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `@whiskeysockets/baileys`, `fs`, `path`, `pino`, `qrcode-terminal`, `zlib`.

- [`package-lock.json`](../Whatsapp%20bot/package-lock.json) — Pinned npm dependency graph used by npm ci for the bot.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — explicit relationship.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — npm lockfile.

- [`package.json`](../Whatsapp%20bot/package.json) — CommonJS bot package, dependencies, startup, and test scripts.
  - **References:**
    - [`Whatsapp bot/scripts/test-provider-search-handler.js`](../Whatsapp%20bot/scripts/test-provider-search-handler.js) — npm test:media script.
    - [`Whatsapp bot/scripts/test-provider-search.js`](../Whatsapp%20bot/scripts/test-provider-search.js) — npm test:media script.
    - [`Whatsapp bot/scripts/test-media-shortcuts.js`](../Whatsapp%20bot/scripts/test-media-shortcuts.js) — npm test:media script.
    - [`Whatsapp bot/scripts/test-media-downloads.js`](../Whatsapp%20bot/scripts/test-media-downloads.js) — npm test:media script.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — explicit relationship, file name mentioned.
    - [`Whatsapp bot/package-lock.json`](../Whatsapp%20bot/package-lock.json) — npm lockfile.
    - [`Whatsapp bot/scripts/install-ytdlp.sh`](../Whatsapp%20bot/scripts/install-ytdlp.sh) — explicit relationship.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — explicit relationship.
    - [`Whatsapp bot/scripts/test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — explicit relationship.
    - [`Whatsapp bot/scripts/test-bridge.js`](../Whatsapp%20bot/scripts/test-bridge.js) — explicit relationship.
    - [`Whatsapp bot/scripts/test-delivery.js`](../Whatsapp%20bot/scripts/test-delivery.js) — explicit relationship.
    - [`Whatsapp bot/scripts/test-provider-core.js`](../Whatsapp%20bot/scripts/test-provider-core.js) — explicit relationship.
    - [`Whatsapp bot/scripts/test-service-startup.js`](../Whatsapp%20bot/scripts/test-service-startup.js) — explicit relationship.
    - [`Whatsapp bot/scripts/test-session-backup.js`](../Whatsapp%20bot/scripts/test-session-backup.js) — explicit relationship.
    - [`Whatsapp bot/scripts/test-sessions.js`](../Whatsapp%20bot/scripts/test-sessions.js) — explicit relationship.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — explicit relationship.
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — file name mentioned.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.

- [`Procfile`](../Whatsapp%20bot/Procfile) — Panel/platform process declaration that starts the bot with Node.
  - **References:**
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — explicit relationship.
  - **Referenced by:**
    - [`Whatsapp bot/README.md`](../Whatsapp%20bot/README.md) — file name mentioned.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.

- [`README.md`](../Whatsapp%20bot/README.md) — Bot commands, operations, linking, backup, and deployment guidance; some older paths are stale.
  - **References:**
    - [`dashboard/README.md`](../dashboard/README.md) — documentation link, file path mentioned.
    - [`scribd/README.md`](../scribd/README.md) — file path mentioned.
    - [`Whatsapp bot/.env.example`](../Whatsapp%20bot/.env.example) — file name mentioned.
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — file name mentioned.
    - [`Whatsapp bot/database.js`](../Whatsapp%20bot/database.js) — file name mentioned.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — file name mentioned.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — file name mentioned.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — file name mentioned.
    - [`Whatsapp bot/Procfile`](../Whatsapp%20bot/Procfile) — file name mentioned.
  - **Referenced by:**
    - [`.github/tests/deploy-bot-gate.test.cjs`](../.github/tests/deploy-bot-gate.test.cjs) — file path mentioned.
    - [`README.md`](../README.md) — explicit relationship, documentation link.

### `Whatsapp bot/commands/admin/`

- [`botmanage.js`](../Whatsapp%20bot/commands/admin/botmanage.js) — Owner commands for status, restart, and broadcast.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/hotReload.js`](../Whatsapp%20bot/utils/hotReload.js) — require.
    - [`Whatsapp bot/utils/panelClient.js`](../Whatsapp%20bot/utils/panelClient.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`cookies.js`](../Whatsapp%20bot/commands/admin/cookies.js) — Owner command for managing YouTube cookie configuration.
  - **References:**
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.
  - **Outside modules:** `@whiskeysockets/baileys`.

- [`toggle.js`](../Whatsapp%20bot/commands/admin/toggle.js) — Owner command for enabling or disabling the service.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/database.js`](../Whatsapp%20bot/database.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`users.js`](../Whatsapp%20bot/commands/admin/users.js) — Owner commands for allowing, disallowing, and listing WhatsApp users.
  - **References:**
    - [`Whatsapp bot/utils/accessControl.js`](../Whatsapp%20bot/utils/accessControl.js) — require.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
    - [`Whatsapp bot/utils/jid.js`](../Whatsapp%20bot/utils/jid.js) — require.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`ytdl.js`](../Whatsapp%20bot/commands/admin/ytdl.js) — Owner diagnostics and controls for yt-dlp.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/downloadProviders.js`](../Whatsapp%20bot/utils/downloadProviders.js) — require.
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — require.
    - [`Whatsapp bot/utils/mediaSettings.js`](../Whatsapp%20bot/utils/mediaSettings.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
    - [`Whatsapp bot/utils/ytAuth.js`](../Whatsapp%20bot/utils/ytAuth.js) — require.
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`ytlogin.js`](../Whatsapp%20bot/commands/admin/ytlogin.js) — Owner command for YouTube device/OAuth login.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/ytAuth.js`](../Whatsapp%20bot/utils/ytAuth.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

### `Whatsapp bot/commands/general/`

- [`debrid.js`](../Whatsapp%20bot/commands/general/debrid.js) — Reports debrid-provider status.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`info.js`](../Whatsapp%20bot/commands/general/info.js) — Looks up media-title metadata.
  - **References:**
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`menu.js`](../Whatsapp%20bot/commands/general/menu.js) — Builds the WhatsApp command menu.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/userErrors.js`](../Whatsapp%20bot/utils/userErrors.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-media-shortcuts.js`](../Whatsapp%20bot/scripts/test-media-shortcuts.js) — computed bot-root path.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`paper.js`](../Whatsapp%20bot/commands/general/paper.js) — Searches, counts, refreshes, and sends exam papers.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/database.js`](../Whatsapp%20bot/database.js) — require.
    - [`Whatsapp bot/utils/jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — require.
    - [`Whatsapp bot/utils/paperSearch.js`](../Whatsapp%20bot/utils/paperSearch.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.
  - **Outside modules:** `axios`, `fs`, `https`, `path`, `stream/promises`.

- [`ping.js`](../Whatsapp%20bot/commands/general/ping.js) — Reports response latency.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`providers.js`](../Whatsapp%20bot/commands/general/providers.js) — Reports providers and movie-engine status.
  - **References:**
    - [`Whatsapp bot/utils/cleanup.js`](../Whatsapp%20bot/utils/cleanup.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — require.
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — require.
    - [`Whatsapp bot/utils/nm3u8dl.js`](../Whatsapp%20bot/utils/nm3u8dl.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`sticker.js`](../Whatsapp%20bot/commands/general/sticker.js) — Converts image or video input to a sticker.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.
  - **Outside modules:** `@whiskeysockets/baileys`, `child_process`, `crypto`, `fs`, `node-webpmux`, `path`.

- [`viewonce.js`](../Whatsapp%20bot/commands/general/viewonce.js) — Handles supported view-once media retrieval.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.
  - **Outside modules:** `@whiskeysockets/baileys`.

### `Whatsapp bot/commands/media/`

- [`dl.js`](../Whatsapp%20bot/commands/media/dl.js) — Downloads media from a supplied URL.
  - **References:**
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`movie.js`](../Whatsapp%20bot/commands/media/movie.js) — Searches and delivers selected movies.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — require.
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — require.
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — require.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
    - [`Whatsapp bot/utils/userErrors.js`](../Whatsapp%20bot/utils/userErrors.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — require.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.
  - **Outside modules:** `fs`, `path`.

- [`series.js`](../Whatsapp%20bot/commands/media/series.js) — Searches and delivers selected series episodes or seasons.
  - **References:**
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — require.
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — require.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
    - [`Whatsapp bot/utils/userErrors.js`](../Whatsapp%20bot/utils/userErrors.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.
  - **Outside modules:** `fs`, `path`.

- [`shortcuts.js`](../Whatsapp%20bot/commands/media/shortcuts.js) — Social-media download shortcuts and provider-scoped title search with numbered selections.
  - **References:**
    - [`Whatsapp bot/utils/jobQueue.js`](../Whatsapp%20bot/utils/jobQueue.js) — require.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require.
    - [`Whatsapp bot/utils/providerSearch.js`](../Whatsapp%20bot/utils/providerSearch.js) — require.
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-media-shortcuts.js`](../Whatsapp%20bot/scripts/test-media-shortcuts.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`song.js`](../Whatsapp%20bot/commands/media/song.js) — Searches and downloads YouTube audio.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/downloadProviders.js`](../Whatsapp%20bot/utils/downloadProviders.js) — require.
    - [`Whatsapp bot/utils/jobQueue.js`](../Whatsapp%20bot/utils/jobQueue.js) — require.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
    - [`Whatsapp bot/utils/mediaSettings.js`](../Whatsapp%20bot/utils/mediaSettings.js) — require.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — require.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
    - [`Whatsapp bot/utils/userErrors.js`](../Whatsapp%20bot/utils/userErrors.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
    - [`Whatsapp bot/utils/youtubeSearch.js`](../Whatsapp%20bot/utils/youtubeSearch.js) — require.
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.
  - **Outside modules:** `fs`, `path`.

- [`spotify.js`](../Whatsapp%20bot/commands/media/spotify.js) — Resolves a Spotify track and downloads matching audio.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
    - [`Whatsapp bot/utils/spotify.js`](../Whatsapp%20bot/utils/spotify.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
    - [`Whatsapp bot/utils/youtubeSearch.js`](../Whatsapp%20bot/utils/youtubeSearch.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.

- [`ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — Searches and downloads YouTube video.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/downloadProviders.js`](../Whatsapp%20bot/utils/downloadProviders.js) — require.
    - [`Whatsapp bot/utils/jobQueue.js`](../Whatsapp%20bot/utils/jobQueue.js) — require.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
    - [`Whatsapp bot/utils/mediaSettings.js`](../Whatsapp%20bot/utils/mediaSettings.js) — require.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — require.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
    - [`Whatsapp bot/utils/userErrors.js`](../Whatsapp%20bot/utils/userErrors.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
    - [`Whatsapp bot/utils/youtubeSearch.js`](../Whatsapp%20bot/utils/youtubeSearch.js) — require.
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — dynamic command discovery.
  - **Outside modules:** `fs`, `path`.

### `Whatsapp bot/engine/`

- [`config.js`](../Whatsapp%20bot/engine/config.js) — Environment-based configuration for the media engine.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/queue.js`](../Whatsapp%20bot/engine/core/queue.js) — import.
    - [`Whatsapp bot/engine/core/ranker.js`](../Whatsapp%20bot/engine/core/ranker.js) — import.
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/core/verify.js`](../Whatsapp%20bot/engine/core/verify.js) — import.
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — import.
    - [`Whatsapp bot/engine/media/downloader.js`](../Whatsapp%20bot/engine/media/downloader.js) — import.
    - [`Whatsapp bot/engine/media/hls.js`](../Whatsapp%20bot/engine/media/hls.js) — import.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/media/torrent.js`](../Whatsapp%20bot/engine/media/torrent.js) — import.
    - [`Whatsapp bot/engine/metadata/anilist.js`](../Whatsapp%20bot/engine/metadata/anilist.js) — import.
    - [`Whatsapp bot/engine/metadata/cinemeta.js`](../Whatsapp%20bot/engine/metadata/cinemeta.js) — import.
    - [`Whatsapp bot/engine/metadata/imdb.js`](../Whatsapp%20bot/engine/metadata/imdb.js) — import.
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/metadata/jikan.js`](../Whatsapp%20bot/engine/metadata/jikan.js) — import.
    - [`Whatsapp bot/engine/metadata/omdb.js`](../Whatsapp%20bot/engine/metadata/omdb.js) — import.
    - [`Whatsapp bot/engine/metadata/tmdb.js`](../Whatsapp%20bot/engine/metadata/tmdb.js) — import.
    - [`Whatsapp bot/engine/metadata/trakt.js`](../Whatsapp%20bot/engine/metadata/trakt.js) — import.
    - [`Whatsapp bot/engine/metadata/tvmaze.js`](../Whatsapp%20bot/engine/metadata/tvmaze.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/debrid/alldebrid.js`](../Whatsapp%20bot/engine/providers/debrid/alldebrid.js) — import.
    - [`Whatsapp bot/engine/providers/debrid/index.js`](../Whatsapp%20bot/engine/providers/debrid/index.js) — import.
    - [`Whatsapp bot/engine/providers/debrid/realdebrid.js`](../Whatsapp%20bot/engine/providers/debrid/realdebrid.js) — import.
    - [`Whatsapp bot/engine/providers/stream/moviebox.js`](../Whatsapp%20bot/engine/providers/stream/moviebox.js) — import.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `node:fs`, `node:path`.

- [`host.js`](../Whatsapp%20bot/engine/host.js) — Lazy bridge from the ES-module engine to the bot's CommonJS host adapter.
  - **References:**
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — lazy import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
  - **Outside modules:** `node:module`.

- [`package.json`](../Whatsapp%20bot/engine/package.json) — Nested package boundary that makes the movie engine files ES modules.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/events.js`](../Whatsapp%20bot/engine/core/events.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/extract.js`](../Whatsapp%20bot/engine/core/extract.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/jar.js`](../Whatsapp%20bot/engine/core/jar.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/log.js`](../Whatsapp%20bot/engine/core/log.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/mirrors.js`](../Whatsapp%20bot/engine/core/mirrors.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/queue.js`](../Whatsapp%20bot/engine/core/queue.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/ranker.js`](../Whatsapp%20bot/engine/core/ranker.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/reliability.js`](../Whatsapp%20bot/engine/core/reliability.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/tv.js`](../Whatsapp%20bot/engine/core/tv.js) — ES module boundary.
    - [`Whatsapp bot/engine/core/verify.js`](../Whatsapp%20bot/engine/core/verify.js) — ES module boundary.
    - [`Whatsapp bot/engine/host.js`](../Whatsapp%20bot/engine/host.js) — ES module boundary.
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — ES module boundary.
    - [`Whatsapp bot/engine/media/downloader.js`](../Whatsapp%20bot/engine/media/downloader.js) — ES module boundary.
    - [`Whatsapp bot/engine/media/hls.js`](../Whatsapp%20bot/engine/media/hls.js) — ES module boundary.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — ES module boundary.
    - [`Whatsapp bot/engine/media/torrent.js`](../Whatsapp%20bot/engine/media/torrent.js) — ES module boundary.
    - [`Whatsapp bot/engine/metadata/anilist.js`](../Whatsapp%20bot/engine/metadata/anilist.js) — ES module boundary.
    - [`Whatsapp bot/engine/metadata/cinemeta.js`](../Whatsapp%20bot/engine/metadata/cinemeta.js) — ES module boundary.
    - [`Whatsapp bot/engine/metadata/imdb.js`](../Whatsapp%20bot/engine/metadata/imdb.js) — ES module boundary.
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — ES module boundary.
    - [`Whatsapp bot/engine/metadata/jikan.js`](../Whatsapp%20bot/engine/metadata/jikan.js) — ES module boundary.
    - [`Whatsapp bot/engine/metadata/omdb.js`](../Whatsapp%20bot/engine/metadata/omdb.js) — ES module boundary.
    - [`Whatsapp bot/engine/metadata/tmdb.js`](../Whatsapp%20bot/engine/metadata/tmdb.js) — ES module boundary.
    - [`Whatsapp bot/engine/metadata/trakt.js`](../Whatsapp%20bot/engine/metadata/trakt.js) — ES module boundary.
    - [`Whatsapp bot/engine/metadata/tvmaze.js`](../Whatsapp%20bot/engine/metadata/tvmaze.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/ddl/fourkhdhub.js`](../Whatsapp%20bot/engine/providers/ddl/fourkhdhub.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/ddl/hdhub4u.js`](../Whatsapp%20bot/engine/providers/ddl/hdhub4u.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/ddl/moviesdrive.js`](../Whatsapp%20bot/engine/providers/ddl/moviesdrive.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/debrid/alldebrid.js`](../Whatsapp%20bot/engine/providers/debrid/alldebrid.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/debrid/index.js`](../Whatsapp%20bot/engine/providers/debrid/index.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/debrid/realdebrid.js`](../Whatsapp%20bot/engine/providers/debrid/realdebrid.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/stream/moviebox.js`](../Whatsapp%20bot/engine/providers/stream/moviebox.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/stream/vaplayer.js`](../Whatsapp%20bot/engine/providers/stream/vaplayer.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/stream/videasy.js`](../Whatsapp%20bot/engine/providers/stream/videasy.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/stream/vidlink.js`](../Whatsapp%20bot/engine/providers/stream/vidlink.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/stream/vidsrc.js`](../Whatsapp%20bot/engine/providers/stream/vidsrc.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/stream/vixsrc.js`](../Whatsapp%20bot/engine/providers/stream/vixsrc.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/torrent/_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/torrent/apibay.js`](../Whatsapp%20bot/engine/providers/torrent/apibay.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/torrent/eztv.js`](../Whatsapp%20bot/engine/providers/torrent/eztv.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/torrent/knaben.js`](../Whatsapp%20bot/engine/providers/torrent/knaben.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/torrent/nyaa.js`](../Whatsapp%20bot/engine/providers/torrent/nyaa.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/torrent/solidtorrents.js`](../Whatsapp%20bot/engine/providers/torrent/solidtorrents.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/torrent/torrentio.js`](../Whatsapp%20bot/engine/providers/torrent/torrentio.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/torrent/torrentscsv.js`](../Whatsapp%20bot/engine/providers/torrent/torrentscsv.js) — ES module boundary.
    - [`Whatsapp bot/engine/providers/torrent/yts.js`](../Whatsapp%20bot/engine/providers/torrent/yts.js) — ES module boundary.
    - [`Whatsapp bot/engine/utils/disk.js`](../Whatsapp%20bot/engine/utils/disk.js) — ES module boundary.
    - [`Whatsapp bot/engine/utils/format.js`](../Whatsapp%20bot/engine/utils/format.js) — ES module boundary.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

### `Whatsapp bot/engine/core/`

- [`cache.js`](../Whatsapp%20bot/engine/core/cache.js) — Media result cache and persistent cache management.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/events.js`](../Whatsapp%20bot/engine/core/events.js) — import.
    - [`Whatsapp bot/engine/core/log.js`](../Whatsapp%20bot/engine/core/log.js) — import.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — import.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/media/torrent.js`](../Whatsapp%20bot/engine/media/torrent.js) — import.
    - [`Whatsapp bot/engine/metadata/anilist.js`](../Whatsapp%20bot/engine/metadata/anilist.js) — import.
    - [`Whatsapp bot/engine/metadata/cinemeta.js`](../Whatsapp%20bot/engine/metadata/cinemeta.js) — import.
    - [`Whatsapp bot/engine/metadata/imdb.js`](../Whatsapp%20bot/engine/metadata/imdb.js) — import.
    - [`Whatsapp bot/engine/metadata/jikan.js`](../Whatsapp%20bot/engine/metadata/jikan.js) — import.
    - [`Whatsapp bot/engine/metadata/omdb.js`](../Whatsapp%20bot/engine/metadata/omdb.js) — import.
    - [`Whatsapp bot/engine/metadata/tmdb.js`](../Whatsapp%20bot/engine/metadata/tmdb.js) — import.
    - [`Whatsapp bot/engine/metadata/trakt.js`](../Whatsapp%20bot/engine/metadata/trakt.js) — import.
    - [`Whatsapp bot/engine/metadata/tvmaze.js`](../Whatsapp%20bot/engine/metadata/tvmaze.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/debrid/index.js`](../Whatsapp%20bot/engine/providers/debrid/index.js) — import.
  - **Outside modules:** `node:fs`, `node:path`.

- [`events.js`](../Whatsapp%20bot/engine/core/events.js) — Engine event bus for progress and telemetry.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/core/verify.js`](../Whatsapp%20bot/engine/core/verify.js) — import.
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — import.
    - [`Whatsapp bot/engine/media/torrent.js`](../Whatsapp%20bot/engine/media/torrent.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
  - **Outside modules:** `node:events`.

- [`extract.js`](../Whatsapp%20bot/engine/core/extract.js) — Decodes and extracts provider/locker links.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/stream/videasy.js`](../Whatsapp%20bot/engine/providers/stream/videasy.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vidsrc.js`](../Whatsapp%20bot/engine/providers/stream/vidsrc.js) — import.

- [`http.js`](../Whatsapp%20bot/engine/core/http.js) — Shared provider HTTP requests, retries, and lightweight HTML helpers.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/jar.js`](../Whatsapp%20bot/engine/core/jar.js) — import.
    - [`Whatsapp bot/engine/core/log.js`](../Whatsapp%20bot/engine/core/log.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/metadata/anilist.js`](../Whatsapp%20bot/engine/metadata/anilist.js) — import.
    - [`Whatsapp bot/engine/metadata/cinemeta.js`](../Whatsapp%20bot/engine/metadata/cinemeta.js) — import.
    - [`Whatsapp bot/engine/metadata/imdb.js`](../Whatsapp%20bot/engine/metadata/imdb.js) — import.
    - [`Whatsapp bot/engine/metadata/jikan.js`](../Whatsapp%20bot/engine/metadata/jikan.js) — import.
    - [`Whatsapp bot/engine/metadata/omdb.js`](../Whatsapp%20bot/engine/metadata/omdb.js) — import.
    - [`Whatsapp bot/engine/metadata/tmdb.js`](../Whatsapp%20bot/engine/metadata/tmdb.js) — import.
    - [`Whatsapp bot/engine/metadata/trakt.js`](../Whatsapp%20bot/engine/metadata/trakt.js) — import.
    - [`Whatsapp bot/engine/metadata/tvmaze.js`](../Whatsapp%20bot/engine/metadata/tvmaze.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/ddl/fourkhdhub.js`](../Whatsapp%20bot/engine/providers/ddl/fourkhdhub.js) — import.
    - [`Whatsapp bot/engine/providers/ddl/hdhub4u.js`](../Whatsapp%20bot/engine/providers/ddl/hdhub4u.js) — import.
    - [`Whatsapp bot/engine/providers/ddl/moviesdrive.js`](../Whatsapp%20bot/engine/providers/ddl/moviesdrive.js) — import.
    - [`Whatsapp bot/engine/providers/stream/moviebox.js`](../Whatsapp%20bot/engine/providers/stream/moviebox.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vaplayer.js`](../Whatsapp%20bot/engine/providers/stream/vaplayer.js) — import.
    - [`Whatsapp bot/engine/providers/stream/videasy.js`](../Whatsapp%20bot/engine/providers/stream/videasy.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vidlink.js`](../Whatsapp%20bot/engine/providers/stream/vidlink.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vidsrc.js`](../Whatsapp%20bot/engine/providers/stream/vidsrc.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vixsrc.js`](../Whatsapp%20bot/engine/providers/stream/vixsrc.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/apibay.js`](../Whatsapp%20bot/engine/providers/torrent/apibay.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/eztv.js`](../Whatsapp%20bot/engine/providers/torrent/eztv.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/knaben.js`](../Whatsapp%20bot/engine/providers/torrent/knaben.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/nyaa.js`](../Whatsapp%20bot/engine/providers/torrent/nyaa.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/solidtorrents.js`](../Whatsapp%20bot/engine/providers/torrent/solidtorrents.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/torrentio.js`](../Whatsapp%20bot/engine/providers/torrent/torrentio.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/torrentscsv.js`](../Whatsapp%20bot/engine/providers/torrent/torrentscsv.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/yts.js`](../Whatsapp%20bot/engine/providers/torrent/yts.js) — import.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `node:dns`.

- [`jar.js`](../Whatsapp%20bot/engine/core/jar.js) — Per-host HTTP cookie jar.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`log.js`](../Whatsapp%20bot/engine/core/log.js) — ES-module engine logger.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/queue.js`](../Whatsapp%20bot/engine/core/queue.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/stream/moviebox.js`](../Whatsapp%20bot/engine/providers/stream/moviebox.js) — import.

- [`metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — Engine counters and latency metrics.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/core/verify.js`](../Whatsapp%20bot/engine/core/verify.js) — import.
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — import.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/media/torrent.js`](../Whatsapp%20bot/engine/media/torrent.js) — import.
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/debrid/index.js`](../Whatsapp%20bot/engine/providers/debrid/index.js) — import.
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — computed dynamic import.

- [`mirrors.js`](../Whatsapp%20bot/engine/core/mirrors.js) — Provider mirror selection and health memory.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/ddl/fourkhdhub.js`](../Whatsapp%20bot/engine/providers/ddl/fourkhdhub.js) — import.
    - [`Whatsapp bot/engine/providers/ddl/hdhub4u.js`](../Whatsapp%20bot/engine/providers/ddl/hdhub4u.js) — import.
    - [`Whatsapp bot/engine/providers/ddl/moviesdrive.js`](../Whatsapp%20bot/engine/providers/ddl/moviesdrive.js) — import.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.

- [`queue.js`](../Whatsapp%20bot/engine/core/queue.js) — Concurrency-limited media job queue.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/log.js`](../Whatsapp%20bot/engine/core/log.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`ranker.js`](../Whatsapp%20bot/engine/core/ranker.js) — Scores and ranks media candidates.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/reliability.js`](../Whatsapp%20bot/engine/core/reliability.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.

- [`registry.js`](../Whatsapp%20bot/engine/core/registry.js) — Provider registration, health, and circuit breaker.
  - **References:**
    - [`Whatsapp bot/engine/core/events.js`](../Whatsapp%20bot/engine/core/events.js) — import.
    - [`Whatsapp bot/engine/core/log.js`](../Whatsapp%20bot/engine/core/log.js) — import.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — import.
    - [`Whatsapp bot/engine/core/reliability.js`](../Whatsapp%20bot/engine/core/reliability.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/ranker.js`](../Whatsapp%20bot/engine/core/ranker.js) — import.
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/ddl/fourkhdhub.js`](../Whatsapp%20bot/engine/providers/ddl/fourkhdhub.js) — import.
    - [`Whatsapp bot/engine/providers/ddl/hdhub4u.js`](../Whatsapp%20bot/engine/providers/ddl/hdhub4u.js) — import.
    - [`Whatsapp bot/engine/providers/ddl/moviesdrive.js`](../Whatsapp%20bot/engine/providers/ddl/moviesdrive.js) — import.
    - [`Whatsapp bot/engine/providers/stream/moviebox.js`](../Whatsapp%20bot/engine/providers/stream/moviebox.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vaplayer.js`](../Whatsapp%20bot/engine/providers/stream/vaplayer.js) — import.
    - [`Whatsapp bot/engine/providers/stream/videasy.js`](../Whatsapp%20bot/engine/providers/stream/videasy.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vidlink.js`](../Whatsapp%20bot/engine/providers/stream/vidlink.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vidsrc.js`](../Whatsapp%20bot/engine/providers/stream/vidsrc.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vixsrc.js`](../Whatsapp%20bot/engine/providers/stream/vixsrc.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/apibay.js`](../Whatsapp%20bot/engine/providers/torrent/apibay.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/eztv.js`](../Whatsapp%20bot/engine/providers/torrent/eztv.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/knaben.js`](../Whatsapp%20bot/engine/providers/torrent/knaben.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/nyaa.js`](../Whatsapp%20bot/engine/providers/torrent/nyaa.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/solidtorrents.js`](../Whatsapp%20bot/engine/providers/torrent/solidtorrents.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/torrentio.js`](../Whatsapp%20bot/engine/providers/torrent/torrentio.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/torrentscsv.js`](../Whatsapp%20bot/engine/providers/torrent/torrentscsv.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/yts.js`](../Whatsapp%20bot/engine/providers/torrent/yts.js) — import.

- [`release.js`](../Whatsapp%20bot/engine/core/release.js) — Parses release names, quality, language, and episode details.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/tv.js`](../Whatsapp%20bot/engine/core/tv.js) — import.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/ddl/fourkhdhub.js`](../Whatsapp%20bot/engine/providers/ddl/fourkhdhub.js) — import.
    - [`Whatsapp bot/engine/providers/ddl/hdhub4u.js`](../Whatsapp%20bot/engine/providers/ddl/hdhub4u.js) — import.
    - [`Whatsapp bot/engine/providers/ddl/moviesdrive.js`](../Whatsapp%20bot/engine/providers/ddl/moviesdrive.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/apibay.js`](../Whatsapp%20bot/engine/providers/torrent/apibay.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/eztv.js`](../Whatsapp%20bot/engine/providers/torrent/eztv.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/knaben.js`](../Whatsapp%20bot/engine/providers/torrent/knaben.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/nyaa.js`](../Whatsapp%20bot/engine/providers/torrent/nyaa.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/solidtorrents.js`](../Whatsapp%20bot/engine/providers/torrent/solidtorrents.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/torrentio.js`](../Whatsapp%20bot/engine/providers/torrent/torrentio.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/torrentscsv.js`](../Whatsapp%20bot/engine/providers/torrent/torrentscsv.js) — import.

- [`reliability.js`](../Whatsapp%20bot/engine/core/reliability.js) — Canonical provider reliability ordering.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/ranker.js`](../Whatsapp%20bot/engine/core/ranker.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — Searches providers in tiers and resolves candidates.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/events.js`](../Whatsapp%20bot/engine/core/events.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/log.js`](../Whatsapp%20bot/engine/core/log.js) — import.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — import.
    - [`Whatsapp bot/engine/core/ranker.js`](../Whatsapp%20bot/engine/core/ranker.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/verify.js`](../Whatsapp%20bot/engine/core/verify.js) — import.
    - [`Whatsapp bot/engine/media/torrent.js`](../Whatsapp%20bot/engine/media/torrent.js) — import.
    - [`Whatsapp bot/engine/providers/debrid/index.js`](../Whatsapp%20bot/engine/providers/debrid/index.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.

- [`tv.js`](../Whatsapp%20bot/engine/core/tv.js) — Series, season, episode, and pack selection helpers.
  - **References:**
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`verify.js`](../Whatsapp%20bot/engine/core/verify.js) — Checks candidate media before or during delivery.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/events.js`](../Whatsapp%20bot/engine/core/events.js) — import.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — import.
    - [`Whatsapp bot/engine/utils/disk.js`](../Whatsapp%20bot/engine/utils/disk.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
  - **Outside modules:** `node:child_process`, `node:fs`, `node:os`, `node:path`.

### `Whatsapp bot/engine/media/`

- [`download.js`](../Whatsapp%20bot/engine/media/download.js) — Shared media download and filename helpers.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/events.js`](../Whatsapp%20bot/engine/core/events.js) — import.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — import.
    - [`Whatsapp bot/engine/host.js`](../Whatsapp%20bot/engine/host.js) — import.
    - [`Whatsapp bot/engine/media/hls.js`](../Whatsapp%20bot/engine/media/hls.js) — import.
    - [`Whatsapp bot/engine/utils/disk.js`](../Whatsapp%20bot/engine/utils/disk.js) — import.
    - [`Whatsapp bot/engine/utils/format.js`](../Whatsapp%20bot/engine/utils/format.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/downloader.js`](../Whatsapp%20bot/engine/media/downloader.js) — import.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-nm3u8dl-live.js`](../Whatsapp%20bot/scripts/test-nm3u8dl-live.js) — computed bot-root path.
  - **Outside modules:** `node:child_process`, `node:fs`, `node:path`.

- [`downloader.js`](../Whatsapp%20bot/engine/media/downloader.js) — Dispatches download methods for resolved media.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — import.
    - [`Whatsapp bot/engine/media/torrent.js`](../Whatsapp%20bot/engine/media/torrent.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — computed dynamic import.

- [`hls.js`](../Whatsapp%20bot/engine/media/hls.js) — HLS and DASH download handling and fallback.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `node:crypto`, `node:fs`, `node:path`.

- [`index.js`](../Whatsapp%20bot/engine/media/index.js) — Main movie/series engine API; imports and registers the selected providers.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/log.js`](../Whatsapp%20bot/engine/core/log.js) — import.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — import.
    - [`Whatsapp bot/engine/core/mirrors.js`](../Whatsapp%20bot/engine/core/mirrors.js) — import.
    - [`Whatsapp bot/engine/core/queue.js`](../Whatsapp%20bot/engine/core/queue.js) — import.
    - [`Whatsapp bot/engine/core/ranker.js`](../Whatsapp%20bot/engine/core/ranker.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/core/tv.js`](../Whatsapp%20bot/engine/core/tv.js) — import.
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — import.
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/metadata/tmdb.js`](../Whatsapp%20bot/engine/metadata/tmdb.js) — import.
    - [`Whatsapp bot/engine/providers/debrid/index.js`](../Whatsapp%20bot/engine/providers/debrid/index.js) — import.
    - [`Whatsapp bot/engine/providers/stream/moviebox.js`](../Whatsapp%20bot/engine/providers/stream/moviebox.js) — import, dynamic import.
    - [`Whatsapp bot/engine/providers/stream/vaplayer.js`](../Whatsapp%20bot/engine/providers/stream/vaplayer.js) — import.
    - [`Whatsapp bot/engine/providers/stream/videasy.js`](../Whatsapp%20bot/engine/providers/stream/videasy.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vidlink.js`](../Whatsapp%20bot/engine/providers/stream/vidlink.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vidsrc.js`](../Whatsapp%20bot/engine/providers/stream/vidsrc.js) — import.
    - [`Whatsapp bot/engine/providers/stream/vixsrc.js`](../Whatsapp%20bot/engine/providers/stream/vixsrc.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/apibay.js`](../Whatsapp%20bot/engine/providers/torrent/apibay.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/eztv.js`](../Whatsapp%20bot/engine/providers/torrent/eztv.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/knaben.js`](../Whatsapp%20bot/engine/providers/torrent/knaben.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/nyaa.js`](../Whatsapp%20bot/engine/providers/torrent/nyaa.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/solidtorrents.js`](../Whatsapp%20bot/engine/providers/torrent/solidtorrents.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/torrentio.js`](../Whatsapp%20bot/engine/providers/torrent/torrentio.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/torrentscsv.js`](../Whatsapp%20bot/engine/providers/torrent/torrentscsv.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/yts.js`](../Whatsapp%20bot/engine/providers/torrent/yts.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — computed dynamic import.
  - **Outside modules:** `node:path`.

- [`torrent.js`](../Whatsapp%20bot/engine/media/torrent.js) — Torrent download and file-selection handling.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/events.js`](../Whatsapp%20bot/engine/core/events.js) — import.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/media/downloader.js`](../Whatsapp%20bot/engine/media/downloader.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `node:fs`, `node:path`, `webtorrent`.

### `Whatsapp bot/engine/metadata/`

- [`anilist.js`](../Whatsapp%20bot/engine/metadata/anilist.js) — AniList anime metadata adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`cinemeta.js`](../Whatsapp%20bot/engine/metadata/cinemeta.js) — Cinemeta metadata adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`imdb.js`](../Whatsapp%20bot/engine/metadata/imdb.js) — IMDb metadata adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
  - **Outside modules:** `node:fs`, `node:readline`.

- [`index.js`](../Whatsapp%20bot/engine/metadata/index.js) — Aggregates metadata searches and falls back across the available sources.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/log.js`](../Whatsapp%20bot/engine/core/log.js) — import.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — import.
    - [`Whatsapp bot/engine/metadata/anilist.js`](../Whatsapp%20bot/engine/metadata/anilist.js) — import.
    - [`Whatsapp bot/engine/metadata/cinemeta.js`](../Whatsapp%20bot/engine/metadata/cinemeta.js) — import.
    - [`Whatsapp bot/engine/metadata/imdb.js`](../Whatsapp%20bot/engine/metadata/imdb.js) — import.
    - [`Whatsapp bot/engine/metadata/jikan.js`](../Whatsapp%20bot/engine/metadata/jikan.js) — import.
    - [`Whatsapp bot/engine/metadata/omdb.js`](../Whatsapp%20bot/engine/metadata/omdb.js) — import.
    - [`Whatsapp bot/engine/metadata/tmdb.js`](../Whatsapp%20bot/engine/metadata/tmdb.js) — import.
    - [`Whatsapp bot/engine/metadata/trakt.js`](../Whatsapp%20bot/engine/metadata/trakt.js) — import.
    - [`Whatsapp bot/engine/metadata/tvmaze.js`](../Whatsapp%20bot/engine/metadata/tvmaze.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`jikan.js`](../Whatsapp%20bot/engine/metadata/jikan.js) — Jikan/MyAnimeList anime metadata adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`omdb.js`](../Whatsapp%20bot/engine/metadata/omdb.js) — OMDb metadata adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`tmdb.js`](../Whatsapp%20bot/engine/metadata/tmdb.js) — TMDB movie and series metadata adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`trakt.js`](../Whatsapp%20bot/engine/metadata/trakt.js) — Trakt metadata adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`tvmaze.js`](../Whatsapp%20bot/engine/metadata/tvmaze.js) — TVMaze metadata adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/metadata/index.js`](../Whatsapp%20bot/engine/metadata/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

### `Whatsapp bot/engine/providers/ddl/`

- [`fourkhdhub.js`](../Whatsapp%20bot/engine/providers/ddl/fourkhdhub.js) — 4KHDHub direct-download adapter; registers itself if loaded, but is not imported by the current engine entry point.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/mirrors.js`](../Whatsapp%20bot/engine/core/mirrors.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`hdhub4u.js`](../Whatsapp%20bot/engine/providers/ddl/hdhub4u.js) — HDHub4U direct-download adapter; registers itself if loaded, but is not imported by the current engine entry point.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/mirrors.js`](../Whatsapp%20bot/engine/core/mirrors.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`moviesdrive.js`](../Whatsapp%20bot/engine/providers/ddl/moviesdrive.js) — MoviesDrive direct-download adapter; registers itself if loaded, but is not imported by the current engine entry point.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/mirrors.js`](../Whatsapp%20bot/engine/core/mirrors.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

### `Whatsapp bot/engine/providers/debrid/`

- [`alldebrid.js`](../Whatsapp%20bot/engine/providers/debrid/alldebrid.js) — AllDebrid provider adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/debrid/index.js`](../Whatsapp%20bot/engine/providers/debrid/index.js) — import.

- [`index.js`](../Whatsapp%20bot/engine/providers/debrid/index.js) — Combines available debrid providers.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/cache.js`](../Whatsapp%20bot/engine/core/cache.js) — import.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — import.
    - [`Whatsapp bot/engine/providers/debrid/alldebrid.js`](../Whatsapp%20bot/engine/providers/debrid/alldebrid.js) — import.
    - [`Whatsapp bot/engine/providers/debrid/realdebrid.js`](../Whatsapp%20bot/engine/providers/debrid/realdebrid.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.

- [`realdebrid.js`](../Whatsapp%20bot/engine/providers/debrid/realdebrid.js) — Real-Debrid provider adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/debrid/index.js`](../Whatsapp%20bot/engine/providers/debrid/index.js) — import.

### `Whatsapp bot/engine/providers/stream/`

- [`moviebox.js`](../Whatsapp%20bot/engine/providers/stream/moviebox.js) — MovieBox stream-source adapter.
  - **References:**
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/log.js`](../Whatsapp%20bot/engine/core/log.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import, dynamic import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `node:fs`, `node:path`.

- [`vaplayer.js`](../Whatsapp%20bot/engine/providers/stream/vaplayer.js) — VAPlayer stream-source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`videasy.js`](../Whatsapp%20bot/engine/providers/stream/videasy.js) — Videasy stream-source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/extract.js`](../Whatsapp%20bot/engine/core/extract.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`vidlink.js`](../Whatsapp%20bot/engine/providers/stream/vidlink.js) — VidLink stream-source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`vidsrc.js`](../Whatsapp%20bot/engine/providers/stream/vidsrc.js) — VidSrc stream-source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/extract.js`](../Whatsapp%20bot/engine/core/extract.js) — import.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`vixsrc.js`](../Whatsapp%20bot/engine/providers/stream/vixsrc.js) — VixSrc stream-source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

### `Whatsapp bot/engine/providers/torrent/`

- [`_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — Shared torrent tracker list.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
    - [`Whatsapp bot/engine/providers/torrent/apibay.js`](../Whatsapp%20bot/engine/providers/torrent/apibay.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/eztv.js`](../Whatsapp%20bot/engine/providers/torrent/eztv.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/knaben.js`](../Whatsapp%20bot/engine/providers/torrent/knaben.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/nyaa.js`](../Whatsapp%20bot/engine/providers/torrent/nyaa.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/solidtorrents.js`](../Whatsapp%20bot/engine/providers/torrent/solidtorrents.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/torrentio.js`](../Whatsapp%20bot/engine/providers/torrent/torrentio.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/torrentscsv.js`](../Whatsapp%20bot/engine/providers/torrent/torrentscsv.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/yts.js`](../Whatsapp%20bot/engine/providers/torrent/yts.js) — import.

- [`apibay.js`](../Whatsapp%20bot/engine/providers/torrent/apibay.js) — APIBay torrent source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`eztv.js`](../Whatsapp%20bot/engine/providers/torrent/eztv.js) — EZTV torrent source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`knaben.js`](../Whatsapp%20bot/engine/providers/torrent/knaben.js) — Knaben torrent source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`nyaa.js`](../Whatsapp%20bot/engine/providers/torrent/nyaa.js) — Nyaa torrent source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`solidtorrents.js`](../Whatsapp%20bot/engine/providers/torrent/solidtorrents.js) — SolidTorrents source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`torrentio.js`](../Whatsapp%20bot/engine/providers/torrent/torrentio.js) — Torrentio torrent source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`torrentscsv.js`](../Whatsapp%20bot/engine/providers/torrent/torrentscsv.js) — TorrentsCSV source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/core/release.js`](../Whatsapp%20bot/engine/core/release.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

- [`yts.js`](../Whatsapp%20bot/engine/providers/torrent/yts.js) — YTS torrent source adapter.
  - **References:**
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — import.
    - [`Whatsapp bot/engine/core/registry.js`](../Whatsapp%20bot/engine/core/registry.js) — import.
    - [`Whatsapp bot/engine/providers/torrent/_trackers.js`](../Whatsapp%20bot/engine/providers/torrent/_trackers.js) — import.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

### `Whatsapp bot/engine/utils/`

- [`disk.js`](../Whatsapp%20bot/engine/utils/disk.js) — Engine disk space and file-size helpers.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/core/verify.js`](../Whatsapp%20bot/engine/core/verify.js) — import.
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.
  - **Outside modules:** `node:child_process`, `node:fs`, `node:os`, `node:path`.

- [`format.js`](../Whatsapp%20bot/engine/utils/format.js) — Engine formatting helpers for sizes, durations, and results.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — import.
    - [`Whatsapp bot/engine/package.json`](../Whatsapp%20bot/engine/package.json) — ES module boundary.

### `Whatsapp bot/scripts/`

- [`install-ytdlp.sh`](../Whatsapp%20bot/scripts/install-ytdlp.sh) — Installs or updates yt-dlp for the bot.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-media-downloads.js`](../Whatsapp%20bot/scripts/test-media-downloads.js) — isolated installer fixture.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship.

- [`selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — Broad offline bot and media-engine self-test.
  - **References:**
    - [`dashboard/app/api/bot/sync/route.ts`](../dashboard/app/api/bot/sync/route.ts) — route URL reference.
    - [`Whatsapp bot/commands/admin/ytdl.js`](../Whatsapp%20bot/commands/admin/ytdl.js) — computed bot-root path.
    - [`Whatsapp bot/commands/admin/ytlogin.js`](../Whatsapp%20bot/commands/admin/ytlogin.js) — computed bot-root path.
    - [`Whatsapp bot/commands/general/providers.js`](../Whatsapp%20bot/commands/general/providers.js) — computed bot-root path.
    - [`Whatsapp bot/commands/media/dl.js`](../Whatsapp%20bot/commands/media/dl.js) — computed bot-root path.
    - [`Whatsapp bot/commands/media/shortcuts.js`](../Whatsapp%20bot/commands/media/shortcuts.js) — computed bot-root path.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — computed bot-root path.
    - [`Whatsapp bot/commands/media/spotify.js`](../Whatsapp%20bot/commands/media/spotify.js) — computed bot-root path.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — computed bot-root path.
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — computed bot-root path.
    - [`Whatsapp bot/database.js`](../Whatsapp%20bot/database.js) — computed bot-root path.
    - [`Whatsapp bot/engine/config.js`](../Whatsapp%20bot/engine/config.js) — computed bot-root path.
    - [`Whatsapp bot/engine/core/http.js`](../Whatsapp%20bot/engine/core/http.js) — computed bot-root path.
    - [`Whatsapp bot/engine/core/mirrors.js`](../Whatsapp%20bot/engine/core/mirrors.js) — computed bot-root path.
    - [`Whatsapp bot/engine/core/ranker.js`](../Whatsapp%20bot/engine/core/ranker.js) — computed bot-root path.
    - [`Whatsapp bot/engine/core/resolver.js`](../Whatsapp%20bot/engine/core/resolver.js) — computed bot-root path.
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — computed bot-root path.
    - [`Whatsapp bot/engine/media/downloader.js`](../Whatsapp%20bot/engine/media/downloader.js) — computed bot-root path.
    - [`Whatsapp bot/engine/media/hls.js`](../Whatsapp%20bot/engine/media/hls.js) — computed bot-root path.
    - [`Whatsapp bot/engine/media/torrent.js`](../Whatsapp%20bot/engine/media/torrent.js) — computed bot-root path.
    - [`Whatsapp bot/engine/providers/debrid/index.js`](../Whatsapp%20bot/engine/providers/debrid/index.js) — computed bot-root path.
    - [`Whatsapp bot/engine/providers/stream/moviebox.js`](../Whatsapp%20bot/engine/providers/stream/moviebox.js) — computed bot-root path.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — computed bot-root path.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — computed bot-root path.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — computed bot-root path.
    - [`Whatsapp bot/Procfile`](../Whatsapp%20bot/Procfile) — computed bot-root path.
    - [`Whatsapp bot/utils/accessControl.js`](../Whatsapp%20bot/utils/accessControl.js) — computed bot-root path.
    - [`Whatsapp bot/utils/adminApi.js`](../Whatsapp%20bot/utils/adminApi.js) — computed bot-root path.
    - [`Whatsapp bot/utils/cleanup.js`](../Whatsapp%20bot/utils/cleanup.js) — computed bot-root path.
    - [`Whatsapp bot/utils/commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — computed bot-root path.
    - [`Whatsapp bot/utils/converter.js`](../Whatsapp%20bot/utils/converter.js) — computed bot-root path.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — computed bot-root path.
    - [`Whatsapp bot/utils/downloadProviders.js`](../Whatsapp%20bot/utils/downloadProviders.js) — computed bot-root path.
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — computed bot-root path.
    - [`Whatsapp bot/utils/jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — computed bot-root path.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — computed bot-root path.
    - [`Whatsapp bot/utils/mediaSettings.js`](../Whatsapp%20bot/utils/mediaSettings.js) — computed bot-root path.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — computed bot-root path.
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — computed bot-root path.
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — computed bot-root path.
    - [`Whatsapp bot/utils/nm3u8dl.js`](../Whatsapp%20bot/utils/nm3u8dl.js) — computed bot-root path.
    - [`Whatsapp bot/utils/paperSearch.js`](../Whatsapp%20bot/utils/paperSearch.js) — computed bot-root path.
    - [`Whatsapp bot/utils/reconnect.js`](../Whatsapp%20bot/utils/reconnect.js) — computed bot-root path.
    - [`Whatsapp bot/utils/safeLog.js`](../Whatsapp%20bot/utils/safeLog.js) — computed bot-root path.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — computed bot-root path.
    - [`Whatsapp bot/utils/sessionManager.js`](../Whatsapp%20bot/utils/sessionManager.js) — computed bot-root path.
    - [`Whatsapp bot/utils/spotify.js`](../Whatsapp%20bot/utils/spotify.js) — computed bot-root path.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — computed bot-root path.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — computed bot-root path.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — computed bot-root path.
    - [`Whatsapp bot/utils/youtubeSearch.js`](../Whatsapp%20bot/utils/youtubeSearch.js) — computed bot-root path.
    - [`Whatsapp bot/utils/yt1d.js`](../Whatsapp%20bot/utils/yt1d.js) — computed bot-root path.
    - [`Whatsapp bot/utils/ytAuth.js`](../Whatsapp%20bot/utils/ytAuth.js) — computed bot-root path.
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — computed bot-root path.
  - **Referenced by:**
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship.
  - **Outside modules:** `@whiskeysockets/baileys`, `assert`, `bgutils-js`, `child_process`, `crypto`, `events`, `fs`, `http`, `node:child_process`, `os`, `path`, `url`, `vm`, `ws`, `zlib`.
  - **Dynamic loading observed:** `import`, `require`, `require.resolve`.

- [`test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — Tests routing work and replies to the correct linked account.
  - **References:**
    - [`Whatsapp bot/database.js`](../Whatsapp%20bot/database.js) — require.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/utils/accessControl.js`](../Whatsapp%20bot/utils/accessControl.js) — require.
    - [`Whatsapp bot/utils/accountSockets.js`](../Whatsapp%20bot/utils/accountSockets.js) — require.
    - [`Whatsapp bot/utils/hotReload.js`](../Whatsapp%20bot/utils/hotReload.js) — require.
    - [`Whatsapp bot/utils/jid.js`](../Whatsapp%20bot/utils/jid.js) — require.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
    - [`Whatsapp bot/utils/memberCommandPolicy.js`](../Whatsapp%20bot/utils/memberCommandPolicy.js) — require.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship.
  - **Outside modules:** `node:assert/strict`, `node:fs`, `node:os`, `node:path`, `node:test`.

- [`test-bridge.js`](../Whatsapp%20bot/scripts/test-bridge.js) — Tests the bot/dashboard synchronization bridge.
  - **References:**
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship.
  - **Outside modules:** `node:assert/strict`, `node:fs`, `node:os`, `node:path`, `node:test`.

- [`test-delivery.js`](../Whatsapp%20bot/scripts/test-delivery.js) — Tests account-scoped background result delivery and recovery.
  - **References:**
    - [`Whatsapp bot/utils/accountSockets.js`](../Whatsapp%20bot/utils/accountSockets.js) — require.
    - [`Whatsapp bot/utils/cleanup.js`](../Whatsapp%20bot/utils/cleanup.js) — require.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
    - [`Whatsapp bot/utils/persistentJobs.js`](../Whatsapp%20bot/utils/persistentJobs.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship.
  - **Outside modules:** `node:assert/strict`, `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:sqlite`, `node:test`.

- [`test-media-downloads.js`](../Whatsapp%20bot/scripts/test-media-downloads.js) — Offline synthetic tests for YouTube clients, token binding, cookie safety, retry, stream cleanup and both installer paths.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/install-ytdlp.sh`](../Whatsapp%20bot/scripts/install-ytdlp.sh) — copied into an isolated installer fixture.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — computed bot-root path and test-only instrumentation.
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — test-only instrumentation.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — invoked via npm test:media.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — npm test:media script.
  - **Outside modules:** `axios`, `node:assert/strict`, `node:child_process`, `node:crypto`, `node:fs`, `node:module`, `node:os`, `node:path`, `node:stream`, `node:test`, `youtubei.js`.
  - **Dynamic loading observed:** `import`, `require`.

- [`test-media-extractors.py`](../Whatsapp%20bot/scripts/test-media-extractors.py) — Checks offline provider/search URL recognition and a synthetic playlist print template with installed yt-dlp; it does not download provider videos.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — direct test invocation with pinned yt-dlp.
  - **Outside modules:** `sys`, `unittest`, `yt_dlp`, `yt_dlp.extractor`.

- [`test-media-shortcuts.js`](../Whatsapp%20bot/scripts/test-media-shortcuts.js) — Tests shortcut dispatch, aliases, quality options, quoted URLs and menu discovery with a stubbed pipeline.
  - **References:**
    - [`Whatsapp bot/commands/general/menu.js`](../Whatsapp%20bot/commands/general/menu.js) — computed bot-root path.
    - [`Whatsapp bot/commands/media/shortcuts.js`](../Whatsapp%20bot/commands/media/shortcuts.js) — computed bot-root path.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — computed bot-root path and stubbed downloader.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — invoked via npm test:media.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — npm test:media script.
  - **Outside modules:** `node:assert/strict`, `node:fs`, `node:os`, `node:path`, `node:test`.
  - **Dynamic loading observed:** `require`.

- [`test-nm3u8dl-live.js`](../Whatsapp%20bot/scripts/test-nm3u8dl-live.js) — Live smoke test of the HLS/DASH download helper.
  - **References:**
    - [`Whatsapp bot/engine/media/download.js`](../Whatsapp%20bot/engine/media/download.js) — computed bot-root path.
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — computed bot-root path.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — computed bot-root path.
    - [`Whatsapp bot/utils/nm3u8dl.js`](../Whatsapp%20bot/utils/nm3u8dl.js) — computed bot-root path.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — explicit relationship.
  - **Outside modules:** `assert`, `child_process`, `fs`, `http`, `os`, `path`, `url`.
  - **Dynamic loading observed:** `import`, `require`.

- [`test-provider-core.js`](../Whatsapp%20bot/scripts/test-provider-core.js) — Offline tests for background jobs and provider routing/storage.
  - **References:**
    - [`Whatsapp bot/utils/persistentJobs.js`](../Whatsapp%20bot/utils/persistentJobs.js) — computed bot-root path.
    - [`Whatsapp bot/utils/providerRouter.js`](../Whatsapp%20bot/utils/providerRouter.js) — computed bot-root path.
    - [`Whatsapp bot/utils/rcloneStore.js`](../Whatsapp%20bot/utils/rcloneStore.js) — computed bot-root path.
  - **Referenced by:**
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship.
  - **Outside modules:** `node:assert`, `node:fs`, `node:os`, `node:path`, `node:sqlite`, `node:test`.
  - **Dynamic loading observed:** `require`.

- [`test-provider-search-handler.js`](../Whatsapp%20bot/scripts/test-provider-search-handler.js) — Offline real-handler tests for all provider searches, numbered choices, session isolation, options and member policy.
  - **References:**
    - [`Whatsapp bot/utils/memberCommandPolicy.js`](../Whatsapp%20bot/utils/memberCommandPolicy.js) — require and test-only instrumentation.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require and test-only instrumentation.
    - [`Whatsapp bot/utils/providerSearch.js`](../Whatsapp%20bot/utils/providerSearch.js) — require and test-only instrumentation.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require and test-only instrumentation.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require and test-only instrumentation.
    - [`Whatsapp bot/database.js`](../Whatsapp%20bot/database.js) — require and test-only instrumentation.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — invoked via npm test:media.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — npm test:media script.
  - **Outside modules:** `node:assert/strict`, `node:fs`, `node:os`, `node:path`, `node:test`.

- [`test-provider-search.js`](../Whatsapp%20bot/scripts/test-provider-search.js) — Offline mocked tests for provider search, URL validation, public indexes and metadata fallback.
  - **References:**
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require and test-only instrumentation.
    - [`Whatsapp bot/utils/providerSearch.js`](../Whatsapp%20bot/utils/providerSearch.js) — require and test-only instrumentation.
  - **Referenced by:**
    - [`.github/workflows/deploy-panel.yml`](../.github/workflows/deploy-panel.yml) — invoked via npm test:media.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — npm test:media script.
  - **Outside modules:** `axios`, `node:assert/strict`, `node:test`.

- [`test-service-startup.js`](../Whatsapp%20bot/scripts/test-service-startup.js) — Tests startup order and cleanup when session or bridge startup fails.
  - **References:**
    - [`Whatsapp bot/utils/serviceStartup.js`](../Whatsapp%20bot/utils/serviceStartup.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship.
  - **Outside modules:** `node:assert/strict`, `node:test`.

- [`test-session-backup.js`](../Whatsapp%20bot/scripts/test-session-backup.js) — Tests encrypted session backup, restoration, eligibility, and revocation behavior.
  - **References:**
    - [`Whatsapp bot/utils/sessionBackup.js`](../Whatsapp%20bot/utils/sessionBackup.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship.
  - **Outside modules:** `crypto`, `fs`, `node:assert/strict`, `node:test`, `os`, `path`.

- [`test-sessions.js`](../Whatsapp%20bot/scripts/test-sessions.js) — Tests multi-account session lifecycle and permissions.
  - **References:**
    - [`Whatsapp bot/utils/sessionManager.js`](../Whatsapp%20bot/utils/sessionManager.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — explicit relationship.
  - **Outside modules:** `node:assert/strict`, `node:events`, `node:fs`, `node:os`, `node:path`, `node:test`.

### `Whatsapp bot/utils/`

- [`accessControl.js`](../Whatsapp%20bot/utils/accessControl.js) — Reads and updates WhatsApp allowlist and access decisions.
  - **References:**
    - [`Whatsapp bot/utils/jid.js`](../Whatsapp%20bot/utils/jid.js) — require.
    - [`Whatsapp bot/utils/jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/users.js`](../Whatsapp%20bot/commands/admin/users.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — require.
    - [`Whatsapp bot/utils/adminApi.js`](../Whatsapp%20bot/utils/adminApi.js) — require.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`accountSockets.js`](../Whatsapp%20bot/utils/accountSockets.js) — Tracks sockets by session so replies and jobs stay with the correct account.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/scripts/test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — require.
    - [`Whatsapp bot/scripts/test-delivery.js`](../Whatsapp%20bot/scripts/test-delivery.js) — require.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require.
    - [`Whatsapp bot/utils/sessionManager.js`](../Whatsapp%20bot/utils/sessionManager.js) — require.
  - **Outside modules:** `events`.

- [`adminApi.js`](../Whatsapp%20bot/utils/adminApi.js) — Optional authenticated HTTP API for dashboard-to-bot controls.
  - **References:**
    - [`Whatsapp bot/utils/accessControl.js`](../Whatsapp%20bot/utils/accessControl.js) — require.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
  - **Referenced by:**
    - [`dashboard/lib/bot-proxy.ts`](../dashboard/lib/bot-proxy.ts) — optional HTTP API.
    - [`dashboard/README.md`](../dashboard/README.md) — file path mentioned.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `crypto`, `http`.

- [`allowlistSync.js`](../Whatsapp%20bot/utils/allowlistSync.js) — Compatibility wrapper around the outbound dashboard sync.
  - **References:**
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
  - **Referenced by:** no direct repository reference detected; this can be an entry point, discovered file, asset, or operator-run tool.

- [`api.js`](../Whatsapp%20bot/utils/api.js) — Remote downloader fallback integrations.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/utils/downloadProviders.js`](../Whatsapp%20bot/utils/downloadProviders.js) — require.
  - **Outside modules:** `axios`.

- [`cleanup.js`](../Whatsapp%20bot/utils/cleanup.js) — Cleans eligible temporary files while respecting protected work.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/general/providers.js`](../Whatsapp%20bot/commands/general/providers.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-delivery.js`](../Whatsapp%20bot/scripts/test-delivery.js) — require.
    - [`Whatsapp bot/utils/diskGuard.js`](../Whatsapp%20bot/utils/diskGuard.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`commandLoader.js`](../Whatsapp%20bot/utils/commandLoader.js) — Dynamically discovers command modules and registers their names and aliases.
  - **References:**
    - [`Whatsapp bot/commands/admin/botmanage.js`](../Whatsapp%20bot/commands/admin/botmanage.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/admin/cookies.js`](../Whatsapp%20bot/commands/admin/cookies.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/admin/toggle.js`](../Whatsapp%20bot/commands/admin/toggle.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/admin/users.js`](../Whatsapp%20bot/commands/admin/users.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/admin/ytdl.js`](../Whatsapp%20bot/commands/admin/ytdl.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/admin/ytlogin.js`](../Whatsapp%20bot/commands/admin/ytlogin.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/general/debrid.js`](../Whatsapp%20bot/commands/general/debrid.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/general/info.js`](../Whatsapp%20bot/commands/general/info.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/general/menu.js`](../Whatsapp%20bot/commands/general/menu.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/general/paper.js`](../Whatsapp%20bot/commands/general/paper.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/general/ping.js`](../Whatsapp%20bot/commands/general/ping.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/general/providers.js`](../Whatsapp%20bot/commands/general/providers.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/general/sticker.js`](../Whatsapp%20bot/commands/general/sticker.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/general/viewonce.js`](../Whatsapp%20bot/commands/general/viewonce.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/media/dl.js`](../Whatsapp%20bot/commands/media/dl.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/media/shortcuts.js`](../Whatsapp%20bot/commands/media/shortcuts.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/media/spotify.js`](../Whatsapp%20bot/commands/media/spotify.js) — dynamic command discovery.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — dynamic command discovery.
  - **Referenced by:**
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `fs`, `path`.
  - **Dynamic loading observed:** `require`.

- [`converter.js`](../Whatsapp%20bot/utils/converter.js) — Resolves and runs ffmpeg conversion helpers.
  - **References:**
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — require.
  - **Outside modules:** `@ffmpeg-installer/ffmpeg`, `child_process`, `fs`, `os`, `path`.

- [`dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — Sends outbound authenticated heartbeats and synchronizes commands, access, and policy with the dashboard.
  - **References:**
    - [`dashboard/app/api/bot/sync/route.ts`](../dashboard/app/api/bot/sync/route.ts) — route URL reference, outbound HTTP.
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/package.json`](../Whatsapp%20bot/package.json) — require.
    - [`Whatsapp bot/utils/accessControl.js`](../Whatsapp%20bot/utils/accessControl.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/jobQueue.js`](../Whatsapp%20bot/utils/jobQueue.js) — require.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
    - [`Whatsapp bot/utils/memberCommandPolicy.js`](../Whatsapp%20bot/utils/memberCommandPolicy.js) — require.
    - [`Whatsapp bot/utils/panelClient.js`](../Whatsapp%20bot/utils/panelClient.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/.env.example`](../Whatsapp%20bot/.env.example) — explicit relationship.
    - [`Whatsapp bot/commands/admin/users.js`](../Whatsapp%20bot/commands/admin/users.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-bridge.js`](../Whatsapp%20bot/scripts/test-bridge.js) — require.
    - [`Whatsapp bot/utils/allowlistSync.js`](../Whatsapp%20bot/utils/allowlistSync.js) — require.
    - [`Whatsapp bot/utils/sessionBackup.js`](../Whatsapp%20bot/utils/sessionBackup.js) — require.
  - **Outside modules:** `crypto`, `path`.

- [`diskGuard.js`](../Whatsapp%20bot/utils/diskGuard.js) — Monitors disk use and triggers guarded cleanup.
  - **References:**
    - [`Whatsapp bot/utils/cleanup.js`](../Whatsapp%20bot/utils/cleanup.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.

- [`diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — Reports and reserves disk budget for downloads.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/botmanage.js`](../Whatsapp%20bot/commands/admin/botmanage.js) — require.
    - [`Whatsapp bot/commands/general/providers.js`](../Whatsapp%20bot/commands/general/providers.js) — require.
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
    - [`Whatsapp bot/utils/diskGuard.js`](../Whatsapp%20bot/utils/diskGuard.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
    - [`Whatsapp bot/utils/persistentJobs.js`](../Whatsapp%20bot/utils/persistentJobs.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`downloadProviders.js`](../Whatsapp%20bot/utils/downloadProviders.js) — Fallback remote downloader provider implementations.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/api.js`](../Whatsapp%20bot/utils/api.js) — require.
    - [`Whatsapp bot/utils/mediaSettings.js`](../Whatsapp%20bot/utils/mediaSettings.js) — require.
    - [`Whatsapp bot/utils/yt1d.js`](../Whatsapp%20bot/utils/yt1d.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/ytdl.js`](../Whatsapp%20bot/commands/admin/ytdl.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
  - **Outside modules:** `axios`.

- [`ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — Shared ffmpeg resolver and diagnostics facade.
  - **References:**
    - [`Whatsapp bot/utils/converter.js`](../Whatsapp%20bot/utils/converter.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/ytdl.js`](../Whatsapp%20bot/commands/admin/ytdl.js) — require.
    - [`Whatsapp bot/commands/general/providers.js`](../Whatsapp%20bot/commands/general/providers.js) — require.
    - [`Whatsapp bot/commands/general/sticker.js`](../Whatsapp%20bot/commands/general/sticker.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-nm3u8dl-live.js`](../Whatsapp%20bot/scripts/test-nm3u8dl-live.js) — computed bot-root path.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — require.
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — lazy import.
    - [`Whatsapp bot/utils/nm3u8dl.js`](../Whatsapp%20bot/utils/nm3u8dl.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`hotReload.js`](../Whatsapp%20bot/utils/hotReload.js) — Reloads bot command/runtime modules without relying on a panel restart.
  - **References:**
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — computed bot-root path.
    - [`Whatsapp bot/utils/nm3u8dl.js`](../Whatsapp%20bot/utils/nm3u8dl.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/botmanage.js`](../Whatsapp%20bot/commands/admin/botmanage.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — require.
  - **Outside modules:** `path`.
  - **Dynamic loading observed:** `require`.

- [`jid.js`](../Whatsapp%20bot/utils/jid.js) — Normalizes and matches WhatsApp phone-number and LID identifiers.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/users.js`](../Whatsapp%20bot/commands/admin/users.js) — require.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — require.
    - [`Whatsapp bot/utils/accessControl.js`](../Whatsapp%20bot/utils/accessControl.js) — require.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — require.
  - **Outside modules:** `@whiskeysockets/baileys`, `fs`, `path`.

- [`jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — Persists and delivers completed jobs through their originating WhatsApp session.
  - **References:**
    - [`Whatsapp bot/utils/accountSockets.js`](../Whatsapp%20bot/utils/accountSockets.js) — require.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — require.
    - [`Whatsapp bot/utils/persistentJobs.js`](../Whatsapp%20bot/utils/persistentJobs.js) — require.
    - [`Whatsapp bot/utils/providerRouter.js`](../Whatsapp%20bot/utils/providerRouter.js) — require.
    - [`Whatsapp bot/utils/rcloneStore.js`](../Whatsapp%20bot/utils/rcloneStore.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
    - [`Whatsapp bot/utils/userErrors.js`](../Whatsapp%20bot/utils/userErrors.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/users.js`](../Whatsapp%20bot/commands/admin/users.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — require.
    - [`Whatsapp bot/scripts/test-delivery.js`](../Whatsapp%20bot/scripts/test-delivery.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`jobQueue.js`](../Whatsapp%20bot/utils/jobQueue.js) — In-memory download queues and lanes.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/media/shortcuts.js`](../Whatsapp%20bot/commands/media/shortcuts.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
  - **Outside modules:** `os`.

- [`jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — Atomic JSON persistence and last-good recovery.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/commands/general/paper.js`](../Whatsapp%20bot/commands/general/paper.js) — require.
    - [`Whatsapp bot/database.js`](../Whatsapp%20bot/database.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/accessControl.js`](../Whatsapp%20bot/utils/accessControl.js) — require.
    - [`Whatsapp bot/utils/mediaSettings.js`](../Whatsapp%20bot/utils/mediaSettings.js) — require.
    - [`Whatsapp bot/utils/memberCommandPolicy.js`](../Whatsapp%20bot/utils/memberCommandPolicy.js) — require.
    - [`Whatsapp bot/utils/sessionBackup.js`](../Whatsapp%20bot/utils/sessionBackup.js) — require.
    - [`Whatsapp bot/utils/sessionManager.js`](../Whatsapp%20bot/utils/sessionManager.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
    - [`Whatsapp bot/utils/ytAuth.js`](../Whatsapp%20bot/utils/ytAuth.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`logger.js`](../Whatsapp%20bot/utils/logger.js) — Bot console logging and startup formatting.
  - **References:**
    - [`Whatsapp bot/utils/safeLog.js`](../Whatsapp%20bot/utils/safeLog.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/adminApi.js`](../Whatsapp%20bot/utils/adminApi.js) — require.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/persistentJobs.js`](../Whatsapp%20bot/utils/persistentJobs.js) — require.
    - [`Whatsapp bot/utils/providerRouter.js`](../Whatsapp%20bot/utils/providerRouter.js) — require.
    - [`Whatsapp bot/utils/rcloneStore.js`](../Whatsapp%20bot/utils/rcloneStore.js) — require.

- [`mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — Shared URL-download and WhatsApp delivery pipeline.
  - **References:**
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — require.
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/downloadProviders.js`](../Whatsapp%20bot/utils/downloadProviders.js) — require.
    - [`Whatsapp bot/utils/jobQueue.js`](../Whatsapp%20bot/utils/jobQueue.js) — require.
    - [`Whatsapp bot/utils/mediaSettings.js`](../Whatsapp%20bot/utils/mediaSettings.js) — require.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — require.
    - [`Whatsapp bot/utils/telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
    - [`Whatsapp bot/utils/userErrors.js`](../Whatsapp%20bot/utils/userErrors.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-provider-search-handler.js`](../Whatsapp%20bot/scripts/test-provider-search-handler.js) — require and test-only instrumentation.
    - [`Whatsapp bot/scripts/test-media-shortcuts.js`](../Whatsapp%20bot/scripts/test-media-shortcuts.js) — computed bot-root path.
    - [`Whatsapp bot/commands/media/dl.js`](../Whatsapp%20bot/commands/media/dl.js) — require.
    - [`Whatsapp bot/commands/media/shortcuts.js`](../Whatsapp%20bot/commands/media/shortcuts.js) — require.
    - [`Whatsapp bot/commands/media/spotify.js`](../Whatsapp%20bot/commands/media/spotify.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`mediaSettings.js`](../Whatsapp%20bot/utils/mediaSettings.js) — Persisted media behavior settings.
  - **References:**
    - [`Whatsapp bot/utils/jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/ytdl.js`](../Whatsapp%20bot/commands/admin/ytdl.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/downloadProviders.js`](../Whatsapp%20bot/utils/downloadProviders.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — lazy import.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — Bounded streaming, file checks, and shared media-transfer helpers.
  - **References:**
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-nm3u8dl-live.js`](../Whatsapp%20bot/scripts/test-nm3u8dl-live.js) — computed bot-root path.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — lazy import.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
  - **Outside modules:** `axios`, `child_process`, `fs`, `path`, `stream/promises`, `util`.

- [`memberCommandPolicy.js`](../Whatsapp%20bot/utils/memberCommandPolicy.js) — Applies the last synchronized per-member command availability policy.
  - **References:**
    - [`Whatsapp bot/utils/jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-provider-search-handler.js`](../Whatsapp%20bot/scripts/test-provider-search-handler.js) — require and test-only instrumentation.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/scripts/test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — require.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
  - **Outside modules:** `crypto`, `path`.

- [`movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — Lazily imports and adapts the ES-module movie/series engine.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/engine/core/metrics.js`](../Whatsapp%20bot/engine/core/metrics.js) — computed dynamic import.
    - [`Whatsapp bot/engine/media/downloader.js`](../Whatsapp%20bot/engine/media/downloader.js) — computed dynamic import.
    - [`Whatsapp bot/engine/media/index.js`](../Whatsapp%20bot/engine/media/index.js) — computed dynamic import.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/general/debrid.js`](../Whatsapp%20bot/commands/general/debrid.js) — require.
    - [`Whatsapp bot/commands/general/info.js`](../Whatsapp%20bot/commands/general/info.js) — require.
    - [`Whatsapp bot/commands/general/providers.js`](../Whatsapp%20bot/commands/general/providers.js) — require.
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `path`, `url`.
  - **Dynamic loading observed:** `import`.

- [`movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — Host adapter exposing the bot's temp, download, ffmpeg, HLS, and delivery helpers to the engine.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — lazy import.
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — lazy import.
    - [`Whatsapp bot/utils/mediaSettings.js`](../Whatsapp%20bot/utils/mediaSettings.js) — lazy import.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — lazy import.
    - [`Whatsapp bot/utils/nm3u8dl.js`](../Whatsapp%20bot/utils/nm3u8dl.js) — lazy import.
    - [`Whatsapp bot/utils/selections.js`](../Whatsapp%20bot/utils/selections.js) — lazy import.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require, lazy import.
  - **Referenced by:**
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — require.
    - [`Whatsapp bot/engine/host.js`](../Whatsapp%20bot/engine/host.js) — lazy import.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `fs`, `path`.
  - **Dynamic loading observed:** `require`.

- [`nm3u8dl.js`](../Whatsapp%20bot/utils/nm3u8dl.js) — Installs, checks, and invokes the N_m3u8DL-RE HLS/DASH helper.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/general/providers.js`](../Whatsapp%20bot/commands/general/providers.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-nm3u8dl-live.js`](../Whatsapp%20bot/scripts/test-nm3u8dl-live.js) — computed bot-root path.
    - [`Whatsapp bot/utils/hotReload.js`](../Whatsapp%20bot/utils/hotReload.js) — require.
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — lazy import.
  - **Outside modules:** `axios`, `child_process`, `fs`, `https`, `os`, `path`, `zlib`.

- [`panelClient.js`](../Whatsapp%20bot/utils/panelClient.js) — Optional HTTPS Pterodactyl/Hydrodactyl panel API client.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/botmanage.js`](../Whatsapp%20bot/commands/admin/botmanage.js) — require.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.

- [`paperSearch.js`](../Whatsapp%20bot/utils/paperSearch.js) — Normalizes and suggests exam-paper search terms.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/commands/general/paper.js`](../Whatsapp%20bot/commands/general/paper.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.

- [`persistentJobs.js`](../Whatsapp%20bot/utils/persistentJobs.js) — Persistent background-job queue, recovery, retries, and workers.
  - **References:**
    - [`Whatsapp bot/utils/diskSpace.js`](../Whatsapp%20bot/utils/diskSpace.js) — require.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
    - [`Whatsapp bot/utils/providerRouter.js`](../Whatsapp%20bot/utils/providerRouter.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-delivery.js`](../Whatsapp%20bot/scripts/test-delivery.js) — require.
    - [`Whatsapp bot/scripts/test-provider-core.js`](../Whatsapp%20bot/scripts/test-provider-core.js) — computed bot-root path.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
  - **Outside modules:** `events`, `fs`, `node:sqlite`, `path`.

- [`providerRouter.js`](../Whatsapp%20bot/utils/providerRouter.js) — Maps submitted download URLs to the appropriate background provider.
  - **References:**
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-provider-core.js`](../Whatsapp%20bot/scripts/test-provider-core.js) — computed bot-root path.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
    - [`Whatsapp bot/utils/persistentJobs.js`](../Whatsapp%20bot/utils/persistentJobs.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`providerSearch.js`](../Whatsapp%20bot/utils/providerSearch.js) — Provider-scoped title discovery, public search sources, safe result parsing, and Youku original-title fallback.
  - **References:**
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-provider-search-handler.js`](../Whatsapp%20bot/scripts/test-provider-search-handler.js) — require and test-only instrumentation.
    - [`Whatsapp bot/scripts/test-provider-search.js`](../Whatsapp%20bot/scripts/test-provider-search.js) — require and test-only instrumentation.
    - [`Whatsapp bot/commands/media/shortcuts.js`](../Whatsapp%20bot/commands/media/shortcuts.js) — require.
  - **Outside modules:** `axios`, `crypto`, `jsdom`.

- [`rcloneStore.js`](../Whatsapp%20bot/utils/rcloneStore.js) — Optional external link storage for large background-job results.
  - **References:**
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-provider-core.js`](../Whatsapp%20bot/scripts/test-provider-core.js) — computed bot-root path.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
  - **Outside modules:** `child_process`, `fs`, `path`.

- [`reconnect.js`](../Whatsapp%20bot/utils/reconnect.js) — Reconnect scheduling and exponential backoff.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/sessionManager.js`](../Whatsapp%20bot/utils/sessionManager.js) — require.

- [`safeLog.js`](../Whatsapp%20bot/utils/safeLog.js) — Redacts sensitive data from console output.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/logger.js`](../Whatsapp%20bot/utils/logger.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.

- [`selections.js`](../Whatsapp%20bot/utils/selections.js) — Session-scoped interactive and prefixed-number selections.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/accountSockets.js`](../Whatsapp%20bot/utils/accountSockets.js) — require.
    - [`Whatsapp bot/utils/jid.js`](../Whatsapp%20bot/utils/jid.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-provider-search-handler.js`](../Whatsapp%20bot/scripts/test-provider-search-handler.js) — require and test-only instrumentation.
    - [`Whatsapp bot/commands/media/shortcuts.js`](../Whatsapp%20bot/commands/media/shortcuts.js) — require.
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-account-routing.js`](../Whatsapp%20bot/scripts/test-account-routing.js) — require.
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — lazy import.
  - **Outside modules:** `@whiskeysockets/baileys`, `crypto`.

- [`serviceStartup.js`](../Whatsapp%20bot/utils/serviceStartup.js) — Starts session services and the dashboard bridge with cleanup on startup failure.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/test-service-startup.js`](../Whatsapp%20bot/scripts/test-service-startup.js) — require.

- [`sessionBackup.js`](../Whatsapp%20bot/utils/sessionBackup.js) — Encrypts, restores, uploads, and revokes eligible multi-file session backups.
  - **References:**
    - [`dashboard/app/api/bot/session-backups/route.ts`](../dashboard/app/api/bot/session-backups/route.ts) — route URL reference, outbound HTTP.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
    - [`Whatsapp bot/utils/jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/.env.example`](../Whatsapp%20bot/.env.example) — explicit relationship.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/test-session-backup.js`](../Whatsapp%20bot/scripts/test-session-backup.js) — require.
  - **Outside modules:** `crypto`, `fs`, `path`, `zlib`.

- [`sessionManager.js`](../Whatsapp%20bot/utils/sessionManager.js) — Creates, links, restores, and manages independent WhatsApp sessions.
  - **References:**
    - [`Whatsapp bot/utils/accountSockets.js`](../Whatsapp%20bot/utils/accountSockets.js) — require.
    - [`Whatsapp bot/utils/jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — require.
    - [`Whatsapp bot/utils/reconnect.js`](../Whatsapp%20bot/utils/reconnect.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-sessions.js`](../Whatsapp%20bot/scripts/test-sessions.js) — require.
  - **Outside modules:** `crypto`, `fs`, `path`.

- [`spotify.js`](../Whatsapp%20bot/utils/spotify.js) — Extracts Spotify track metadata for matching downloads.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/media/spotify.js`](../Whatsapp%20bot/commands/media/spotify.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `axios`.

- [`telemetry.js`](../Whatsapp%20bot/utils/telemetry.js) — In-process command and service telemetry counters.
  - **References:**
    - [`Whatsapp bot/utils/jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/botmanage.js`](../Whatsapp%20bot/commands/admin/botmanage.js) — require.
    - [`Whatsapp bot/commands/general/paper.js`](../Whatsapp%20bot/commands/general/paper.js) — require.
    - [`Whatsapp bot/commands/general/providers.js`](../Whatsapp%20bot/commands/general/providers.js) — require.
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/dashboardSync.js`](../Whatsapp%20bot/utils/dashboardSync.js) — require.
    - [`Whatsapp bot/utils/hotReload.js`](../Whatsapp%20bot/utils/hotReload.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
  - **Outside modules:** `path`.

- [`tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — Creates, holds, releases, and cleans the shared temp directory.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/commands/general/paper.js`](../Whatsapp%20bot/commands/general/paper.js) — require.
    - [`Whatsapp bot/commands/general/sticker.js`](../Whatsapp%20bot/commands/general/sticker.js) — require.
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/scripts/test-delivery.js`](../Whatsapp%20bot/scripts/test-delivery.js) — require.
    - [`Whatsapp bot/utils/cleanup.js`](../Whatsapp%20bot/utils/cleanup.js) — require.
    - [`Whatsapp bot/utils/converter.js`](../Whatsapp%20bot/utils/converter.js) — require.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — require.
    - [`Whatsapp bot/utils/movieEngine.js`](../Whatsapp%20bot/utils/movieEngine.js) — require.
    - [`Whatsapp bot/utils/movieHost.js`](../Whatsapp%20bot/utils/movieHost.js) — require, lazy import.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — require.
  - **Outside modules:** `fs`, `path`.

- [`userErrors.js`](../Whatsapp%20bot/utils/userErrors.js) — Converts internal failures into safer user-facing errors.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/general/menu.js`](../Whatsapp%20bot/commands/general/menu.js) — require.
    - [`Whatsapp bot/commands/media/movie.js`](../Whatsapp%20bot/commands/media/movie.js) — require.
    - [`Whatsapp bot/commands/media/series.js`](../Whatsapp%20bot/commands/media/series.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/handler.js`](../Whatsapp%20bot/handler.js) — require.
    - [`Whatsapp bot/utils/jobDelivery.js`](../Whatsapp%20bot/utils/jobDelivery.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.

- [`youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — YouTube download orchestration, yt-dlp management, and fallbacks.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — require.
    - [`Whatsapp bot/utils/mediaSettings.js`](../Whatsapp%20bot/utils/mediaSettings.js) — require.
    - [`Whatsapp bot/utils/mediaTransfer.js`](../Whatsapp%20bot/utils/mediaTransfer.js) — require.
    - [`Whatsapp bot/utils/safeLog.js`](../Whatsapp%20bot/utils/safeLog.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-provider-search.js`](../Whatsapp%20bot/scripts/test-provider-search.js) — require and test-only instrumentation.
    - [`Whatsapp bot/utils/providerSearch.js`](../Whatsapp%20bot/utils/providerSearch.js) — require.
    - [`Whatsapp bot/scripts/test-media-downloads.js`](../Whatsapp%20bot/scripts/test-media-downloads.js) — test-only instrumentation and computed bot-root path.
    - [`Whatsapp bot/commands/admin/cookies.js`](../Whatsapp%20bot/commands/admin/cookies.js) — require.
    - [`Whatsapp bot/commands/admin/ytdl.js`](../Whatsapp%20bot/commands/admin/ytdl.js) — require.
    - [`Whatsapp bot/commands/media/dl.js`](../Whatsapp%20bot/commands/media/dl.js) — require.
    - [`Whatsapp bot/commands/media/shortcuts.js`](../Whatsapp%20bot/commands/media/shortcuts.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/spotify.js`](../Whatsapp%20bot/commands/media/spotify.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/index.js`](../Whatsapp%20bot/index.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/hotReload.js`](../Whatsapp%20bot/utils/hotReload.js) — require.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
    - [`Whatsapp bot/utils/providerRouter.js`](../Whatsapp%20bot/utils/providerRouter.js) — require.
    - [`Whatsapp bot/utils/youtubeSearch.js`](../Whatsapp%20bot/utils/youtubeSearch.js) — require.
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — require.
  - **Outside modules:** `axios`, `child_process`, `crypto`, `fs`, `https`, `os`, `path`, `stream`, `stream/promises`, `util`.

- [`youtubeSearch.js`](../Whatsapp%20bot/utils/youtubeSearch.js) — Shared YouTube search and fallback selection.
  - **References:**
    - [`Whatsapp bot/config.js`](../Whatsapp%20bot/config.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/spotify.js`](../Whatsapp%20bot/commands/media/spotify.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
  - **Outside modules:** `yt-search`.

- [`yt1d.js`](../Whatsapp%20bot/utils/yt1d.js) — Remote YouTube resolver fallback.
  - **References:** none detected in this snapshot.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/downloadProviders.js`](../Whatsapp%20bot/utils/downloadProviders.js) — require.
  - **Outside modules:** `ws`.

- [`ytAuth.js`](../Whatsapp%20bot/utils/ytAuth.js) — YouTube device/OAuth credentials and sign-in helpers.
  - **References:**
    - [`Whatsapp bot/utils/jsonStore.js`](../Whatsapp%20bot/utils/jsonStore.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/commands/admin/ytdl.js`](../Whatsapp%20bot/commands/admin/ytdl.js) — require.
    - [`Whatsapp bot/commands/admin/ytlogin.js`](../Whatsapp%20bot/commands/admin/ytlogin.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — require.
  - **Outside modules:** `fs`, `path`, `youtubei.js`.

- [`ytInnertube.js`](../Whatsapp%20bot/utils/ytInnertube.js) — Native YouTube Innertube/BotGuard/SABR download implementation.
  - **References:**
    - [`Whatsapp bot/utils/ffmpeg.js`](../Whatsapp%20bot/utils/ffmpeg.js) — require.
    - [`Whatsapp bot/utils/tempManager.js`](../Whatsapp%20bot/utils/tempManager.js) — require.
    - [`Whatsapp bot/utils/youtubedl.js`](../Whatsapp%20bot/utils/youtubedl.js) — require.
    - [`Whatsapp bot/utils/ytAuth.js`](../Whatsapp%20bot/utils/ytAuth.js) — require.
  - **Referenced by:**
    - [`Whatsapp bot/scripts/test-media-downloads.js`](../Whatsapp%20bot/scripts/test-media-downloads.js) — test-only instrumentation.
    - [`Whatsapp bot/utils/mediaPipeline.js`](../Whatsapp%20bot/utils/mediaPipeline.js) — require.
    - [`Whatsapp bot/commands/admin/ytdl.js`](../Whatsapp%20bot/commands/admin/ytdl.js) — require.
    - [`Whatsapp bot/commands/media/song.js`](../Whatsapp%20bot/commands/media/song.js) — require.
    - [`Whatsapp bot/commands/media/ytv.js`](../Whatsapp%20bot/commands/media/ytv.js) — require.
    - [`Whatsapp bot/scripts/selftest.js`](../Whatsapp%20bot/scripts/selftest.js) — computed bot-root path.
    - [`Whatsapp bot/utils/youtubeSearch.js`](../Whatsapp%20bot/utils/youtubeSearch.js) — require.
  - **Outside modules:** `bgutils-js`, `child_process`, `crypto`, `fs`, `googlevideo/sabr-stream`, `googlevideo/utils`, `jsdom`, `path`, `stream`, `stream/promises`, `youtubei.js`.
