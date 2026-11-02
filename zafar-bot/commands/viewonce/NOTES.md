# viewonce

`.viewonce` (reply to a view-once message) — aliases `readvo`, `read`, `vv`, `readviewonce`.

## What it does

Unwraps the view-once envelope, downloads the media, and resends it as a normal
image/video/audio.

## Why this command is delicate

The four envelope shapes (`viewOnceMessageV2`, `viewOnceMessageV2Extension`,
`viewOnceMessage`, and a plain `imageMessage.viewOnce`) change when WhatsApp
changes them. `check.js` tests all four plus two negatives, offline.

## External service

None. Media comes through the gateway's socket; the command never sees Baileys.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `That message is not a view-once message` | envelope changed | add the new shape in `innerOf()` and to `check.js` |
| `❌ That media is NMB` | over the 64 MB cap | raise `maxSizeMB` deliberately |
| `empty file` in the error | the sender's media expired | nothing to fix |

## Limits

`maxSizeMB 64` · `timeoutSec 60`.

## Fix flow

`node commands/viewonce/check.js` → `innerOf`/`kindOf` are the only moving parts.
