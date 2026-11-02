# reload

`.reload <command>` re-reads the command registry. Nothing restarts.

## What it does

Re-scans `commands/`, re-validates every `command.json`, and replaces the routing
table. The command you named is reported on individually: if its folder is now
invalid it becomes ❌ with the exact reason, and every other command keeps its
previous entry.

## Why it is safe

Commands run in their own child process and their code is `require`d *inside*
that process. A reload therefore cannot disturb a command that is mid-job: the
running child already has its copy of the code.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `❌ .x failed to reload: command.json ...` | JSON typo or missing file | fix `command.json`, run `check.js` |
| `♻️ Reloaded` but behaviour unchanged | edited the wrong folder | the folder name must equal `name` in command.json |

## Fix flow

`node commands/reload/check.js` → `.reload reload`.
