# status

`.status` prints the health board. `.status <command>` prints one command's detail.

## What it does

```
*Health board* · ✅ 3 · ❌ 1 · ⛔ 1

✅ .menu
❌ .ig → snapsave returned 403 (last ok: 2h ago)
⛔ .movie (disabled by admin)
```

The board is generated from the gateway's status snapshot, which is persisted in
`storage/core/status.json`, so a restart does not lose the reason a command broke.

## States

| Icon | State | Means |
|---|---|---|
| ✅ | ok | its check.js passed, or a real run completed |
| ❌ | broken | check or a real run failed; the reason is stored |
| ⛔ | disabled | admin toggle, or the circuit breaker |
| ⚪ | unknown | loaded but never run — normal right after a fresh start |

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| every row is ⚪ | nothing has run yet today | run `npm run check-all` |
| ❌ row with a stack trace | a real run threw | read `logs/<name>.log`, then NOTES.md for that command |

## Fix flow

`.stop` → read the ❌ reason → open that command's folder → fix → `node
commands/status/check.js` → `.reload <name>` → `.status`.
