# song

`.song <name|url>` → MP3. Aliases: `.play`, `.yta`.

## How it works

1. `search.js` resolves the input to one YouTube URL with **yt-search**.
2. `index.js` refuses early if the track is longer than `limits.maxDurationMin` (180).
3. `apisupreme.js` asks one endpoint for the audio URL and streams it to `ctx.tmp`.
4. `ctx.send.audio` delivers it; the gateway deletes the file, the child deletes the job folder.

## External services

| Service | Why | Key |
|---|---|---|
| `yt-search` (npm) | name → YouTube URL | none |
| `apissupreme.vercel.app/media/ytmp3` | YouTube → MP3 URL | `XJX_APISSUPREME_API_KEY` (optional) |

## Fallbacks removed

The old resolver tried **five** providers in order:
KnightBot → ApisSupreme → Apix → Hector URL → Hector search.

Only **ApisSupreme** remains. If it dies, `.song` dies, loudly, with the HTTP
status in the log. That is the point: one path, one thing to debug.

## Failure modes

| Log line | Meaning | Fix |
|---|---|---|
| `APISSUPREME_HTTP ... HTTP 403` | endpoint rejected the request | check `XJX_APISSUPREME_API_KEY`; if the provider is gone, replace `apisupreme.js` |
| `APISSUPREME_EMPTY` | 200 with no media URL | the provider changed its JSON shape; fix the field names in `apisupreme.js` |
| `DOWNLOAD_HTTP ... HTTP 404` | media URL expired | retry; if constant, the provider is broken |
| `TOO_BIG` | over `maxSizeMB` (120) | raise the limit deliberately, or accept the refusal |
| `❌ No songs found` | yt-search found nothing | normal for nonsense input |
| `timed out after 180s` | provider hung | check the provider; the timeout is `timeoutSec` |

## Limits

`maxDurationMin 180` · `maxSizeMB 120` · `maxInputChars 300` · `timeoutSec 180` ·
`cooldownSec 10` · lane `heavy`.

## Fix flow

1. `.status song` → ❌ with the reason.
2. `node commands/song/check.js` — this does a real download, so it reproduces the failure.
3. Fix `apisupreme.js` (or the JSON field names).
4. `.reload song`. Nothing else restarts.
