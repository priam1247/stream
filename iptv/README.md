# IPTV Download Machine (`iptv_dl.py`)

A zero-dependency Python CLI tool to fetch, search, health-check, and record/download streams from M3U playlists (including `dzh0ni/iPTV-FREE-LIST`).

## Requirements

- Python 3.10+
- `ffmpeg` (only required for the `download` command)

## Usage

### 1. Fetch & parse a playlist
Presets: `tv` (`iPTV-Free-List_TV.m3u`), `xxx` (`iPTV-Free-List_XXX.m3u`), `all` (`iPTV-Free-List.m3u`), or any `.m3u` URL / local file path.

```bash
python3 iptv_dl.py fetch tv -o channels.json
```

### 2. Search channels
```bash
python3 iptv_dl.py search tv -q "news" -n 10
python3 iptv_dl.py search tv -g "Sports"
```

### 3. Health-check which streams are live
```bash
python3 iptv_dl.py check tv -q "news" -n 20 -w 8
```

### 4. Download / record a stream
```bash
# Record the first matching channel for 60 seconds
python3 iptv_dl.py download tv -q "news" -d 60 -o news_clip.mp4

# Or record directly from a stream URL
python3 iptv_dl.py download --url "https://example.com/stream.m3u8" -d 30 -o out.mp4
```

## Running Tests

```bash
python3 -m unittest test_iptv_dl.py -v
```
