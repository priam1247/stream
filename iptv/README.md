# IPTV Download Machine (`iptv_dl.py`)

A zero-dependency Python CLI tool to fetch, search, health-check, and record/download streams from M3U playlists (including `dzh0ni/iPTV-FREE-LIST`, `iptv-org`, `Free-TV/IPTV`, and `m3u.cl`).

## Requirements

- Python 3.10+
- `ffmpeg` (only required for the `download`/`pick` commands)
- `yt-dlp` (optional — only needed for YouTube/Twitch live links found in `Free-TV/IPTV`)

## Playlist presets

| Preset | Source |
| --- | --- |
| `tv` | `dzh0ni/iPTV-FREE-LIST` → `iPTV-Free-List_TV.m3u` |
| `xxx` | `dzh0ni/iPTV-FREE-LIST` → `iPTV-Free-List_XXX.m3u` |
| `all` | `dzh0ni/iPTV-FREE-LIST` → `iPTV-Free-List.m3u` |
| `popeye` | `dzh0ni/iPTV-FREE-LIST` → `Maratones/Maratones_Popeye_El_Marino.m3u` |
| `iptv-org` | `iptv-org` → `index.m3u` (one stream per `tvg-id`) |
| `iptv-org-all` | `iptv-org` → `api/streams.json` (**every mirror**, incl. Pluto/Rakuten feeds, `user_agent`/`referrer`, and `Geo-blocked` / `Not 24/7` labels) |
| `iptv-org-es` | `iptv-org` → `languages/spa.m3u` (Spanish) |
| `free-tv` | `Free-TV/IPTV` → `playlist.m3u8` |
| `m3u-cl` | `m3u.cl` → `lista/total.m3u` (Chile) |
| `m3u-cl-top` | `m3u.cl` → `lista/top.m3u` (Chile, top channels) |

Any preset name can be replaced with a direct playlist URL or a local file path.

> **Note:** the `📡 IPTV Online 🌐` section of the `dzh0ni/iPTV-FREE-LIST` README mixes real M3U playlists (`m3u.cl`, `iptv-org`, `Free-TV`) with ordinary browser links (`lookhu.tv`, `pluto.tv/es`, Plex, NASA+, etc.). The `🎞️ Movies, Series, Anime and More 🍿` tables (Pelisplus, Cuevana, Gnula, AnimeFLV, TioAnime, …) are **HTML streaming websites, not playlists** — they are meant to be opened in a browser with an ad-blocker, so this tool does not scrape them.

## Usage

### 1. Fetch & parse a playlist
```bash
python3 iptv_dl.py fetch tv -o channels.json
python3 iptv_dl.py fetch iptv-org-all -o every-mirror.json
```

### 2. Search channels
```bash
python3 iptv_dl.py search tv -q "news" -n 10
python3 iptv_dl.py search tv -g "Sports"
python3 iptv_dl.py search iptv-org-all -q "naruto"
```

### 3. Health-check which streams are live
`check` resolves the HLS master playlist, picks the stream variant, and requests the
first media segment — so streams that serve a playlist but geo-block their `.ts`
segments (a very common `HTTP 403 Forbidden` case) are reported as `DEAD` instead of
hanging in `ffmpeg`.

```bash
python3 iptv_dl.py check tv -q "news" -n 20 -w 8
python3 iptv_dl.py check iptv-org-all -q "naruto" -n 10
```

### 4. Download / record a stream
```bash
# Record the first matching channel for 60 seconds
python3 iptv_dl.py download tv -q "news" -d 60 -o news_clip.mp4

# Or record directly from a stream URL
python3 iptv_dl.py download --url "https://example.com/stream.m3u8" -d 30 -o out.mp4

# Prefer a 720p variant and cap the segment bitrate/file size
python3 iptv_dl.py download iptv-org-all -q "naruto" --max-height 720 -d 120 -o naruto.mp4
```

`download` (and `pick`) pre-flight the stream before launching `ffmpeg`, then:

- forward the playlist's `#EXTVLCOPT` / `#KODIPROP` / `http-user-agent` /
  `http-referrer` headers to `ffmpeg` (`-user_agent`, `-headers`, `-http_proxy`);
- fall back to the next matching mirror automatically when the first one is dead or
  geo-blocked (tune with `--fallbacks N`);
- abort `ffmpeg` instead of looping forever when segments keep returning
  `HTTP error 403 Forbidden` and no media has been written;
- use `-sn -c copy` so HLS playlists that expose WebVTT subtitles remux cleanly, and
  AAC audio still gets its `aac_adtstoasc` bitstream filter applied automatically;
- warn you when the stream is a 24/7 live broadcast without `#EXT-X-ENDLIST`
  (pass `-d <seconds>` to record a fixed clip, or press `q` to stop and save).

### 5. Interactive picker
```bash
python3 iptv_dl.py pick iptv-org-all -q "naruto"
python3 iptv_dl.py pick all -q "naruto" --check      # list only playable mirrors
python3 iptv_dl.py pick all -q "naruto" --fallback   # auto-try other mirrors on failure
```

`pick` accepts `1`, `1-5`, `1,3`, or `all`, and offers to try the other matching
mirrors if the selected stream fails.

## Common failures

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `Stream preflight failed: HTTP 403 Forbidden on media segments` | The playlist is public but the CDN geo-blocks the video segments (e.g. US-only Samsung TV Plus / Pluto feeds). | Try `iptv-org-all` and pick a different mirror, or route through `--proxy http://host:port`. |
| `HTTP 404` / `no media segments` | The channel went offline. | Search again — playlists rotate often. |
| `ffmpeg is not installed` | `ffmpeg` missing from `PATH`. | Install `ffmpeg`. |
| `requires yt-dlp on PATH` | The entry is a YouTube/Twitch page rather than an HLS URL. | `pip install yt-dlp`. |

## Header flags

Every network/download subcommand accepts:

- `--proxy HTTP(S)://host:port` — useful for geo-blocked channels.
- `--user-agent "..."` — override the default browser UA.
- `--referer "..."` — override the playlist's referrer.
- `--max-height 720` — cap the selected HLS variant height.
- `--no-preflight` — skip the playlist/segment check (not recommended).

## Running Tests

```bash
python3 -m unittest discover -s iptv -v
```
