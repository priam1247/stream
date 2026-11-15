#!/usr/bin/env python3
"""
IPTV Download Machine — parse, search, health-check, and record/download
streams from M3U playlists (including dzh0ni/iPTV-FREE-LIST).
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

PLAYLIST_PRESETS = {
    "tv": "https://raw.githubusercontent.com/dzh0ni/iPTV-FREE-LIST/master/iPTV-Free-List_TV.m3u",
    "xxx": "https://raw.githubusercontent.com/dzh0ni/iPTV-FREE-LIST/master/iPTV-Free-List_XXX.m3u",
    "all": "https://raw.githubusercontent.com/dzh0ni/iPTV-FREE-LIST/master/iPTV-Free-List.m3u",
    "popeye": "https://raw.githubusercontent.com/dzh0ni/iPTV-FREE-LIST/master/Maratones/Maratones_Popeye_El_Marino.m3u",
    "iptv-org": "https://iptv-org.github.io/iptv/index.m3u",
}

EXTINF_ATTR_RE = re.compile(r'([\w-]+)="([^"]*)"')


@dataclass
class Channel:
    name: str
    url: str
    group: str = ""
    tvg_id: str = ""
    tvg_name: str = ""
    tvg_logo: str = ""


def parse_m3u(content: str) -> list[Channel]:
    """Parse M3U/M3U8 playlist text into a list of Channel objects."""
    channels: list[Channel] = []
    lines = [line.strip() for line in content.splitlines() if line.strip()]

    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXTINF:"):
            attrs = dict(EXTINF_ATTR_RE.findall(line))
            # Channel name is after the last comma
            name = line.rsplit(",", 1)[-1].strip() if "," in line else "Unknown"
            # Find the next non-comment line as the stream URL
            j = i + 1
            while j < len(lines) and lines[j].startswith("#"):
                j += 1
            if j < len(lines):
                channels.append(
                    Channel(
                        name=name,
                        url=lines[j],
                        group=attrs.get("group-title", ""),
                        tvg_id=attrs.get("tvg-id", ""),
                        tvg_name=attrs.get("tvg-name", ""),
                        tvg_logo=attrs.get("tvg-logo", ""),
                    )
                )
                i = j + 1
                continue
        i += 1

    return channels


def load_playlist(source: str, timeout: int = 15) -> list[Channel]:
    """Load and parse an M3U playlist from a preset name, URL, or local file."""
    target = PLAYLIST_PRESETS.get(source.lower(), source)
    if target.startswith(("http://", "https://")):
        req = urllib.request.Request(
            target,
            headers={"User-Agent": "Mozilla/5.0 (IPTV-Download-Machine)"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content = resp.read().decode("utf-8", errors="replace")
    else:
        content = Path(target).read_text(encoding="utf-8", errors="replace")
    return parse_m3u(content)


def filter_channels(
    channels: Iterable[Channel],
    query: str = "",
    group: str = "",
) -> list[Channel]:
    """Filter channels by case-insensitive substring match on name or group."""
    q = query.lower().strip()
    g = group.lower().strip()
    results = []
    for ch in channels:
        if q and q not in ch.name.lower():
            continue
        if g and g not in ch.group.lower():
            continue
        results.append(ch)
    return results


def check_stream(channel: Channel, timeout: int = 5) -> tuple[Channel, bool, str]:
    """Check if a stream URL responds with an HTTP 2xx/3xx status."""
    req = urllib.request.Request(
        channel.url,
        method="HEAD",
        headers={"User-Agent": "Mozilla/5.0 (IPTV-Download-Machine)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return channel, 200 <= resp.status < 400, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        # Some servers reject HEAD; try a ranged GET
        if e.code in (403, 405):
            try:
                get_req = urllib.request.Request(
                    channel.url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (IPTV-Download-Machine)",
                        "Range": "bytes=0-1024",
                    },
                )
                with urllib.request.urlopen(get_req, timeout=timeout) as resp:
                    return channel, 200 <= resp.status < 400, f"HTTP {resp.status}"
            except Exception as inner_e:
                return channel, False, str(inner_e)
        return channel, False, f"HTTP {e.code}"
    except Exception as e:
        return channel, False, str(e)


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^\w\-. ]+", "_", name).strip()
    return cleaned or "stream"


def download_stream(
    url: str,
    output: str,
    duration: int | None = None,
    retries: int = 2,
) -> int:
    """Record/download a stream using ffmpeg."""
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        print(
            "Error: ffmpeg is not installed or not on PATH. "
            "Install ffmpeg to download/record streams.",
            file=sys.stderr,
        )
        return 1

    cmd = [
        ffmpeg_bin,
        "-y",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-i",
        url,
    ]
    if duration is not None and duration > 0:
        cmd.extend(["-t", str(duration)])
    cmd.extend(["-c", "copy", output])

    for attempt in range(1, retries + 1):
        print(f"[Attempt {attempt}/{retries}] Running: {' '.join(cmd)}")
        proc = subprocess.run(cmd)
        if proc.returncode == 0:
            print(f"Saved stream to {output}")
            return 0
    return 1


def cmd_fetch(args: argparse.Namespace) -> int:
    channels = load_playlist(args.source)
    print(f"Loaded {len(channels)} channels from {args.source}")
    if args.out:
        out_path = Path(args.out)
        out_path.write_text(
            json.dumps([asdict(c) for c in channels], indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"Saved parsed playlist to {out_path}")
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    channels = load_playlist(args.source)
    matches = filter_channels(channels, query=args.query, group=args.group)
    print(f"Found {len(matches)} matching channel(s):")
    for idx, ch in enumerate(matches[: args.limit], start=1):
        grp = f"[{ch.group}] " if ch.group else ""
        print(f"{idx:3d}. {grp}{ch.name} -> {ch.url}")
    if len(matches) > args.limit:
        print(f"... and {len(matches) - args.limit} more (use --limit to see more)")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    channels = load_playlist(args.source)
    matches = filter_channels(channels, query=args.query, group=args.group)[: args.limit]
    print(f"Checking {len(matches)} stream(s) with {args.workers} workers...")
    live: list[Channel] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(check_stream, ch, args.timeout) for ch in matches]
        for fut in concurrent.futures.as_completed(futures):
            ch, ok, detail = fut.result()
            status = "LIVE" if ok else "DEAD"
            print(f"[{status}] {ch.name} ({detail})")
            if ok:
                live.append(ch)
    print(f"Summary: {len(live)}/{len(matches)} streams live.")
    return 0


def cmd_groups(args: argparse.Namespace) -> int:
    channels = load_playlist(args.source)
    counts: dict[str, int] = {}
    for ch in channels:
        grp = ch.group or "(Uncategorized)"
        counts[grp] = counts.get(grp, 0) + 1
    print(f"Found {len(counts)} group(s) across {len(channels)} entries:")
    for grp, count in sorted(counts.items(), key=lambda x: (-x[1], x[0].lower())):
        print(f"  {count:4d}  {grp}")
    return 0


def cmd_pick(args: argparse.Namespace) -> int:
    channels = load_playlist(args.source)
    matches = filter_channels(channels, query=args.query, group=args.group)
    if not matches:
        print("No matching channels/titles found.", file=sys.stderr)
        return 1

    shown = matches[: args.limit]
    print(f"Found {len(matches)} matching item(s) (showing {len(shown)}):")
    for idx, ch in enumerate(shown, start=1):
        grp = f"[{ch.group}] " if ch.group else ""
        print(f"{idx:3d}. {grp}{ch.name}")

    try:
        raw = input(f"\nEnter number (1-{len(shown)}) to download, or 'q' to quit: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return 0

    if not raw or raw.lower() == "q":
        return 0

    try:
        choice = int(raw)
    except ValueError:
        print("Invalid selection.", file=sys.stderr)
        return 1

    if not 1 <= choice <= len(shown):
        print("Selection out of range.", file=sys.stderr)
        return 1

    ch = shown[choice - 1]
    out_name = args.output or f"{sanitize_filename(ch.name)}.mp4"
    print(f"Downloading: {ch.name} -> {out_name}")
    return download_stream(ch.url, out_name, duration=args.duration, retries=args.retries)


def cmd_download(args: argparse.Namespace) -> int:
    if args.url:
        url = args.url
        name = args.output or "stream.mp4"
    else:
        channels = load_playlist(args.source)
        matches = filter_channels(channels, query=args.query, group=args.group)
        if not matches:
            print("No matching channels found.", file=sys.stderr)
            return 1
        ch = matches[0]
        url = ch.url
        name = args.output or f"{sanitize_filename(ch.name)}.mp4"
        print(f"Selected channel: {ch.name} ({ch.url})")

    return download_stream(url, name, duration=args.duration, retries=args.retries)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="iptv-dl",
        description="IPTV Download Machine — fetch, search, check, and record M3U streams.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_fetch = sub.add_parser("fetch", help="Fetch and parse an M3U playlist")
    p_fetch.add_argument("source", nargs="?", default="tv", help="Preset (tv, xxx, all), URL, or file")
    p_fetch.add_argument("-o", "--out", help="Optional JSON output path")
    p_fetch.set_defaults(func=cmd_fetch)

    p_search = sub.add_parser("search", help="Search channels in a playlist")
    p_search.add_argument("source", nargs="?", default="tv", help="Preset (tv, xxx, all), URL, or file")
    p_search.add_argument("-q", "--query", default="", help="Channel name filter")
    p_search.add_argument("-g", "--group", default="", help="Group title filter")
    p_search.add_argument("-n", "--limit", type=int, default=25, help="Max results to display")
    p_search.set_defaults(func=cmd_search)

    p_check = sub.add_parser("check", help="Check which streams are live")
    p_check.add_argument("source", nargs="?", default="tv", help="Preset (tv, xxx, all), URL, or file")
    p_check.add_argument("-q", "--query", default="", help="Channel name filter")
    p_check.add_argument("-g", "--group", default="", help="Group title filter")
    p_check.add_argument("-n", "--limit", type=int, default=20, help="Max streams to check")
    p_check.add_argument("-w", "--workers", type=int, default=8, help="Concurrent workers")
    p_check.add_argument("-t", "--timeout", type=int, default=5, help="Per-stream timeout (s)")
    p_check.set_defaults(func=cmd_check)

    p_groups = sub.add_parser("groups", help="List all categories/groups in a playlist")
    p_groups.add_argument("source", nargs="?", default="all", help="Preset (tv, xxx, all), URL, or file")
    p_groups.set_defaults(func=cmd_groups)

    p_pick = sub.add_parser("pick", help="Interactively search and pick a movie/series/anime/channel to download")
    p_pick.add_argument("source", nargs="?", default="all", help="Preset (tv, xxx, all), URL, or file")
    p_pick.add_argument("-q", "--query", default="", help="Title/channel name filter")
    p_pick.add_argument("-g", "--group", default="", help="Group/category filter (e.g. Anime, Peliculas, Series)")
    p_pick.add_argument("-n", "--limit", type=int, default=30, help="Max results to display")
    p_pick.add_argument("-o", "--output", help="Output file path (optional)")
    p_pick.add_argument("-d", "--duration", type=int, help="Optional duration limit in seconds (omit for full VOD)")
    p_pick.add_argument("-r", "--retries", type=int, default=2, help="Retry count on failure")
    p_pick.set_defaults(func=cmd_pick)

    p_dl = sub.add_parser("download", help="Download/record a stream using ffmpeg")
    p_dl.add_argument("source", nargs="?", default="tv", help="Preset (tv, xxx, all), URL, or file")
    p_dl.add_argument("-q", "--query", default="", help="Channel name to match")
    p_dl.add_argument("-g", "--group", default="", help="Group title filter")
    p_dl.add_argument("--url", help="Direct stream URL (overrides playlist search)")
    p_dl.add_argument("-o", "--output", help="Output file path (e.g. recording.mp4)")
    p_dl.add_argument("-d", "--duration", type=int, help="Recording duration in seconds")
    p_dl.add_argument("-r", "--retries", type=int, default=2, help="Retry count on failure")
    p_dl.set_defaults(func=cmd_download)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
