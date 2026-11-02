# ping

## What it does

Replies `🏓 Pinging...`, measures the round trip, then sends `🏓 *Pong!* · <ms>ms`.

## External service

None. If this is ❌, the problem is the gateway or the session socket, not the command.

## Behaviour note

The old command sent one message and *edited* it into the Pong line. `ctx` has no
`edit`, so this sends two messages. Same command, same wording, same aliases.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `❌ ping — expected the Pong line` | reply wording changed | restore the `🏓 *Pong!* · {ms}ms` string |
| ⚠️ .ping is down | the socket refused the send | check logs/gateway.log for the send error |

## Fix flow

`node commands/ping/check.js` → `.reload ping`.
