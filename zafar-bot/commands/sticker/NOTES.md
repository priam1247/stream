# sticker

`.sticker` (reply to an image, video, GIF or sticker) — aliases `s`, `stiker`, `stc`.

## What it does

Downloads the quoted media, converts it to a 512×512 WebP sticker with ffmpeg,
embeds pack metadata, sends it as a document named `sticker.webp`.

## Fallbacks removed

The old `utils/ffmpeg.js` resolved a **system** ffmpeg and fell back to the
**packaged** binary. Two paths meant two different outputs and a silent downgrade
when the system one was half-installed. `ffmpeg.js` here uses the packaged binary
only and throws `FFMPEG_MISSING` if it is absent.

## External service

None. ffmpeg runs locally.

## Failure modes

| Log line | Meaning | Fix |
|---|---|---|
| `FFMPEG_MISSING` | `@ffmpeg-installer/ffmpeg` not installed | `npm install` |
| `FFMPEG_FAILED ...` | ffmpeg rejected the input | check the media; the log has ffmpeg's last two lines |
| `📎 Reply to an image or video` | nothing quoted, or wrong type | expected |
| `❌ File too large` | over 50 MB | expected |

## Limits

`maxSizeMB 50` · `maxAnimatedKB 1000` · `timeoutSec 120`.

## Fix flow

`node commands/sticker/check.js` — it runs a **real** ffmpeg conversion to a
512×512 WebP, so a pass means the pipeline genuinely works.
