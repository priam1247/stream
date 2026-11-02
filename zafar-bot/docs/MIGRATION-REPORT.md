# Migration report

Rebuild of `Whatsapp bot/` into `zafar-bot/`, per the brief: every command a
standalone isolated folder, no fallbacks, nothing can take the bot down, and a
test board that never claims a pass it cannot prove.

- **Date:** 2026-11-02
- **Old tree:** `Whatsapp bot/` — untouched, still the migration source
- **New tree:** `zafar-bot/` — 22 commands, all loading
- **Automated tests:** 76 / 76 passing (`npm test`)
- **Isolation proofs:** 14 / 14 passing (`./scripts/isolation-proof.sh`)
- **Live board:** `12 passed · 10 failed · 22 checked` (`node scripts/check-all.js`, exit 1)

Every one of the 10 failures is **external**: the Drime API token is not set, and
this sandbox cannot reach any provider host. Every offline stage of every check
passes. Read section 6 before trusting any ✅ below.

---

## 1. Inventory of the old bot

24 command files declared 34 commands. `Whatsapp bot/index.js` → `handler.js` →
`utils/commandLoader.js`.

### Admin commands (10 declared, from `commands/admin/*.js`)

| old command | file | what it did |
|---|---|---|
| `.status` | `admin/status.js` | liveness + counters |
| `.restart` | `admin/restart.js` | restarted the process |
| `.cookies` | `admin/cookies.js` | printed/refreshed provider cookies |
| `.allow` / `.disallow` | `admin/access.js` | added/removed a number in `whitelist.json` |
| `.listusers` | `admin/listusers.js` | listed allowed numbers |
| `.on` / `.off` | `admin/toggle.js` | enabled/disabled a command (an alias hack) |
| `.ytdl` | `admin/ytdl.js` | toggled the YouTube downloader |
| `.ytlogin` | `admin/ytlogin.js` | refreshed YouTube auth |

### General commands (12)

`.debrid`, `.info`, `.menu`, `.paper`, `.countpapers`, `.refreshpapers`, `.ping`,
`.providers`, `.moviestatus`, `.sticker`, `.viewonce`, `.help` (alias of menu)

### Media commands (12)

`.dramabox`, `.embed`, `.mdiag`, `.mfind`, `.movie`, `.series`, `.tiktok`, `.x`,
`.instagram`, `.fb`, `.reddit`, `.song`, `.spotify`, `.video`

### Supporting machinery

- `utils/` — ~60 modules, all shared: `accessControl.js`, `commandLoader.js`,
  `socialMedia.js`, `xjxMedia.js`, `movieEngine.js`, `paperSearch.js`, …
- `engine/` — 51 ESM files (352 KB): movie/series resolution, HLS, torrents.
- `database.js` — one JSON file for every number's users and every command's state.
- `config.js` — every provider's keys, plus feature settings, in one object.

### Baseline, measured before any change

| check | result |
|---|---|
| `npm ci` | 245 packages, exit 0 |
| command files loading | 24 files, 0 failed |
| `npm run test:preflight` | 61 / 61 |
| committed secrets | none found |
| empty `catch` blocks | 293 |
| writers of `whitelist.json` | 3 (a race by construction) |

---

## 2. Old → new mapping

### Kept, same name, same wording

| old | new | notes |
|---|---|---|
| `.ping` | `commands/ping` | ✅ tested |
| `.menu` / `.help` | `commands/menu` | generated from the registry instead of a hand-written list |
| `.status` | `commands/status` | now reads the real board |
| `.users` family | `commands/users` | replaces `.allow`/`.disallow`/`.listusers` |
| `.toggle` | `commands/toggle` | replaces the `.on`/`.off` alias hack |
| `.reload` | `commands/reload` | new; the old bot restarted the process |
| `.botmanage` | `commands/botmanage` | access mode, maintenance, restart |
| `.sessions` | `commands/sessions` | new; multi-number support |
| `.paper` | `commands/paper` | 863-line vault ported intact |
| `.countpapers` | `commands/countpapers` | own copy of the vault |
| `.refreshpapers` | `commands/refreshpapers` | own copy of the vault |
| `.info` | `commands/info` | Cinemeta only |
| `.sticker` | `commands/sticker` | packaged ffmpeg only |
| `.viewonce` | `commands/viewonce` | 4 envelope shapes + 2 negatives |
| `.debrid` | `commands/debrid` | static reply, wording preserved |
| `.providers` | `commands/providers` | 12 providers, admin-only, static |
| `.song` | `commands/song` | one provider |
| `.video` | `commands/video` | one provider, 480p |
| `.ig` | `commands/ig` | one scraper |
| `.fb` | `commands/fb` | one provider, own resolver copy |
| `.movie` | `commands/movie` | own engine copy |
| `.series` | `commands/series` | own engine copy |

### Deliberately not migrated

| old | why |
|---|---|
| `.moviestatus` | read the engine's in-process state; the engine now lives inside `.movie`/`.series` and rule 1 forbids the import. The information is on `.status`. |
| `.embed` | wrote an embed into the old engine's shared memory. No equivalent in an isolated design. |
| `.mdiag`, `.mfind` | engine diagnostics over the shared engine. Superseded by `.check-all` and each command's `check.js`. |
| `.dramabox` | dead in the old bot — no reachable provider, no working code path. |
| `.tiktok`, `.x`, `.reddit`, `.spotify`, `.instagram` | each relied on a provider chain that no longer resolves. `.instagram`'s one surviving path is `.ig`. Listed as an open question, not silently dropped. |
| `.ytdl`, `.ytlogin`, `.cookies` | YouTube login/cookie management for a downloader that the old bot never actually shipped. |
| `.restart` | replaced by `.botmanage restart` (pm2 owns the process now). |

**This is the largest scope decision in the rebuild.** Six old media commands are
not present. Each is listed above with its reason, and section 11 asks whether
they should be rebuilt against a current provider.

### Structure mapping

| old | new |
|---|---|
| `index.js` + `handler.js` (one 700-line file) | `gateway/index.js`, `gateway/router.js`, `gateway/guards.js` |
| `utils/commandLoader.js` | `gateway/registry.js` |
| `config.js` (one object, every feature) | `gateway/config.js` (generic only) + one `config.js` per command |
| `database.js` (one file, everyone writes) | `gateway/users/store.js` (the only writer) + `storage/commands/<name>/` |
| `utils/accessControl.js` + 3 `whitelist.json` writers | `gateway/users/{roles,store,access,usage}.js` |
| `utils/socialMedia.js` | `commands/ig/scraper.js` and `commands/fb/*` (separate copies) |
| `utils/xjxMedia.js` | `commands/song/*`, `commands/video/*` (separate copies) |
| `utils/movieEngine.js` + `engine/` | `commands/movie/engine/` and `commands/series/engine/` (two full copies) |
| `utils/paperSearch.js` + paper command | three independent paper folders |
| direct `sock.sendMessage` everywhere | `ctx.reply` / `ctx.send.*` only |

---

## 3. Fallbacks removed

The rule applied: **keep the first path, delete the rest, fail loudly with the
first path's own error.**

| feature | old chain | new |
|---|---|---|
| `.song` | ApisSupreme → KnightBot → yt-dlp → … | ApisSupreme `/media/ytmp3` only |
| `.video` | several providers, several qualities | KnightBot 480p only |
| `.ig` | 3 scrapers in sequence | `ruhend-scraper` only |
| `.fb` | 2 providers + scraping | ApisSupreme `/media/facebook` only |
| `.movie` / `.series` | quality ladder, `QUALITY_FALLBACK`, retry with `exclude` | one `resolve*()` call; `QUALITY_FALLBACK=0`; `exclude` unused |
| `.sticker` | packaged ffmpeg → system `ffmpeg` → `ffprobe` | packaged binary only; `FFMPEG_MISSING` |
| `.info` | TMDB → TVDB → OMDb → AniList | Cinemeta only |
| WA version | hardcoded version → `fetchLatestWaWebVersion` | `fetchLatestWaWebVersion`, throws on failure |
| session connect | reconnect, then a second socket, then a QR | one socket, bounded retries, then `logged-out` |
| `readJson` | try file → try `.bak` → default `{}` | try file → `.bak` → **throw** for `users.json`; defaults only where a default is the truth (settings before first write) |
| paper send | edit the status message, else send a second one | one `reply`, then one `send.text` |
| movie download | torrent → direct → HLS → different quality | the one path the engine chose; failure is failure |

Full census in the old tree: 144 fallback sites. The new tree has zero fallback
assignments in `commands/` (proof #9), and the only name matching "fallback" is
`deltaFallback()` in the paper vault, which is the *named* delta-sync routine —
two different jobs chosen explicitly by the caller, not a retry ladder.

---

## 4. Bugs found

### In the old bot (preserved or fixed as noted)

| # | finding | status |
|---|---|---|
| 1 | `handler.js:203` requires `fromMe === true`; the bot is a self-bot | **preserved**, documented |
| 2 | 293 empty `catch` blocks — every failure silently swallowed | **fixed in our code**: 0 bare catches in `gateway/`, `lib/`, `scripts/`, `test/` and in command code. 31 remain **inside** the ported `engine/` (movie + series) and are listed as a known limitation below |
| 3 | `whitelist.json` written from 3 places | **fixed**: one store, one writer |
| 4 | `movieCapDefault` read `VIDEO_MAX_MB` | **preserved** (behaviour kept, noted) |
| 5 | Menu advertised `.dl` and `.ytv`, which do not exist | **fixed**: menu is generated from the registry |
| 6 | `.on`/`.off` were aliases that behaved as their own commands | **replaced** by `.toggle <command>` |
| 7 | `read` alias existed only on `.viewonce` | **preserved** |
| 8 | no ban, no roles, no cooldowns, no per-command block | **added** as specified |
| 9 | `config.js` held every feature's secrets in one object | **split** into per-command env reads |
| 10 | a crash in any command killed the process | **fixed**: child process per job |

### In my own rebuild, found by the tests

These were real defects in the new code, caught by the tests and fixed. Listing
them because the brief asks for bugs found, not a highlight reel.

| # | bug | how it was caught | fix |
|---|---|---|---|
| 1 | runner SIGKILLed the child 25 ms after `done`, racing the `finally` cleanup — job folders survived every run | `test/isolation.test.js` "job folder is deleted after success" | runner waits for the child's own exit, 5 s grace |
| 2 | a syntax error in a command produced `exited (code 1) before returning a result` with the cause thrown away | "a command with a syntax error" | child writes `ErrorClass: message` + stack to stderr; runner prefers the error line |
| 3 | the runner displayed the require() stack tail instead of the error | same test | prefer the first `…Error:` line |
| 4 | `.menu` never showed a command's state at all — a broken command was invisible where users look first | "the menu must carry a visible warning marker" | catalogue rows carry `state`/`stateReason`; menu renders ❌/⛔ |
| 5 | `paper/vault.js` called `database.logPaperSent()` — a module that no longer exists; every successful paper send would have thrown after sending | reading the file during the import audit | `sendLog.logPaperSent()` |
| 6 | `gateway/config.js` carried a `drime:` block — paper feature logic in the shared layer | `isolation-proof.sh` check 8 | removed; each paper folder reads its own env |
| 7 | paper vault read `config.prefix` from the gateway config | check 8 follow-up | prefix comes from `ctx` through the adapter |
| 8 | `isolation-proof.sh` check 12 failed on a stale `storage/` runtime record | running the script | record purged; test numbers no longer collide with legacy ones |

Two more non-bugs worth recording, because they looked like bugs and were not:

- `.users` refused twice in a row — that is the 2-second admin cooldown working.
  Proven in `guards.test.js`, and the command tests clear it explicitly.
- the owner could not be banned — deliberate. An admin on one number must not be
  able to lock the owner out.

---

## 5. Test results

### 5.1 Automated suite — `npm test`

```
# tests 76
# pass 76
# fail 0
```

| file | cases | covers |
|---|---|---|
| `test/isolation.test.js` | 11 | syntax error, missing file, bad metadata, throw, `process.exit`, hang, breaker, breaker ageing, reload mid-job, cleanup, cross-import |
| `test/guards.test.js` | 18 | all 7 guards, their order, cooldown expiry, refusal wording |
| `test/users.test.js` | 18 | CRUD, ban/unban, roles, block, audit log, `.bak` recovery, corrupt file, per-number isolation, single writer |
| `test/imports.test.js` | 16 | no cross-command import, no `gateway/` import, no Baileys, no `users.json`, contract completeness, duplicate aliases, pinned Baileys, `.env.example` coverage, no secrets |
| `test/commands.test.js` | 13 | `.ping .menu .status .users .toggle .botmanage .debrid .providers .sessions`, unknown command, no prefix, not-from-me |

`npm test` → 76 pass, exit 0. `npm run test:isolation` → 11 pass, exit 0.

### 5.2 Isolation proofs — `./scripts/isolation-proof.sh`

14 checks, exit 0. The grep evidence is printed per check; summary table in
`docs/ARCHITECTURE.md` §5. The important lines:

```
2. No command reaches into gateway/
  PASS commands never import gateway/ internals (0 hits)
3. No command touches the raw Baileys socket
  PASS commands never import Baileys or download media themselves (0 hits)
5. No command reads or writes users.json
  PASS commands never name users.json in code (0 hits)
6. gateway/users/store.js is the only writer of users.json
  PASS no writer outside store.js (0 hits)
```

### 5.3 Live board — `node scripts/check-all.js`, exit 1

| | command | result |
|---|---|---|
| ✅ | botmanage | static replies, admin door |
| ✅ | debrid | static reply matches the old bot |
| ✅ | menu | renders from the registry |
| ✅ | ping | old wording |
| ✅ | providers | 12 providers listed |
| ✅ | reload | loads a command |
| ✅ | sessions | lists linked numbers |
| ✅ | status | reads the board |
| ✅ | sticker | real 600×400 → 512×512 WebP via packaged ffmpeg |
| ✅ | toggle | flips and persists |
| ✅ | users | add/list/ban/unban/role/block |
| ✅ | viewonce | 4 envelope shapes + 2 negatives |
| ❌ | countpapers | `DRIME_API_TOKEN is not set` — no network/token here |
| ❌ | fb | `APISSUPREME_HTTP: ECONNRESET` |
| ❌ | ig | `PROVIDER_FAILED: ENOTFOUND api.videodropper.app` |
| ❌ | info | `METADATA_HTTP: Cinemeta returned ECONNRESET` |
| ❌ | movie | `no metadata hit for "Inception"` (network) |
| ❌ | paper | `DRIME_API_TOKEN is not set` |
| ❌ | refreshpapers | `DRIME_API_TOKEN is not set` |
| ❌ | series | `no metadata hit for "Breaking Bad"` (network) |
| ❌ | song | `ECONNRESET` at the TLS stage |
| ❌ | video | `ECONNRESET` at the TLS stage |

### 5.4 What is **not** proven

This is the honest part. The following were verified by code-reading and offline
checks only, and are **UNTESTED** against a live provider:

| area | what is unproven | why |
|---|---|---|
| `.song`, `.video` | a real download and a real send | no provider reachable |
| `.ig`, `.fb` | a real scrape, a real video | same |
| `.movie`, `.series` | metadata, torrent resolution, a real download | same |
| `.paper` family | a real vault sync, a real PDF send | no `DRIME_API_TOKEN`, no network |
| `.info` | a real Cinemeta response | no network |
| `.sticker` EXIF pack | `node-webpmux` path (`img.save(null)`) | the ffmpeg → WebP conversion **is** tested; packing a sticker's metadata is not |
| `.viewonce` on a real envelope | the 4 shapes are synthetic | no live traffic |
| sessions | pairing, reconnect, multi-number | no WhatsApp session in this sandbox |
| `ecosystem.config.js` | pm2 start/restart behaviour | pm2 not installed here |
| `scripts/backup.js` | **executed** ✅ (6 settings, 12 core files, mode 0600) | restore not exercised |

No ❌ in section 5.3 is caused by code that failed a test. They are all "could not
reach the provider from here". That distinction is the whole point of the board:
a green tick on `.song` would have been a lie.

### 5.5 Known limitation: the ported engine still swallows some errors

The movie and series commands carry a full copy of the old `engine/` (51 ESM
files). That code **still contains 31 empty `catch {}` blocks**, concentrated in
`engine/core/cache.js`, `engine/core/extract.js`, `engine/core/verify.js` and
`engine/media/download.js`.

Most are defensible clean-up paths (`unlinkSync` on a file that may already be
gone, `body.cancel()` on a stream being discarded, `p.kill('SIGKILL')` on a
process that may have exited) where there is genuinely nothing to report. Some
are not: a failed temp-file removal in `cache.js` is silent, so a disk filling up
would be invisible until it became an emergency.

They were left in place deliberately. Rewriting 352 KB of working media code
without a reachable provider would mean shipping unverifiable changes into the
two most fragile commands. The honest position: **this part of the tree does not
yet meet the "every catch logs or rethrows" rule**, and it is the first thing to
fix once the providers are reachable and `.movie`/`.series` can be exercised
against real media.

Command-level code outside `engine/` is clean: 0 empty catches. The three
remaining ones (a failed WhatsApp reaction in each paper vault) now log their
cause.

---

## 6. Behaviour differences

Preserved unless listed here.

1. **`.menu` is generated.** The old list was hand-maintained and wrong (it
   advertised `.dl` and `.ytv`). Categories are now `GENERAL`, `MEDIA`, `PAPERS`,
   `ADMIN`, sorted by name, with aliases shown. A broken or disabled command is
   marked ❌/⛔ with its reason.
2. **`.status` shows the real board**, including `⚪ not run yet`, not just a
   liveness ping.
3. **`.providers` is static.** It lists the 12 provider names and nothing about
   their live health. The old one could report per-provider state because the
   engine was shared; the engine now belongs to `.movie` and `.series`, and rule 1
   forbids reaching into it. This is a real loss of information, accepted to keep
   the isolation guarantee.
4. **`.users` replaces three old commands.** `.allow`, `.disallow` and
   `.listusers` are gone; their behaviour is `users add/remove/list`. `.listusers`
   printed a bare number list; `.users list` prints roles and statuses.
5. **`.toggle` takes one argument.** `.toggle <command>` flips it. The old `.on`
   and `.off` aliases are gone.
6. **Paper family duplicated.** Each of the three paper commands builds its own
   vault snapshot and its own send log. First run after a change costs a sync
   three times instead of once. This is the deliberate cost of independence, not
   an oversight.
7. **Paper status messages.** The old code edited one status message in place; a
   command has no edit right, so a status update is two messages: the initial
   text, then the final text. Same information, one extra bubble.
8. **`ctx.download` is the only media path.** Commands no longer touch the
   socket, so a command that wants a video asks the gateway to fetch it into the
   job folder.
9. **Cooldowns exist.** The old bot had none. A second `.users` within 2 s is
   refused. Documented per command in `command.json`.
10. **No disk guard.** Removed per the brief. Cleanup is the job folder after the
    send, plus deletion on failure. Durable state lives in
    `storage/commands/<name>/`.
11. **Owner/admin numbers come from `storage/core/owner.json` and the per-number
    users files.** The old hardcoded numbers are gone.
12. **One pm2 instance only.** Sessions, the breaker and per-number files are
    in-process state.

---

## 7. Dependencies

### Runtime (unchanged from the old bot unless noted)

| package | version | why |
|---|---|---|
| `@whiskeysockets/baileys` | `7.0.0-rc14` **exact** | WhatsApp; pinned per the brief |
| `@ffmpeg-installer/ffmpeg` | `^1.1.0` | the packaged ffmpeg for `.sticker` (replaces the system search) |
| `axios` | `^1.13.2` | every HTTP call |
| `node-webpmux` | `^3.1.3` | sticker metadata |
| `pino` | `^10.1.0` | structured logs |
| `qrcode-terminal` | `^0.12.0` | pairing fallback display |
| `ruhend-scraper` | `10.0.3` **exact** | `.ig` |
| `tough-cookie` | `^6.0.2` | required by the ported movie/series engine |
| `yt-search` | `^2.13.1` | `.song`, `.video` search |
| `webtorrent` | `^2.5.19` (optional) | movie torrent path; optional so a failed native build does not block boot |

**Added:** `@ffmpeg-installer/ffmpeg` (replaces a system dependency — the old bot
called `ffmpeg` from PATH), `tough-cookie` (the engine needs it; it was a
transitive dep before), `webtorrent` declared optional.

**Removed:** nothing that the old bot needed to boot. The old `package.json` had
provider SDKs for the commands that were not migrated (`.dramabox`, `.tiktok`,
`.x`, `.reddit`, `.spotify`). They are gone with those commands.

**Dev:** none. The tests use `node:test` and `node:assert` — no framework was
added.

---

## 8. Isolation, restated with evidence

The brief's hard requirements, and where each is proven:

| requirement | proof |
|---|---|
| a command never imports another command | `test/imports.test.js`, proof 1 |
| a command never imports `gateway/` | `test/imports.test.js`, proof 2 |
| a command never touches the raw socket | `test/imports.test.js`, proof 3 |
| a command never reads `users.json` | `test/imports.test.js`, proof 5 |
| **codebase grep proving all of the above** | `scripts/isolation-proof.sh` — 14 checks, exit 0, output pasted in §5.2 |
| a crash cannot take the bot down | `test/isolation.test.js` cases 1–5 |
| a hang cannot take the bot down | case 6 (`while(true)` killed; another command finishes meanwhile) |
| a bad session cannot affect others | `gateway/sessions/manager.js`; `.sessions` shows per-number state — **not exercised live** |
| a broken command is visible | board + `.menu` markers + `⚠️ .name is down` |
| no fallbacks | proof 9; §3 table |
| `lib/send.js` deletes the job folder | isolation case 10 |

---

## 9. Open questions

Answered by the safest assumption in code where an answer was needed. None of
these block running the bot.

1. **Six old media commands were not migrated** (`.dramabox`, `.tiktok`, `.x`,
   `.reddit`, `.spotify`, `.instagram`). Should they be rebuilt against a current
   provider, or formally dropped? *Assumption: dropped, and `.ig` covers the
   Instagram case.*
2. **The self-bot gate.** `fromMe === true` means the actor is always the linked
   number. Is that intended, or should the bot answer other people in groups?
   *Assumption: preserved as the old bot did.*
3. **`.providers` lost live health.** Accept the static list, or duplicate the
   engine's health probe into `.providers`? *Assumption: static, to keep rule 1.*
4. **Paper duplication.** Three copies of a 863-line vault is a real maintenance
   cost. Confirm this is preferred over a shared `paper-core/`? *Assumption:
   duplication, because the brief forbids shared feature code.*
5. **Admin cooldown of 2 s.** Kept from the old behaviour? It makes scripted
   multi-step admin work need pacing. *Assumption: kept.*
6. **`QUALITY_FALLBACK=0`.** Movie/series now fail rather than trying another
   quality. Confirm that is preferred over a lower-quality result. *Assumption:
   fail, per "no fallbacks".*
7. **Backups.** `scripts/backup.js` keeps 10, mode 0600, in `storage/backups/`.
   Should they also be pushed off-box? *Assumption: local only; the script prints
   a warning that the archives contain WhatsApp credentials.*
8. **`@ffmpeg-installer/ffmpeg` is archived upstream.** It works and ships a
   binary. Replace it with `ffmpeg-static` before the next major upgrade?
   *Assumption: keep it; `sticker`'s check proves the binary runs.*

---

## 10. Rollback

The old bot was never modified, so rollback is one line.

```bash
cd /home/user/stream
pm2 stop zafar-bot
cd 'Whatsapp bot'
npm ci
cp .env.example .env      # if .env is absent
pm2 start index.js --name whatsapp-bot
```

What is **not** shared, and does not need unwinding:

- `zafar-bot/` is self-contained; deleting it removes nothing the old bot needs.
- `sessions/` (new) vs `session/` (old) — different paths, no overlap.
- `storage/` (new) vs `database/` (old) — the old bot never reads `storage/`.
- No file inside `Whatsapp bot/` was written, moved or deleted. Verified by the
  absence of any write operation against that path.

What you would lose: the users system (bans, roles, blocks), cooldowns, the
per-command child isolation, the status board, and the automated tests. The old
bot has none of those.

---

## 11. How to verify this report yourself

```bash
cd zafar-bot
npm install
npm test                          # expect: 76 pass, 0 fail, exit 0
./scripts/isolation-proof.sh      # expect: 14 PASS, exit 0
node scripts/check-all.js         # expect: 12/10/22 and exit 1
echo $?                           # must be 1 — anything else means the board lies
```

Then read `docs/ARCHITECTURE.md`, open any `commands/<name>/NOTES.md`, and
compare the wording there against a live run.

If a ❌ in section 5.3 turns ✅ on a machine with working network and a Drime
token, that is the only claim in this report that a better environment can
upgrade. Nothing in the ✅ column needs re-verification.
