# Architecture

The rebuilt bot. Every command is a self-contained folder. A command can fail,
hang, or be deleted and the bot keeps serving every other command.

- **Root:** `zafar-bot/`
- **Entry point:** `gateway/index.js`
- **Node:** 22.x (tested on v22.22.3)
- **Baileys:** `7.0.0-rc14`, pinned exactly, no `^`/`~`
- **Commands:** 22 loaded, 0 failed

---

## 1. The shape of the tree

```
zafar-bot/
├── gateway/            the only code that knows about WhatsApp
│   ├── index.js        boot: config → registry → sessions → sockets
│   ├── router.js       message in → guards → lane → runner → reply
│   ├── guards.js       the 7 guards, in the fixed order
│   ├── runner.js       spawns the child, enforces timeout, cleans up
│   ├── child.js        runs exactly one run(ctx) inside a forked process
│   ├── registry.js     reads commands/*/command.json, validates, loads
│   ├── status.js       the ✅❌⛔⚪ board, in memory + on disk
│   ├── ctx.js          builds the frozen object a command receives
│   ├── fakesock.js     Baileys-shaped fake socket for tests
│   ├── admin.js        .users/.toggle/.reload/.botmanage/.status backend
│   ├── dashboard.js    report-only push to the dashboard
│   ├── log.js          pino + per-command log files
│   ├── config.js       env + generic limits only
│   ├── users/          roles, store (only users.json writer), access, usage
│   └── sessions/       socket, manager, pairing
├── commands/           one folder per command, nothing shared
├── lib/                tiny generic helpers: paths, jid, format, send, fsutil
├── storage/            runtime state (gitignored)
│   ├── core/           owner.json, disabled.json, status.json, numbers/
│   ├── commands/<name>/  command-private data
│   ├── tmp/<name>/<job>/ per-job scratch, deleted after the send
│   └── backups/        script/backup.js output
├── sessions/           Baileys auth state, one folder per number (gitignored)
├── logs/               per-command and gateway logs (gitignored)
├── scripts/            check-all.js, backup.js, add-owner.js, isolation-proof.sh
├── docs/               this file, migration report
├── test/               76 automated tests, node:test
└── ecosystem.config.js pm2 definition
```

`Whatsapp bot/` — the original project — is untouched. It is the migration source
and the reference for old wording, and it is never imported by the new tree.

---

## 2. The life of one message

```
Baileys socket (gateway/sessions/socket.js)
        │  messages.upsert
        ▼
gateway/router.js  handle({ number, sock, message })
        │
        ├─ 1. fromMe?            no  → ignore, silent
        ├─ 2. banned?            yes → ignore, silent
        ├─ 3. access mode        open | whitelist → refuse politely
        ├─ 4. maintenance?       yes → refuse, owners pass
        ├─ 5. command role       user < admin < owner → refuse
        ├─ 6. per-user command block → refuse
        ├─ 7. cooldown           → "⏳ Slow down. Try again in Ns."
        │
        ├─ status.isDisabled(name)?  ⛔ → "⚠️ .name is down" + reason
        ├─ lane full?                → "⏳ busy, try again"
        │
        ▼
gateway/runner.js  fork(gateway/child.js), cwd = commands/<name>/
        │  IPC: ready → run → log*/send* → result
        │  timeout: timeoutSec from command.json (default 60)
        ▼
gateway/child.js  require('./index.js').run(ctx)  ← ONE function, nothing else
        │
        ▼
gateway/router.js  sends every queued message through the socket
                   deletes storage/tmp/<name>/<jobId>/ (always)
                   records ✅ or ❌ on the board
                   usage.mark() for the cooldown
                   logs to logs/<name>.log
```

The child process boundary is the isolation guarantee. A command runs in its own
process, with its own heap and its own event loop. A `while(true)`, a
`process.exit()`, a segfault in a native module, or a syntax error can only kill
that one child.

---

## 3. The command contract

A folder is a command **only** if it has all four files. A folder missing any of
them is skipped at load with the reason recorded — the bot still starts.

### `command.json`

```json
{
  "name": "paper",
  "aliases": ["papers", "pastpaper", "pp"],
  "category": "papers",
  "description": "Search past exam papers",
  "usage": ".paper <code> [module] [year]",
  "role": "user",
  "cooldownSec": 5,
  "timeoutSec": 300,
  "lane": "heavy",
  "limits": { "maxPapersPerQuery": 10, "maxInputChars": 60 },
  "sample": ".paper CHEM 2210"
}
```

| field | meaning | validated |
|---|---|---|
| `name` | must equal the folder name | ✓ |
| `aliases` | extra triggers; duplicates rejected across the whole tree | ✓ |
| `category` | `general` \| `media` \| `papers` \| `admin` | ✓ |
| `role` | `user` \| `admin` \| `owner` | ✓ |
| `cooldownSec` | per user, per command | ✓ number |
| `timeoutSec` | hard kill in the runner | ✓ number |
| `lane` | `light` \| `heavy` \| `single` | ✓ |
| `limits` | command-specific caps, checked before any download. **The only place a limit can live** — no env override exists, and a test enforces it | ✓ numbers |
| `sample` | one example input, printed by `.status` and the tests | ✓ non-empty |

### `index.js`

```js
module.exports = {
  async run(ctx) {
    // the entire command
  },
};
```

Nothing else is read from `index.js`. Helper files in the same folder may be
required freely; anything outside the folder only through `lib/` and npm.

### `check.js`

Exports `run()` (some older ones export a bare function). Run by
`scripts/check-all.js` in a child process. It must:

1. exercise everything that works offline,
2. make one real call for anything that needs the network,
3. `throw new Error('<SPECIFIC_REASON>')` on any failure — never `return false`.

`check-all` prints the **first line** of the thrown message. Multi-line provider
dumps are compressed in `gateway/child.js` and in the script itself.

### `NOTES.md`

What the command does, its limits, its failure modes, and every place its
behaviour differs from the old bot. Written for a person who has to debug it at
2 a.m.

---

## 4. `ctx` — the only thing a command sees

Built by `gateway/ctx.js`, frozen in `gateway/child.js` before the command is
called. Plain data and plain functions; no socket, no registry, no store.

```js
{
  // identity
  number:   '265991234567',          // the linked number running the job
  sender:   { number, name },
  chat:     '265991234567@s.whatsapp.net',
  isGroup:  false,
  quoted:   null,
  role:     'owner' | 'admin' | 'user',
  prefix:   '.',
  command:  'paper',
  args:     ['CHEM', '2210'],
  text:     'CHEM 2210',             // args joined
  limits:   { ...command.json.limits },
  tmp:      '/…/storage/tmp/paper/job-abc',  // job folder, deleted after send

  // output — everything is queued and sent by the gateway
  reply(text)                    → one text message
  react(emoji)                   → reaction on the trigger message
  send: {
    text(text),
    image(buffer|path, caption),
    document(path, caption, fileName),
    audio(path),
    video(path, caption),
  },
  download(destPath)             → { bytes, path }; dest must be inside ctx.tmp

  // read-only views
  catalogue: [ { name, aliases, category, description, usage, role, state } ],
  statuses:  { ping: { state, reason }, ... },

  // the admin door — re-checks the actor, so a command cannot escalate
  admin({ action, target, extra }) → { message, ... }
}
```

There is no `sock`. There is no way to send outside `ctx`. `ctx.download` is the
only way to fetch media, and it insists on a destination inside the job folder so
that a command cannot leave files behind.

---

## 5. Isolation: how it is enforced, and proven

The rules:

1. A command may require files **inside its own folder**.
2. A command may require `lib/*` (generic helpers only).
3. A command may require npm packages.
4. A command may **not** require another command, `gateway/`, `users.json`, or Baileys.
5. A command may **not** hold a socket.

Rule 4 and 5 are checked two ways, both kept in the repo:

```bash
npm run test:isolation      # node --test test/isolation.test.js  (11 tests)
./scripts/isolation-proof.sh # grep evidence, 14 checks, exit 1 on any hit
npm test                     # 76 tests, includes test/imports.test.js
```

The grep script is the artifact for a human to read:

| # | check | result |
|---|---|---|
| 1 | no command requires a sibling command folder | PASS |
| 2 | no command imports `gateway/` internals | PASS |
| 3 | no command imports Baileys or downloads media itself | PASS |
| 4 | socket-shaped calls confined to the paper vaults + adapters | PASS |
| 5 | no command names `users.json` or calls a store writer | PASS |
| 6 | `gateway/users/store.js` is the only writer of `users.json` | PASS |
| 7 | no reference to the old project tree | PASS |
| 8 | no provider/feature names in `gateway/` or `lib/` | PASS |
| 9 | no fallback assignments in commands | PASS |
| 10 | Baileys pinned exactly | PASS (`7.0.0-rc14`) |
| 11 | no credential-looking literals | PASS |
| 12 | no legacy hardcoded owner/admin numbers | PASS |

The one deliberate exception, documented in section 9: the paper trio keeps the
original vault code, which was written against `(sock, msg, args, extra)`. Each
paper folder contains an `adapter.js` that presents **two** methods —
`sendReaction` and `sendDocument` — over `ctx`. `sendMessage` appears nowhere in
the tree.

### Behavioural isolation, proven by test

`test/isolation.test.js`, 11 cases, all passing:

| case | what it proves |
|---|---|
| syntax error in a command | loads ❌, other commands still run, message names `SyntaxError` |
| missing `index.js` | skipped at load, bot still starts |
| invalid `command.json` | skipped with the exact reason (`"role" must be one of…`) |
| command throws | fails alone; cause reaches the board |
| command calls `process.exit(7)` | reported as `exited (code 7)`, not ignored |
| command hangs (`while(true)`) | killed at its timeout; a healthy command finishes in <1.5 s meanwhile |
| 3 crashes in 10 min | ⛔ disabled, stays disabled |
| crashes older than 10 min | age out; a fresh crash does not trip the breaker |
| registry reload mid-job | the running job survives |
| job folder after success/failure | deleted in both cases |
| command requiring `gateway/` | possible in principle, and forbidden by grep + test |

---

## 6. Failure handling

| failure | what happens | who sees what |
|---|---|---|
| `command.json` invalid / missing files | the folder is skipped at load, the bot starts | board shows ❌ + reason on `.status` |
| `require()` throws (syntax error, missing dep) | the child exits 1, runner reports the first `…Error:` line | user: `⚠️ .name is down. Reason: …`; `logs/<name>.log` |
| `run()` throws | same, with the error class and message | same |
| hang | child killed at `timeoutSec`, then 2 s grace, then SIGKILL | `⚠️ .name is down` with `timed out after Ns` |
| `process.exit()` | reported as an exit code, never silently treated as success | board ❌ |
| 3 crashes within 10 minutes | circuit breaker: ⛔ disabled | owner notified once; `.toggle name` re-enables |
| lane busy | the message is refused with "busy" | user, no queue |
| send fails | the job fails; the cause is logged | `logs/<name>.log` |



### Every catch keeps the cause

There are **zero** empty `catch {}` blocks in the tree, engine included, and a
test fails if one appears. The ported movie/series engine shipped with 31; they
now log at a level chosen by what the failure means — `warn` where it signals a
real problem (a cache file that will not delete, a leaked scratch dir) and `debug`
where the failure is expected (a discarded body, a `kill` on an already-dead
process, malformed base64). See the migration report §5.5.

### The circuit breaker

`gateway/status.js` counts crashes per command in a 10-minute sliding window. At
3, the command goes ⛔. `check-all` never re-enables a ⛔ command; only
`.toggle <name>` (owner) does. This is deliberate: a command that crashes three
times in ten minutes needs a human, not another attempt.

---

## 7. Users, roles and numbers

- `storage/core/owner.json` — the owner, one person, valid on every linked number.
- `storage/core/numbers/<number>/users.json` — the members **of that number**.
- `storage/core/numbers/<number>/settings.json` — `accessMode` (`open`/`whitelist`),
  `maintenance`, `prefix`.

`gateway/users/store.js` is the **only** writer of `users.json`. Every write:

1. takes an automatic `.bak` copy of the last good file,
2. writes atomically (temp file + rename),
3. appends to `logs/users.log` with the actor, the target and the action.

If `users.json` cannot be parsed, `readUsers` throws `… is corrupt`. It never
falls back to an empty list — silently emptying a member list is exactly the kind
of hidden failure this rebuild exists to remove. If the `.bak` is readable, that
is used and the fact is logged.

A ban is per number. Banning somebody on `265…01` does not touch `265…02`.
The owner is exempt from bans by design: an admin on one number must not be able
to lock the owner out of the bot.

### Guard order (fixed, tested)

```
fromMe → banned → access mode → maintenance → command role → per-user block → cooldown
```

`test/guards.test.js` (18 cases) proves not only that each guard works, but that
they fire **in this order** — e.g. a banned user in whitelist mode requesting an
owner command with a live cooldown is stopped by the ban (silence), not by the
whitelist message, the role refusal, or the cooldown.

### This is a self-bot

Guard 1 requires `fromMe === true`, exactly as the old bot did
(`handler.js:203`). In a direct chat the sender jid *is* the linked number, so:

- the actor of every message is the linked number itself;
- commands that act **on other people** (`.users ban`, maintenance, access mode)
  target *other members on that same number*, which in practice means other
  people in groups, or additional linked numbers;
- the realistic deployment is that each linked number is the owner's own phone.

This is a preserved old behaviour, not a bug introduced here, and it is called
out in the report because it limits what the users system can do in a 1-to-1
chat.

---

## 8. Multi-number sessions

Each linked number is an independent session:

```
sessions/linked/<number>/   Baileys auth state + creds
storage/core/numbers/<number>/  users.json, settings.json
```

`gateway/sessions/manager.js` starts one socket per number and keeps them apart:

- a number that fails to connect is retried on a backoff and **does not** stop
  the others;
- a logged-out number (401) is marked `logged-out` in the session registry and
  reported through `.sessions`; it is not retried in a loop;
- `MAX_LINKED_ACCOUNTS` caps how many can be added.

`.sessions` (owner) shows each number with its state and last error.

---

## 9. The paper family, and the one adapter

`.paper`, `.countpapers` and `.refreshpapers` share a history: they were one
863-line module in the old bot. They now live in three independent folders, and
**each folder keeps its own full copy** of `vault.js`, `paperSearch.js`,
`config.js`, `jsonstore.js`, `sendlog.js`, `tmp.js`, `redact.js` and `adapter.js`.

That is ~7,100 lines of duplicated code, and it is a deliberate cost. The
alternative — one shared `paper-core/` module — is exactly the coupling the brief
forbids: a bug introduced for `.countpapers` would then be able to break `.paper`.
The copies are independent: they have separate vault snapshots, separate send
logs and separate temp handling.

| folder | command | role | lane | cooldown | timeout |
|---|---|---|---|---|---|
| `paper/` | `.paper` (+ `papers`, `pastpaper`, `pp`) | user | heavy | 5 s | 300 s |
| `countpapers/` | `.countpapers` | user | light | 10 s | 60 s |
| `refreshpapers/` | `.refreshpapers` | owner | heavy | 60 s | 600 s |

Config comes from the environment via each folder's own `config.js`:
`DRIME_API_TOKEN`, `DRIME_BASE_URL`, `DRIME_PAPERS_FOLDER_ID`,
`DRIME_PAPERS_FOLDER_HASH`, `DRIME_WORKSPACE_ID`. The token is never logged;
`redact.js` scrubs it from any message before it reaches a log or a user.

Data each copy owns: `storage/commands/<name>/data/` — the vault snapshot and
the 3-day send log.

---

## 10. Storage and cleanup

There is no disk guard. The old bot had one; it is gone.

Cleanup is two rules:

1. `gateway/child.js` deletes `storage/tmp/<name>/<jobId>/` in a `finally` block,
   on success and on failure — **after** the child has finished sending, so a
   document is never removed while it is being uploaded. The runner waits for the
   child to exit on its own, and only forces it after 5 s.
2. Anything the command wrote to its **own** `storage/commands/<name>/` folder is
   its own business; that is durable state, not scratch.

`storage/tmp` should therefore be empty between jobs. If it is not, the command
that owns the folder leaked it.

---

## 11. Status board and `check-all`

`gateway/status.js` holds, per command:

```json
{ "state": "ok|broken|disabled|unknown", "reason": "", "lastOkAt": "", "lastErrorAt": "", "source": "boot|check|runtime|load" }
```

Written to `storage/core/status.json`. `.status` renders it; `.menu` marks ❌/⛔
rows so a broken command is visible where users look first.

`scripts/check-all.js`:

- runs `check.js` for every command, one at a time, in a child process with a
  180 s cap;
- prints one line per command: `✅ name`, `❌ name → reason`, `⛔ name`;
- writes the board to `status.json` with `source: 'check'`;
- **never** re-enables a ⛔ command;
- exits non-zero if anything failed;
- supports `--json` and a name filter (`node scripts/check-all.js song paper`).

```
12 passed · 10 failed · 22 checked
```

Every failure is external: the Drime token is absent, and the sandbox cannot
reach any provider host (`ECONNRESET` / `ENOTFOUND`). Every offline stage of every
check passes. See the migration report for the full table.

---

## 12. Logging

| path | contents |
|---|---|
| `logs/gateway.log` | boot, sessions, guard refusals, runner failures |
| `logs/<command>.log` | everything a command logged, plus the exact cause of any failure |
| `logs/users.log` | every users.json mutation: actor, target, action, timestamp |

`LOG_LEVEL` (`debug`|`info`|`warn`|`error`) controls console verbosity. Error
messages are compressed to their first line plus the error class before they are
shown to a user or written to the board; the full stack stays in the log file.

`scripts/backup.js` copies `numbers/`, `core/` and `sessions/` into
`storage/backups/<timestamp>/`, mode `0600`, keeping the newest 10, with a
`manifest.json` and `FILES.txt`. Verified: 6 settings files, 12 core files.

---

## 13. Running it

```bash
# one-time
npm install
cp .env.example .env      # fill in PAIR_NUMBER and the provider keys
node scripts/add-owner.js 265991234567

# develop
npm test                  # 76 tests
npm run check-all         # the board, exit 1 if anything failed
./scripts/isolation-proof.sh

# run
npm start                 # or: pm2 start ecosystem.config.js
node scripts/backup.js
```

`ecosystem.config.js`: one forked instance (`instances: 1`, `exec_mode: 'fork'`),
`--expose-gc`, 900 MB memory cap, restart delay 4 s with exponential backoff,
`max_restarts: 20`, logs to `./logs/`.

One instance is a requirement, not a default: the sessions, the circuit breaker
and the per-number users files are all in-process state, and two pm2 workers
would fight over them.

---

## 14. Why there are no fallbacks

The old bot chained providers: if ApisSupreme failed, try KnightBot; if the
movie engine failed, try the next quality; if ffmpeg was missing, try the system
binary. Each step hid the real failure and made "it worked" meaningless.

The rule now: **one code path per feature.** If that path fails, the command
fails, loudly, with the provider's own words in the log and a short reason to the
user. The full list of removed chains is in the migration report; the notable
ones:

- `.song` → ApisSupreme `/media/ytmp3` only.
- `.video` → KnightBot 480p only.
- `.ig` → `ruhend-scraper` only.
- `.fb` → ApisSupreme `/media/facebook` only.
- `.movie` / `.series` → one resolve; the retry ladder and `QUALITY_FALLBACK`
  are gone.
- `.sticker` → the packaged `@ffmpeg-installer` binary only; `FFMPEG_MISSING`
  instead of a system-binary search.
- WA version → `fetchLatestWaWebVersion` throws instead of a hardcoded version.
- `.info` → Cinemeta only; the old TMDB → … → AniList chain is gone.

---

## 15. Adding a command

1. `cp -r commands/_template commands/mycommand`
2. Edit `command.json`: unique name, unique aliases, real `limits`, a `sample`.
3. Write `index.js` — `async run(ctx)`, nothing else.
4. Write `check.js` — offline stages, then one real call, `throw` on failure.
5. Write `NOTES.md` — limits, failure modes, differences.
6. `npm run check-all mycommand`
7. `.reload mycommand`

The registry refuses the folder until all four files exist, and that failure is
visible on `.status` with the missing filename. Nothing else in the bot needs to
change.
