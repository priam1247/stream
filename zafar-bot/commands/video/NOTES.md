# video

`.video <name|url>` → MP4 at 480p. Alias: `.ytmp4`.

## How it works

1. `search.js` resolves name/URL to one YouTube URL (yt-search).
2. `index.js` refuses early if over `maxDurationMin` (0 = no limit).
3. `knightbot.js` requests the video URL and streams it to `ctx.tmp`, refusing
   anything over `maxSizeMB`.
4. `ctx.send.video` delivers it; gateway deletes the file, child deletes the job folder.

## External services

| Service | Why | Key |
|---|---|---|
| `yt-search` | name → YouTube URL | none |
| `knightbotapi.stream/api/download/ytvideo` | YouTube → MP4 URL | `XJX_KNIGHTBOT_API_KEY` (optional) |

## Fallbacks removed

Old chain: **KnightBot → Keithsite**. Keithsite deleted. Keep only KnightBot.

## Failure modes

| Log line | Meaning | Fix |
|---|---|---|
| `KNIGHTBOT_HTTP ... 403` | rejected | check `XJX_KNIGHTBOT_API_KEY` |
| `KNIGHTBOT_EMPTY` | 200, no media URL | provider JSON changed; fix field names in `knightbot.js` |
| `TOO_BIG` | over `maxSizeMB` (2000) | expected for feature-length uploads |
| timed out | provider hung | `timeoutSec` 240 |

## Limits

`maxSizeMB 2000` · `maxDurationMin 0` (no limit, same as the old bot) ·
`timeoutSec 240` · `cooldownSec 10` · lane `heavy`.

## Fix flow

`node commands/video/check.js` → fix `knightbot.js` → `.reload video`.
