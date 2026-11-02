# providers

`.providers` · alias `sources`.

## What it does

Lists the movie/series source providers in reliability order.

## Behaviour difference

The old `.providers` asked the engine for **live health** per provider
(`state: live / half-open / open`). That engine now lives inside
`commands/movie/engine/` and `commands/series/engine/`, and a command may not
import another command (rule 1). So this lists the providers and states plainly
that health is reported by `.movie`/`.series` when they run.

Reported in MIGRATION_REPORT.md as a behaviour difference.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| list is empty | someone deleted PROVIDERS | restore it |

## Fix flow

`node commands/providers/check.js`.
