# series

`.series <title> s01e01` — aliases `tvshow`, `episode`.

## How it works

1. `query.js` parses `Title (year)? sNNeNN` (offline, tested against five forms).
2. `engine-bridge.js` configures **this command's own copy** of the engine.
3. `bridge.search()` finds the show.
4. Runtime and batch limits are checked **before** any download.
5. `engine.default.resolveEpisode()` resolves one episode.
6. `ctx.send.text` delivers it.

## Why this command is a single-slot lane

`"lane": "single"`, `maxConcurrent: 1`, and **`maxEpisodesPerRun: 1`**.

The old `.series` accepted a batch of up to 10 episodes (`MOVIE_BATCH_LIMIT`).
One request could fill a 10 GB disk and take the whole bot with it. Asking for a
range now gets:
`❌ One episode per command (max 1). Ask again for the next one.`

## Fallbacks removed

- quality fallback 1080 → 720 → 480: **off** (`QUALITY_FALLBACK=0`)
- the old 3-attempt provider retry with an `exclude` list: **gone**, one resolve
- the engine's outside-the-folder host hooks: **gone** (`engine/host.js`)

## External services

Same metadata and provider set as `.movie`, in this command's own
`engine/providers/` copy.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `❌ Include the episode` | no `s01e01` in the input | required, same as the old usage |
| `❌ One episode per command` | a range or list was given | ask for one |
| `no source ... (quality fallback is disabled)` | 720p missing | deliberate; the fallback is removed |
| `ENGINE_LOAD` | the engine copy is broken | `node commands/series/check.js` |

## Limits

`maxSizeMB 2000` · `maxDurationMin 90` · `maxEpisodesPerRun 1` ·
`maxConcurrent 1` · lane `single` · `timeoutSec 900` · `cooldownSec 30`.

## Fix flow

`node commands/series/check.js` → fix → `.reload series`.
