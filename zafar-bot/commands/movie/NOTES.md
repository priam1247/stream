# movie

`.movie <title> [year]` — aliases `film`, `mv`.

## How it works

1. `query.js` parses the title and an optional year (offline, tested).
2. `engine-bridge.js` points **this command's own copy** of the engine
   (`commands/movie/engine/`) at `ctx.tmp` and at the limits from `command.json`.
3. `bridge.search()` finds the title.
4. Limits are checked **before** any download.
5. `engine.default.resolveMovie()` resolves one source.
6. `ctx.send.text` delivers the result.

## Why this command is a single-slot lane

`"lane": "single"` with `maxConcurrent: 1`. The gateway refuses a second movie
job with `⏳ .movie is busy with another job` instead of queueing it. A 2 GB
download cannot starve every other command.

## Fallbacks removed

- The engine shipped a **1080 → 720 → 480 quality fallback**. It is switched off
  (`QUALITY_FALLBACK=0` in `engine-bridge.js`). If 720p has no source, the
  command fails and says so — it does not silently deliver 480p.
- The engine's **host bridge** (`engine/host.js`) used to reach back into the bot
  for ffmpeg and the N_m3u8DL accelerator. Those hooks now return `null`; the
  engine uses only code inside this folder.
- The old `movie.js` retried providers up to 3 times with an `exclude` list. The
  new command resolves once. Retrying N providers is exactly the fallback chain
  the spec forbids.

## External services

TMDB (metadata, optional key), Cinemeta / IMDb / TVMaze (keyless metadata), and
the engine's provider registry. See `engine/providers/`.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `❌ Not found` | metadata returned nothing | check the title/year; network first |
| `no source found ... at 720p (quality fallback is disabled)` | no provider has 720p | expected; this is the removed fallback. Set a different quality deliberately if you want it |
| `❌ That file is N MB` | over `maxSizeMB` | the file is bigger than the WhatsApp ceiling |
| `ENGINE_LOAD` | the engine copy is broken | run `node commands/movie/check.js` |
| timed out after 900s | provider hung | single-slot lane means nothing else is blocked |

## Limits

`maxSizeMB 2000` · `maxDurationMin 240` · `maxConcurrent 1` · lane `single` ·
`timeoutSec 900` · `cooldownSec 30`.

## Fix flow

`node commands/movie/check.js` (stage 1 is offline and must pass even with no
network) → fix `engine-bridge.js` or `engine/` → `.reload movie`.
