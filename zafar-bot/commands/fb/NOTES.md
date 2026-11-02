# fb

`.fb <link>` → Facebook video or reel. Aliases: `fbdl`, `facebookdl`, `facebook`.

## How it works

1. `urls.js` validates the link (facebook.com, fb.watch, fb.com, m.facebook.com).
2. `scraper.js` calls **ApisSupreme**'s `media/facebook` — one provider.
3. `download.js` streams it into `ctx.tmp`, refusing > `maxSizeMB`.
4. `ctx.send.video` or `ctx.send.image`; gateway deletes the file.

## External service

| Service | Why | Key |
|---|---|---|
| `apissupreme.vercel.app/media/facebook` | Facebook → media URL | `XJX_APISSUPREME_API_KEY` (optional) |

## Fallbacks removed

Old `utils/socialMedia.js` shared this path with `.ig`. Split per rule 2; `.fb`
now owns `urls.js`, `scraper.js` and `download.js` outright.

## Failure modes

| Log line | Meaning | Fix |
|---|---|---|
| `APISSUPREME_HTTP ... 403` | rejected | check `XJX_APISSUPREME_API_KEY` |
| `APISSUPREME_EMPTY` | 200 with no media URL | private/deleted video, or the JSON shape changed — fix `scraper.js` |
| `DOWNLOAD_HTTP` | CDN refused | retry once; FB media URLs expire |
| `TOO_BIG` | over 2000 MB | expected |

## Limits

`maxSizeMB 2000` · `timeoutSec 180` · `cooldownSec 8` · lane `heavy`.

## Fix flow

`node commands/fb/check.js` → fix `scraper.js` → `.reload fb`.
