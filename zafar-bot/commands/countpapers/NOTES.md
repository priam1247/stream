# countpapers

`.countpapers` — aliases `listpapers`, `papercount`, `vaultcount`.

Prints the headline count for the whole vault in one Drime request.

It uses the same vault copy as `.paper`, but reads only the folder count, so it is
the cheapest way to confirm Drime credentials work.

## How it works

The original 863-line implementation is preserved verbatim in `vault.js`, with
only its dependency edges rewired to files inside this folder:

| Was | Now |
|---|---|
| `../../config` | `./config` (reads `DRIME_*` from the environment) |
| `../../database` (paper_log.json) | `./sendlog` → `storage/commands/paper/data/paper_log.json` |
| `../../utils/tempManager` | `./tmp` (files land in the job folder) |
| `../../utils/jsonStore` | `./jsonstore` (atomic + .bak, own copy) |
| `../../utils/paperSearch` | `./paperSearch` (own copy) |
| `../../utils/safeLog` | `./redact` |
| `../../utils/telemetry` | no-op |
| `database/vault_snapshot.json` | `storage/commands/paper/data/vault_snapshot.json` |

`adapter.js` presents the old `(sock, msg, args, extra)` contract on top of
`ctx`, so the vault logic itself is untouched.

## External service

Drime Cloud. Requires `DRIME_API_TOKEN`; folder id/hash/workspace come from the
environment. **401** = token rejected. **403** = token valid, folder/workspace
permission missing. Both are reported to the owner with that distinction.

## Behaviour preserved

- the 3-day "already sent in this chat" rule (`sendlog`)
- 10 papers maximum per query (`PAPER_MAX_PER_QUERY`)
- snapshot + delta sync + parallel page walk
- "did you mean" suggestions for a mistyped course code

## Behaviour differences

- `extra.status(...).update(...)` used to edit the first message. `ctx` has no
  edit, so the final text is a second message. Same information.
- errors that used to be swallowed now propagate: the command fails loudly and
  the user sees `⚠️ .paper is down` instead of a vague "unavailable".

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `⚙️ Paper vault not configured.` | `DRIME_API_TOKEN` empty | set it in `.env` |
| `❌ Paper vault authentication failed` (owner) | 401 | rotate the token |
| `❌ Paper vault access denied` (owner) | 403 | check folder id/hash/workspace |
| `❌ No papers for X` | genuinely absent | the "did you mean" hint names the closest code |
| snapshot missing after deploy | `storage/` was wiped | harmless; the first query rebuilds it (slower) |

## Limits

`maxPapersPerQuery 10` · `timeoutSec 300` · `cooldownSec 5` · lane `heavy`.

## Fix flow

`node commands/paper/check.js` → the failure tells you whether it is the parser
(offline stage) or Drime (network stage) → `.reload paper`.
