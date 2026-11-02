# menu

## What it does

Renders the command menu from the live registry, grouped by category, honouring
the configured prefix and hiding commands the caller cannot run.

`.menu` shows everything permitted. `.menu media` / `.menu admin` / `.menu papers`
/ `.menu general` shows one section.

## External service

None.

## Behaviour difference from the old bot

The old `menu.js` had a hand-written list. It advertised `.dl` and `.ytv`, which
do not exist anywhere in the codebase. This menu lists only commands that
actually loaded, so it cannot drift.

Hiding a row is cosmetic: the guard in `gateway/guards.js` is what actually
refuses a command.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `❌ The command catalogue is empty` | every command failed to load | run `npm run check-all`, fix the load errors |
| section filter returns "No section named" | typo in the section | valid: general, media, papers, admin |

## Fix flow

`node commands/menu/check.js` → `.reload menu`.
