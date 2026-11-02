# ig

`.ig <link>` → Instagram photos/reels/videos. Aliases: `instagram`, `insta`, `igdl`, `reels`.

## How it works

1. `urls.js` validates the link and rejects anything that is not Instagram.
2. `scraper.js` calls **ruhend-scraper**'s instagram downloader — one provider.
3. `download.js` streams each item into `ctx.tmp`, refusing > `maxSizeMB`.
4. `ctx.send.video` / `ctx.send.image` per item; gateway deletes each file.

## External service

| Service | Why | Key |
|---|---|---|
| `ruhend-scraper` (npm) | Instagram → media URLs | none |

## Fallbacks removed

Old `utils/socialMedia.js` shared the Instagram path with `.fb` and kept a
"public" fallback branch. Both are gone: `.ig` owns its code, and there is one
provider.

## Failure modes

| Log line | Meaning | Fix |
|---|---|---|
| `PROVIDER_FAILED: the Instagram resolver failed: ...` | ruhend threw (blocked, private post, rate limit) | retry; if constant, the scraper is dead — replace `scraper.js` |
| `NO_MEDIA` | ruhend answered with nothing | often a private/deleted post; confirm the link works in a browser |
| `DOWNLOAD_HTTP ... 403` | Instagram's CDN refused the media URL | usually expired links; retry once |
| `TOO_BIG` | one item over 200 MB | expected; raise the limit deliberately |

## Limits

`maxItems 10` (same as the old bot) · `maxSizeMB 200` · `timeoutSec 180` ·
`cooldownSec 8` · lane `heavy`.

## Fix flow

`node commands/ig/check.js` — stage 1 is offline (validation), stage 2 needs
network. Fix `scraper.js` → `.reload ig`.
