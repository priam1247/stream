# users

Manages the user list **of the linked number that received the command**. Every
number has its own `storage/core/numbers/<number>/users.json`.

## What it does

| Subcommand | Effect |
|---|---|
| `.users list` | everyone on this number |
| `.users info <number>` | record detail |
| `.users add <number>` | adds as `user` |
| `.users remove <number>` | deletes the record |
| `.users ban <number>` | role → banned, silently ignored after |
| `.users unban <number>` | role → user |
| `.users role <number> admin\|user` | changes rank |
| `.users block <number> <command>` | blocks one command |
| `.users unblock <number> <command>` | removes that block |

## Why it cannot corrupt users.json

The command never requires `gateway/users/store.js` — it *cannot*, it runs in a
child process whose only door is `ctx`. It calls `ctx.admin({action, target,
extra})`; the gateway re-checks the actor's role and applies the change through
the store. `gateway/users/store.js` is the only writer.

## Escalation rules

- promoting to `owner` is impossible from here (owner is set once, globally)
- the owner cannot be banned, removed, or demoted per-number
- changing an existing admin's role requires the owner
- every rejection is an error string, never a silent no-op

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `❌ No such user on this number` | record does not exist | `.users add <number>` first |
| `this action needs role "owner"` | an admin tried an owner action | use the owner account |
| changes not visible | you edited a different number | check `.sessions`, the list is per number |

## Fix flow

`node commands/users/check.js` → `.reload users`.
