# toggle

`.toggle <command>` flips one command between ✅ and ⛔.

## What it does

Sets or clears the entry in `storage/core/disabled.json` and the 🔴 status. A
disabled command is still loaded and still listed — it just refuses with
`⛔ .<name> is disabled (reason)`.

## External service

None.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `❌ No command named X` | typo, or the command failed to load | `.status` shows load errors |
| disabled state lost after restart | `storage/` not persisted | do not wipe `storage/`; it is git-ignored on purpose |

## Fix flow

`.toggle ping` twice to confirm it flips. `node commands/toggle/check.js`.
