# template

Copy this folder, rename it, and edit four things: `command.json`, `index.js`,
the logic file, and this file.

## What it does

Echoes input back. It exists only as the reference shape.

## External service

None.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `❌ template — run() sent nothing` | `index.js` returned before sending | make sure every branch replies |
| `❌ template — missing "sample"` | `command.json` incomplete | the registry refuses to load the command; fix the JSON |

## Limits

`maxInputChars: 200`. Checked before any work happens.

## Fix flow

1. `.status` shows `❌ template → reason`.
2. Read this file, fix the code.
3. `node commands/_template/check.js` until ✅.
4. `.reload template` — nothing else restarts.
