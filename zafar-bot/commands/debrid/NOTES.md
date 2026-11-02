# debrid

`.debrid` · aliases `rd`, `debridstatus`.

## What it does

Replies with one fixed sentence explaining that debrid services are no longer
used. Preserved verbatim from the old `commands/general/debrid.js`.

## External service

None. If `.debrid` is ❌, the gateway or the socket is broken — not this command.
That makes it the cleanest liveness probe in the bot.

## Failure modes

| Symptom | Cause |
|---|---|
| wording differs from the old bot | someone edited the string; `check.js` asserts it |

## Fix flow

`node commands/debrid/check.js`.
