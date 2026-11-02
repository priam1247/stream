# botmanage

Owner-only switchboard for **this number**.

## What it does

| Command | Effect |
|---|---|
| `.botmanage show` | access mode, maintenance, prefix |
| `.botmanage access open` | anyone not banned may use the bot |
| `.botmanage access whitelist` | only users in `users.json` |
| `.botmanage maintenance on` | only admin/owner pass |
| `.botmanage maintenance off` | normal service |
| `.botmanage restart` | exits non-zero so pm2 restarts with fresh code |

Writes go to `storage/core/numbers/<number>/settings.json`, through the gateway,
through the store.

## External service

None.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `this action needs role "owner"` | you are admin, not owner | run `npm run add-owner -- <number>` once |
| restart loops | pm2 not configured | use `ecosystem.config.js`, or run `npm start` under a supervisor |
| turned on whitelist and locked yourself out | you removed your own number | the owner always passes, per number, by design |

## Fix flow

`node commands/botmanage/check.js` → `.reload botmanage`.
