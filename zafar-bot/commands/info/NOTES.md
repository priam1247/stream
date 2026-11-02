# info

`.info [series] <title>` — aliases `meta`, `ids`, `lookup`.

## What it does

Renders a metadata card: title, year, rating, runtime, seasons/episodes, genres,
short overview. Wording is identical to the old `info.js`.

## External service

Cinemeta (`v3-cinemeta.strem.io`), keyless. **One source.** The old `.info` used
the shared movie engine's multi-source metadata chain (TMDB → Cinemeta → IMDb →
TVMaze → OMDb → Trakt → Jikan → AniList). That chain belongs to `.movie`/`.series`
now, and a command may not import another command, so `.info` asks Cinemeta
directly. Reported as a behaviour difference.

## Failure modes

| Log line | Meaning | Fix |
|---|---|---|
| `METADATA_HTTP ... 503` | Cinemeta down | wait; there is no second source by design |
| `❌ Not found` | genuinely absent | check the spelling |
| card missing the rating line | Cinemeta returned no rating | normal for obscure titles |

## Limits

`maxInputChars 120` · `timeoutSec 60` · `cooldownSec 5`.

## Fix flow

`node commands/info/check.js` — stage 1 (parsing/rendering) is offline.
