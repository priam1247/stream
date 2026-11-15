#!/usr/bin/env python3
"""
IPTV Download Machine — parse, search, health-check, and record/download
streams from M3U/JSON playlists (including dzh0ni/iPTV-FREE-LIST, iptv-org,
Free-TV, and m3u.cl).
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
VLC_USER_AGENT = "VLC/3.0.20 LibVLC/3.0.20"

PLAYLIST_PRESETS = {
    "tv": "https://raw.githubusercontent.com/dzh0ni/iPTV-FREE-LIST/master/iPTV-Free-List_TV.m3u",
    "xxx": "https://raw.githubusercontent.com/dzh0ni/iPTV-FREE-LIST/master/iPTV-Free-List_XXX.m3u",
    "all": "https://raw.githubusercontent.com/dzh0ni/iPTV-FREE-LIST/master/iPTV-Free-List.m3u",
    "popeye": "https://raw.githubusercontent.com/dzh0ni/iPTV-FREE-LIST/master/Maratones/Maratones_Popeye_El_Marino.m3u",
    "iptv-org": "https://iptv-org.github.io/iptv/index.m3u",
    "iptv-org-all": "https://iptv-org.github.io/api/streams.json",
    "iptv-org-es": "https://iptv-org.github.io/iptv/languages/spa.m3u",
    "free-tv": "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8",
    "m3u-cl": "https://m3u.cl/lista/total.m3u",
    "m3u-cl-top": "https://m3u.cl/lista/top.m3u",
}

EXTINF_ATTR_RE = re.compile(r'([\w-]+)="([^"]*)"')
RESOLUTION_RE = re.compile(r"RESOLUTION=\d+x(\d+)", re.IGNORECASE)
BANDWIDTH_RE = re.compile(r"(?:^|,)BANDWIDTH=(\d+)", re.IGNORECASE)
AUDIO_GROUP_RE = re.compile(r'(?:^|,)AUDIO="([^"]+)"', re.IGNORECASE)
GROUP_ID_RE = re.compile(r'(?:^|,)GROUP-ID="([^"]+)"', re.IGNORECASE)
URI_ATTR_RE = re.compile(r'URI="([^"]+)"', re.IGNORECASE)
WEB_STREAM_HOST_RE = re.compile(
    r"(?:^|\.)(?:youtube\.com|youtu\.be|twitch\.tv)$", re.IGNORECASE
)


@dataclass
class Channel:
    name: str
    url: str
    group: str = ""
    tvg_id: str = ""
    tvg_name: str = ""
    tvg_logo: str = ""
    user_agent: str = ""
    referrer: str = ""


@dataclass
class HlsProbeResult:
    ok: bool
    video_url: str
    audio_url: str = ""
    user_agent: str = DEFAULT_USER_AGENT
    referrer: str = ""
    origin: str = ""
    is_live: bool = False
    status_code: int = 0
    detail: str = ""


def _extract_extinf_name(line: str) -> str:
    """Extract channel display name after the first unquoted comma in #EXTINF."""
    in_quotes = False
    start = len("#EXTINF:") if line.startswith("#EXTINF:") else 0
    for idx in range(start, len(line)):
        ch = line[idx]
        if ch == '"':
            in_quotes = not in_quotes
        elif ch == "," and not in_quotes:
            name = line[idx + 1 :].strip()
            return name or "Unknown"
    return "Unknown"


def _parse_kodiprop_headers(value: str) -> tuple[str, str]:
    """Extract User-Agent and Referer from KODIPROP stream_headers string."""
    ua = ""
    ref = ""
    for pair in value.split("&"):
        if "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        key = urllib.parse.unquote(k).strip().lower()
        val = urllib.parse.unquote(v).strip()
        if key == "user-agent":
            ua = val
        elif key in ("referer", "referrer"):
            ref = val
    return ua, ref


def parse_m3u(content: str) -> list[Channel]:
    """Parse M3U/M3U8 playlist text into a list of Channel objects."""
    channels: list[Channel] = []
    lines = [line.strip() for line in content.splitlines() if line.strip()]

    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXTINF:"):
            raw_attrs = EXTINF_ATTR_RE.findall(line)
            attrs = {k.lower(): v for k, v in raw_attrs}
            name = _extract_extinf_name(line)
            user_agent = attrs.get("http-user-agent") or attrs.get("user-agent", "")
            referrer = (
                attrs.get("http-referrer")
                or attrs.get("http-referer")
                or attrs.get("referrer")
                or attrs.get("referer", "")
            )

            j = i + 1
            while j < len(lines) and lines[j].startswith("#"):
                directive = lines[j]
                if directive.startswith("#EXTINF:"):
                    break
                lower_dir = directive.lower()
                if lower_dir.startswith("#extvlcopt:"):
                    opt = directive.split(":", 1)[1]
                    if "=" in opt:
                        opt_k, opt_v = opt.split("=", 1)
                        opt_k = opt_k.strip().lower()
                        opt_v = opt_v.strip()
                        if opt_k == "http-user-agent":
                            user_agent = opt_v
                        elif opt_k in ("http-referrer", "http-referer"):
                            referrer = opt_v
                elif lower_dir.startswith("#kodiprop:"):
                    prop = directive.split(":", 1)[1]
                    if "=" in prop:
                        prop_k, prop_v = prop.split("=", 1)
                        if prop_k.strip().lower().endswith("stream_headers"):
                            kp_ua, kp_ref = _parse_kodiprop_headers(prop_v.strip())
                            if kp_ua:
                                user_agent = kp_ua
                            if kp_ref:
                                referrer = kp_ref
                j += 1

            if j < len(lines) and not lines[j].startswith("#"):
                channels.append(
                    Channel(
                        name=name,
                        url=lines[j],
                        group=attrs.get("group-title", ""),
                        tvg_id=attrs.get("tvg-id", ""),
                        tvg_name=attrs.get("tvg-name", ""),
                        tvg_logo=attrs.get("tvg-logo", ""),
                        user_agent=user_agent,
                        referrer=referrer,
                    )
                )
                i = j + 1
                continue
        i += 1

    return channels


def parse_streams_json(content: str) -> list[Channel]:
    """Parse iptv-org's api/streams.json format (includes all alternate mirrors)."""
    items = json.loads(content)
    if not isinstance(items, list):
        return []
    channels: list[Channel] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        url = (item.get("url") or "").strip()
        if not url:
            continue
        title = (item.get("title") or item.get("channel") or "Unknown").strip()
        channel_id = (item.get("channel") or "").strip()
        feed = (item.get("feed") or "").strip()
        quality = (item.get("quality") or "").strip()
        labels = item.get("labels") or []

        suffix_parts: list[str] = []
        if feed:
            suffix_parts.append(feed)
        elif channel_id and "." in channel_id:
            suffix_parts.append(channel_id.rsplit(".", 1)[-1].upper())
        if quality:
            suffix_parts.append(quality)

        display_name = title
        if suffix_parts:
            display_name += f" ({', '.join(suffix_parts)})"
        if labels and isinstance(labels, list):
            display_name += f" [{'; '.join(str(lbl) for lbl in labels)}]"

        group = ""
        if channel_id and "." in channel_id:
            group = channel_id.rsplit(".", 1)[-1].upper()

        tvg_id = f"{channel_id}@{feed}" if channel_id and feed else channel_id
        channels.append(
            Channel(
                name=display_name,
                url=url,
                group=group,
                tvg_id=tvg_id,
                tvg_name=title,
                user_agent=(item.get("user_agent") or "").strip(),
                referrer=(item.get("referrer") or "").strip(),
            )
        )
    return channels


def _build_opener(proxy: str | None = None) -> urllib.request.OpenerDirector:
    if proxy:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        )
    return urllib.request.build_opener()


def load_playlist(
    source: str,
    timeout: int = 20,
    proxy: str | None = None,
) -> list[Channel]:
    """Load and parse an M3U or JSON playlist from a preset, URL, or local file."""
    target = PLAYLIST_PRESETS.get(source.lower(), source)
    if target.startswith(("http://", "https://")):
        opener = _build_opener(proxy)
        req = urllib.request.Request(
            target,
            headers={"User-Agent": DEFAULT_USER_AGENT, "Accept": "*/*"},
        )
        with opener.open(req, timeout=timeout) as resp:
            content = resp.read().decode("utf-8", errors="replace")
    else:
        content = Path(target).read_text(encoding="utf-8", errors="replace")

    stripped = content.lstrip()
    if stripped.startswith("[") or target.lower().endswith(".json"):
        return parse_streams_json(content)
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


def _origin_from_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return ""


def _parse_hls_master(
    playlist_text: str,
    base_url: str,
    max_height: int | None = None,
) -> tuple[str, str]:
    """Pick the best (or height-capped) variant and optional separate audio URI."""
    lines = [ln.strip() for ln in playlist_text.splitlines() if ln.strip()]
    variants: list[tuple[int, int, str, str]] = []
    audio_renditions: list[tuple[str, bool, str]] = []

    i = 0
    while i < len(lines):
        line = lines[i]
        if line.upper().startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in line.upper():
            grp_m = GROUP_ID_RE.search(line)
            uri_m = URI_ATTR_RE.search(line)
            if grp_m and uri_m:
                is_default = "DEFAULT=YES" in line.upper()
                audio_renditions.append(
                    (
                        grp_m.group(1),
                        is_default,
                        urllib.parse.urljoin(base_url, uri_m.group(1)),
                    )
                )
        elif line.upper().startswith("#EXT-X-STREAM-INF:"):
            h_m = RESOLUTION_RE.search(line)
            bw_m = BANDWIDTH_RE.search(line)
            ag_m = AUDIO_GROUP_RE.search(line)
            height = int(h_m.group(1)) if h_m else 0
            bandwidth = int(bw_m.group(1)) if bw_m else 0
            audio_group = ag_m.group(1) if ag_m else ""
            j = i + 1
            while j < len(lines) and lines[j].startswith("#"):
                j += 1
            if j < len(lines):
                variant_url = urllib.parse.urljoin(base_url, lines[j])
                variants.append((height, bandwidth, variant_url, audio_group))
                i = j + 1
                continue
        i += 1

    if not variants:
        return base_url, ""

    variants.sort(key=lambda v: (v[0], v[1]), reverse=True)
    chosen = variants[0]
    if max_height and max_height > 0:
        capped = [v for v in variants if v[0] and v[0] <= max_height + 60]
        chosen = capped[0] if capped else variants[-1]

    _, _, video_url, audio_group = chosen
    audio_url = ""
    if audio_group:
        matching_audio = [a for a in audio_renditions if a[0] == audio_group]
        if matching_audio:
            matching_audio.sort(key=lambda a: a[1], reverse=True)
            audio_url = matching_audio[0][2]

    return video_url, audio_url


def _first_media_segment_url(playlist_text: str, base_url: str) -> str:
    """Return the first initialization map or media segment URL in a media playlist."""
    for raw in playlist_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.upper().startswith("#EXT-X-MAP:"):
            uri_m = URI_ATTR_RE.search(line)
            if uri_m:
                return urllib.parse.urljoin(base_url, uri_m.group(1))
        if not line.startswith("#"):
            return urllib.parse.urljoin(base_url, line)
    return ""


def _probe_hls_once(
    url: str,
    opener: urllib.request.OpenerDirector,
    user_agent: str,
    referrer: str,
    origin: str,
    timeout: int,
    max_height: int | None,
) -> HlsProbeResult:
    headers: dict[str, str] = {"User-Agent": user_agent, "Accept": "*/*"}
    if referrer:
        headers["Referer"] = referrer
    if origin:
        headers["Origin"] = origin

    try:
        req = urllib.request.Request(url, headers=headers)
        with opener.open(req, timeout=timeout) as resp:
            status = resp.status
            final_url = resp.geturl() or url
            ctype = (resp.headers.get("Content-Type") or "").lower()
            # Peek a small head first so direct media streams (MPEG-TS/MP4)
            # are not drained for half a megabyte before we can decide.
            sample = resp.read(4096)
            head = sample.decode("utf-8", errors="ignore").lstrip()
            if head.startswith("#EXTM3U") or "mpegurl" in ctype:
                sample += resp.read(524288)
    except urllib.error.HTTPError as e:
        return HlsProbeResult(
            ok=False,
            video_url=url,
            user_agent=user_agent,
            referrer=referrer,
            origin=origin,
            status_code=e.code,
            detail=f"HTTP {e.code}",
        )
    except Exception as e:
        return HlsProbeResult(
            ok=False,
            video_url=url,
            user_agent=user_agent,
            referrer=referrer,
            origin=origin,
            detail=str(e),
        )

    text_head = sample[:4096].decode("utf-8", errors="ignore").lstrip()
    is_m3u = text_head.startswith("#EXTM3U") or "mpegurl" in ctype
    if not is_m3u:
        # Direct media stream (MP4, MPEG-TS, audio stream)
        return HlsProbeResult(
            ok=200 <= status < 400,
            video_url=final_url,
            user_agent=user_agent,
            referrer=referrer,
            origin=origin,
            status_code=status,
            detail=f"HTTP {status}",
        )

    playlist_text = sample.decode("utf-8", errors="replace")
    audio_url = ""
    media_url = final_url

    if "#EXT-X-STREAM-INF" in playlist_text.upper():
        media_url, audio_url = _parse_hls_master(
            playlist_text, final_url, max_height=max_height
        )
        try:
            v_req = urllib.request.Request(media_url, headers=headers)
            with opener.open(v_req, timeout=timeout) as v_resp:
                media_url = v_resp.geturl() or media_url
                playlist_text = v_resp.read(524288).decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            return HlsProbeResult(
                ok=False,
                video_url=media_url,
                audio_url=audio_url,
                user_agent=user_agent,
                referrer=referrer,
                origin=origin,
                status_code=e.code,
                detail=f"HTTP {e.code} on variant playlist",
            )
        except Exception as e:
            return HlsProbeResult(
                ok=False,
                video_url=media_url,
                audio_url=audio_url,
                user_agent=user_agent,
                referrer=referrer,
                origin=origin,
                detail=f"Variant playlist error: {e}",
            )

    is_live = "#EXT-X-ENDLIST" not in playlist_text.upper()
    seg_url = _first_media_segment_url(playlist_text, media_url)
    if not seg_url:
        return HlsProbeResult(
            ok=False,
            video_url=media_url,
            audio_url=audio_url,
            user_agent=user_agent,
            referrer=referrer,
            origin=origin,
            is_live=is_live,
            detail="HLS playlist contains no media segments",
        )

    seg_headers = {**headers, "Range": "bytes=0-1024"}
    try:
        s_req = urllib.request.Request(seg_url, headers=seg_headers)
        with opener.open(s_req, timeout=timeout) as s_resp:
            s_status = s_resp.status
            s_resp.read(64)
            return HlsProbeResult(
                ok=200 <= s_status < 400,
                video_url=media_url,
                audio_url=audio_url,
                user_agent=user_agent,
                referrer=referrer,
                origin=origin,
                is_live=is_live,
                status_code=s_status,
                detail=f"HTTP {s_status}",
            )
    except urllib.error.HTTPError as e:
        # Some servers reject Range requests with 416/400; retry plain GET briefly
        if e.code in (400, 416):
            try:
                plain_req = urllib.request.Request(seg_url, headers=headers)
                with opener.open(plain_req, timeout=timeout) as p_resp:
                    p_status = p_resp.status
                    p_resp.read(64)
                    return HlsProbeResult(
                        ok=200 <= p_status < 400,
                        video_url=media_url,
                        audio_url=audio_url,
                        user_agent=user_agent,
                        referrer=referrer,
                        origin=origin,
                        is_live=is_live,
                        status_code=p_status,
                        detail=f"HTTP {p_status}",
                    )
            except urllib.error.HTTPError as e2:
                e = e2
            except Exception as inner_e:
                return HlsProbeResult(
                    ok=False,
                    video_url=media_url,
                    user_agent=user_agent,
                    referrer=referrer,
                    origin=origin,
                    is_live=is_live,
                    detail=str(inner_e),
                )

        hint = (
            f"HTTP {e.code} Forbidden on media segments "
            "(stream is likely geo-blocked in your region or token-restricted)"
            if e.code == 403
            else f"HTTP {e.code} on media segment"
        )
        return HlsProbeResult(
            ok=False,
            video_url=media_url,
            audio_url=audio_url,
            user_agent=user_agent,
            referrer=referrer,
            origin=origin,
            is_live=is_live,
            status_code=e.code,
            detail=hint,
        )
    except Exception as e:
        return HlsProbeResult(
            ok=False,
            video_url=media_url,
            audio_url=audio_url,
            user_agent=user_agent,
            referrer=referrer,
            origin=origin,
            is_live=is_live,
            detail=f"Segment error: {e}",
        )


def probe_hls_stream(
    url: str,
    user_agent: str = "",
    referrer: str = "",
    proxy: str | None = None,
    timeout: int = 8,
    max_height: int | None = None,
) -> HlsProbeResult:
    """
    Resolve an HLS stream (master -> variant -> first segment) and verify that
    media segments actually open (detecting 403 geo-blocks before ffmpeg loops).
    Automatically retries with Origin/Referer and VLC User-Agent on 401/403.
    """
    opener = _build_opener(proxy)
    ua = user_agent or DEFAULT_USER_AGENT
    ref = referrer or ""
    inferred_origin = _origin_from_url(ref) if ref else ""

    profiles: list[tuple[str, str, str]] = [(ua, ref, inferred_origin)]
    stream_origin = _origin_from_url(url)
    if not ref and stream_origin:
        profiles.append((ua, f"{stream_origin}/", stream_origin))
    if ua != VLC_USER_AGENT:
        profiles.append((VLC_USER_AGENT, ref, inferred_origin))

    last_result: HlsProbeResult | None = None
    for prof_ua, prof_ref, prof_origin in profiles:
        res = _probe_hls_once(
            url,
            opener=opener,
            user_agent=prof_ua,
            referrer=prof_ref,
            origin=prof_origin,
            timeout=timeout,
            max_height=max_height,
        )
        if res.ok:
            return res
        last_result = res
        if res.status_code not in (401, 403):
            break

    assert last_result is not None
    return last_result


def check_stream(
    channel: Channel,
    timeout: int = 6,
    proxy: str | None = None,
) -> tuple[Channel, bool, str]:
    """Check if a stream URL (including HLS media segments) is playable."""
    parsed = urllib.parse.urlsplit(channel.url)
    ua = channel.user_agent or DEFAULT_USER_AGENT
    path_lower = parsed.path.lower()

    if ".m3u8" in path_lower or ".m3u" in path_lower:
        probe = probe_hls_stream(
            channel.url,
            user_agent=ua,
            referrer=channel.referrer,
            proxy=proxy,
            timeout=timeout,
        )
        return channel, probe.ok, probe.detail

    opener = _build_opener(proxy)
    headers = {"User-Agent": ua}
    if channel.referrer:
        headers["Referer"] = channel.referrer

    req = urllib.request.Request(channel.url, method="HEAD", headers=headers)
    try:
        with opener.open(req, timeout=timeout) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            if "mpegurl" in ctype:
                probe = probe_hls_stream(
                    channel.url,
                    user_agent=ua,
                    referrer=channel.referrer,
                    proxy=proxy,
                    timeout=timeout,
                )
                return channel, probe.ok, probe.detail
            return channel, 200 <= resp.status < 400, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        if e.code in (403, 405):
            try:
                get_req = urllib.request.Request(
                    channel.url,
                    headers={**headers, "Range": "bytes=0-1024"},
                )
                with opener.open(get_req, timeout=timeout) as resp:
                    return channel, 200 <= resp.status < 400, f"HTTP {resp.status}"
            except Exception as inner_e:
                return channel, False, str(inner_e)
        return channel, False, f"HTTP {e.code}"
    except Exception as e:
        return channel, False, str(e)


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^\w\-. ]+", "_", name).strip()
    return cleaned or "stream"


def _default_output_name(channel: Channel) -> str:
    """Build a clean .mp4 filename, dropping iptv-org label suffixes like [Geo-blocked]."""
    name = re.sub(r"\s*\[[^\]]*\]\s*$", "", channel.name).strip() or channel.name
    return f"{sanitize_filename(name)}.mp4"


def _is_web_platform_url(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return bool(WEB_STREAM_HOST_RE.search(host))


def _download_with_ytdlp(
    url: str,
    output: str,
    duration: int | None = None,
    proxy: str | None = None,
) -> int:
    ytdlp_bin = shutil.which("yt-dlp")
    if not ytdlp_bin:
        print(
            f"Error: '{url}' is a YouTube/Twitch page URL and requires yt-dlp on PATH.",
            file=sys.stderr,
        )
        return 1
    cmd = [ytdlp_bin, "--no-part", "-o", output]
    if proxy:
        cmd.extend(["--proxy", proxy])
    if duration is not None and duration > 0:
        cmd.extend(["--download-sections", f"*0-{duration}"])
    cmd.append(url)
    print(f"Running: {shlex.join(cmd)}")
    return subprocess.run(cmd).returncode


def _build_ffmpeg_input_args(
    input_url: str,
    user_agent: str,
    referrer: str = "",
    origin: str = "",
    proxy: str | None = None,
) -> list[str]:
    args: list[str] = []
    if user_agent:
        args.extend(["-user_agent", user_agent])
    extra_headers: list[str] = []
    if referrer:
        extra_headers.append(f"Referer: {referrer}")
    if origin:
        extra_headers.append(f"Origin: {origin}")
    if extra_headers:
        args.extend(["-headers", "\r\n".join(extra_headers) + "\r\n"])
    if proxy:
        args.extend(["-http_proxy", proxy])
    args.extend(
        [
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "5",
            "-i",
            input_url,
        ]
    )
    return args


def _run_ffmpeg_monitored(cmd: list[str], output: str) -> tuple[int, bool]:
    """
    Run ffmpeg while relaying stderr live and aborting if media segments
    repeatedly fail (e.g. HTTP 403 Forbidden loop with zero media written).
    Returns (returncode, permanent_403_failure).
    """
    proc = subprocess.Popen(cmd, stderr=subprocess.PIPE)
    assert proc.stderr is not None

    buffer = ""
    consecutive_seg_errors = 0
    saw_403 = False
    wrote_media = False
    aborted_loop = False

    def _inspect_line(line: str) -> bool:
        nonlocal consecutive_seg_errors, saw_403, wrote_media
        lower = line.lower()
        if "size=" in lower and "time=" in lower and "time=00:00:00" not in lower:
            wrote_media = True
            consecutive_seg_errors = 0
            return False
        if "http error 403" in lower or "403 forbidden" in lower:
            saw_403 = True
        if (
            "failed to open segment" in lower
            or "failed too many times, skipping" in lower
            or "http error 403" in lower
        ):
            consecutive_seg_errors += 1
            if not wrote_media and consecutive_seg_errors >= 6:
                return True
        return False

    try:
        fd = proc.stderr.fileno()
        while True:
            chunk = os.read(fd, 1024)
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            sys.stderr.write(text)
            sys.stderr.flush()
            buffer += text
            parts = re.split(r"[\r\n]+", buffer)
            buffer = parts[-1]
            for ln in parts[:-1]:
                if _inspect_line(ln):
                    aborted_loop = True
                    break
            if aborted_loop:
                break
    except KeyboardInterrupt:
        proc.terminate()
        proc.wait()
        return 130, False

    if aborted_loop:
        proc.kill()
        proc.wait()
        try:
            if os.path.exists(output) and os.path.getsize(output) == 0:
                os.remove(output)
        except OSError:
            pass
        print(
            "\nAborted ffmpeg: media segments failed repeatedly "
            "(HTTP 403 Forbidden / geo-blocked or dead stream).",
            file=sys.stderr,
        )
        return 1, saw_403

    rc = proc.wait()
    return rc, (rc != 0 and saw_403 and not wrote_media)


def download_stream(
    url: str,
    output: str,
    duration: int | None = None,
    retries: int = 2,
    user_agent: str = "",
    referrer: str = "",
    proxy: str | None = None,
    max_height: int | None = None,
    preflight: bool = True,
) -> int:
    """Record/download a stream using ffmpeg (with HLS preflight & header support)."""
    if _is_web_platform_url(url):
        return _download_with_ytdlp(url, output, duration=duration, proxy=proxy)

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        print(
            "Error: ffmpeg is not installed or not on PATH. "
            "Install ffmpeg to download/record streams.",
            file=sys.stderr,
        )
        return 1

    ua = user_agent or DEFAULT_USER_AGENT
    ref = referrer or ""
    origin = _origin_from_url(ref) if ref else ""
    video_url = url
    audio_url = ""

    if preflight:
        probe = probe_hls_stream(
            url,
            user_agent=ua,
            referrer=ref,
            proxy=proxy,
            max_height=max_height,
        )
        if not probe.ok:
            print(
                f"Stream preflight failed: {probe.detail}\n"
                "Tip: If this channel is geo-blocked (HTTP 403), try another mirror "
                "(e.g. 'iptv-org-all' preset) or pass --proxy http://host:port.",
                file=sys.stderr,
            )
            return 1
        video_url = probe.video_url
        audio_url = probe.audio_url
        ua = probe.user_agent
        ref = probe.referrer
        origin = probe.origin
        if probe.is_live and not duration:
            print(
                "Note: Live 24/7 TV stream detected — press 'q' to stop recording "
                "cleanly and save, or pass -d <seconds> to record a fixed clip."
            )

    cmd = [ffmpeg_bin, "-y"]
    cmd.extend(
        _build_ffmpeg_input_args(
            video_url, user_agent=ua, referrer=ref, origin=origin, proxy=proxy
        )
    )
    if audio_url:
        cmd.extend(
            _build_ffmpeg_input_args(
                audio_url, user_agent=ua, referrer=ref, origin=origin, proxy=proxy
            )
        )
        cmd.extend(["-map", "0:v:0", "-map", "1:a:0"])
    if duration is not None and duration > 0:
        cmd.extend(["-t", str(duration)])
    # -sn avoids MP4 mux failures when HLS master playlists expose WebVTT subtitles
    cmd.extend(["-sn", "-c", "copy", output])

    for attempt in range(1, retries + 1):
        print(f"[Attempt {attempt}/{retries}] Running: {shlex.join(cmd)}")
        rc, permanent_403 = _run_ffmpeg_monitored(cmd, output)
        if rc == 0:
            print(f"Saved stream to {output}")
            return 0
        if rc == 130 or permanent_403:
            break
    return 1


def _filter_live_channels(
    channels: list[Channel],
    workers: int = 8,
    timeout: int = 6,
    proxy: str | None = None,
) -> list[Channel]:
    if not channels:
        return []
    print(f"Checking {len(channels)} matching stream(s) for playability...")
    live_by_idx: dict[int, Channel] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        fut_to_idx = {
            pool.submit(check_stream, ch, timeout, proxy): idx
            for idx, ch in enumerate(channels)
        }
        for fut in concurrent.futures.as_completed(fut_to_idx):
            idx = fut_to_idx[fut]
            ch, ok, detail = fut.result()
            status = "LIVE" if ok else "SKIP"
            print(f"  [{status}] {ch.name} ({detail})")
            if ok:
                live_by_idx[idx] = ch
    return [live_by_idx[i] for i in sorted(live_by_idx)]


def cmd_fetch(args: argparse.Namespace) -> int:
    channels = load_playlist(args.source, proxy=getattr(args, "proxy", None))
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
    channels = load_playlist(args.source, proxy=getattr(args, "proxy", None))
    matches = filter_channels(channels, query=args.query, group=args.group)
    print(f"Found {len(matches)} matching channel(s):")
    for idx, ch in enumerate(matches[: args.limit], start=1):
        grp = f"[{ch.group}] " if ch.group else ""
        print(f"{idx:3d}. {grp}{ch.name} -> {ch.url}")
    if len(matches) > args.limit:
        print(f"... and {len(matches) - args.limit} more (use --limit to see more)")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    proxy = getattr(args, "proxy", None)
    channels = load_playlist(args.source, proxy=proxy)
    matches = filter_channels(channels, query=args.query, group=args.group)[: args.limit]
    print(f"Checking {len(matches)} stream(s) with {args.workers} workers...")
    live: list[Channel] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(check_stream, ch, args.timeout, proxy) for ch in matches]
        for fut in concurrent.futures.as_completed(futures):
            ch, ok, detail = fut.result()
            status = "LIVE" if ok else "DEAD"
            print(f"[{status}] {ch.name} ({detail})")
            if ok:
                live.append(ch)
    print(f"Summary: {len(live)}/{len(matches)} streams live.")
    return 0


def cmd_groups(args: argparse.Namespace) -> int:
    channels = load_playlist(args.source, proxy=getattr(args, "proxy", None))
    counts: dict[str, int] = {}
    for ch in channels:
        grp = ch.group or "(Uncategorized)"
        counts[grp] = counts.get(grp, 0) + 1
    print(f"Found {len(counts)} group(s) across {len(channels)} entries:")
    for grp, count in sorted(counts.items(), key=lambda x: (-x[1], x[0].lower())):
        print(f"  {count:4d}  {grp}")
    return 0


def cmd_pick(args: argparse.Namespace) -> int:
    proxy = getattr(args, "proxy", None)
    channels = load_playlist(args.source, proxy=proxy)
    matches = filter_channels(channels, query=args.query, group=args.group)
    if not matches:
        print("No matching channels/titles found.", file=sys.stderr)
        return 1

    shown = matches[: args.limit]
    if getattr(args, "check", False):
        shown = _filter_live_channels(shown, proxy=proxy)
        if not shown:
            print("None of the matching streams are playable from your network.", file=sys.stderr)
            return 1

    print(f"Found {len(matches)} matching item(s) (showing {len(shown)}):")
    for idx, ch in enumerate(shown, start=1):
        grp = f"[{ch.group}] " if ch.group else ""
        print(f"{idx:3d}. {grp}{ch.name}")

    try:
        raw = input(
            "\nEnter number (e.g. 1, 1-5, or 'all') to download, or 'q' to quit: "
        ).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return 0

    if not raw or raw.lower() == "q":
        return 0

    selected_indices: list[int] = []
    if raw.lower() == "all":
        selected_indices = list(range(len(shown)))
    else:
        for part in raw.split(","):
            part = part.strip()
            if "-" in part:
                try:
                    start_s, end_s = part.split("-", 1)
                    start, end = int(start_s), int(end_s)
                    if not (1 <= start <= end <= len(shown)):
                        raise ValueError
                    selected_indices.extend(range(start - 1, end))
                except ValueError:
                    print(f"Invalid range: {part}", file=sys.stderr)
                    return 1
            else:
                try:
                    idx = int(part)
                    if not 1 <= idx <= len(shown):
                        raise ValueError
                    selected_indices.append(idx - 1)
                except ValueError:
                    print(f"Invalid selection: {part}", file=sys.stderr)
                    return 1

    rc = 0
    for idx in selected_indices:
        ch = shown[idx]
        out_name = (
            args.output
            if (args.output and len(selected_indices) == 1)
            else _default_output_name(ch)
        )
        print(f"Downloading: {ch.name} -> {out_name}")
        dl_rc = download_stream(
            ch.url,
            out_name,
            duration=args.duration,
            retries=args.retries,
            user_agent=getattr(args, "user_agent", "") or ch.user_agent,
            referrer=getattr(args, "referer", "") or ch.referrer,
            proxy=proxy,
            max_height=getattr(args, "max_height", None),
            preflight=not getattr(args, "no_preflight", False),
        )
        if dl_rc != 0:
            # Offer or run fallback across remaining shown items when a single selection fails
            remaining = [
                (i, shown[i]) for i in range(len(shown)) if i != idx
            ]
            if len(selected_indices) == 1 and remaining:
                try_fallback = getattr(args, "fallback", False)
                if not try_fallback:
                    try:
                        ans = input(
                            f"\n'{ch.name}' failed. Try the other {len(remaining)} "
                            "matching stream(s) automatically? [Y/n]: "
                        ).strip()
                        try_fallback = ans.lower() in ("", "y", "yes")
                    except (EOFError, KeyboardInterrupt):
                        try_fallback = False

                if try_fallback:
                    succeeded = False
                    for alt_i, alt_ch in remaining:
                        alt_out = (
                            args.output
                            or _default_output_name(alt_ch)
                        )
                        print(
                            f"\n[Fallback #{alt_i + 1}] Trying: {alt_ch.name} -> {alt_out}"
                        )
                        if (
                            download_stream(
                                alt_ch.url,
                                alt_out,
                                duration=args.duration,
                                retries=args.retries,
                                user_agent=getattr(args, "user_agent", "")
                                or alt_ch.user_agent,
                                referrer=getattr(args, "referer", "")
                                or alt_ch.referrer,
                                proxy=proxy,
                                max_height=getattr(args, "max_height", None),
                                preflight=not getattr(args, "no_preflight", False),
                            )
                            == 0
                        ):
                            succeeded = True
                            break
                    if succeeded:
                        continue
            rc = 1
    return rc


def cmd_download(args: argparse.Namespace) -> int:
    proxy = getattr(args, "proxy", None)
    user_agent = getattr(args, "user_agent", "")
    referer = getattr(args, "referer", "")
    max_height = getattr(args, "max_height", None)
    preflight = not getattr(args, "no_preflight", False)

    if args.url:
        name = args.output or "stream.mp4"
        return download_stream(
            args.url,
            name,
            duration=args.duration,
            retries=args.retries,
            user_agent=user_agent,
            referrer=referer,
            proxy=proxy,
            max_height=max_height,
            preflight=preflight,
        )

    channels = load_playlist(args.source, proxy=proxy)
    matches = filter_channels(channels, query=args.query, group=args.group)
    if not matches:
        print("No matching channels found.", file=sys.stderr)
        return 1

    max_candidates = max(1, getattr(args, "fallbacks", 5))
    candidates = matches[:max_candidates]
    for idx, ch in enumerate(candidates, start=1):
        name = args.output or _default_output_name(ch)
        prefix = f"[{idx}/{len(candidates)}] " if len(candidates) > 1 else ""
        print(f"{prefix}Selected channel: {ch.name} ({ch.url})")
        rc = download_stream(
            ch.url,
            name,
            duration=args.duration,
            retries=args.retries,
            user_agent=user_agent or ch.user_agent,
            referrer=referer or ch.referrer,
            proxy=proxy,
            max_height=max_height,
            preflight=preflight,
        )
        if rc == 0:
            return 0
        if idx < len(candidates):
            print("Trying next matching channel...", file=sys.stderr)

    return 1


def _add_network_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--proxy", help="HTTP/HTTPS proxy URL (e.g. http://127.0.0.1:8080)")


def _add_download_net_args(p: argparse.ArgumentParser) -> None:
    _add_network_args(p)
    p.add_argument("--user-agent", default="", help="Override HTTP User-Agent header")
    p.add_argument("--referer", default="", help="Override HTTP Referer header")
    p.add_argument(
        "--max-height",
        type=int,
        help="Max video height in pixels when selecting HLS variants (e.g. 720, 1080)",
    )
    p.add_argument(
        "--no-preflight",
        action="store_true",
        help="Skip HLS playlist/segment pre-check before launching ffmpeg",
    )


def build_parser() -> argparse.ArgumentParser:
    preset_list = ", ".join(PLAYLIST_PRESETS.keys())
    source_help = f"Preset ({preset_list}), URL, or local file"

    parser = argparse.ArgumentParser(
        prog="iptv-dl",
        description="IPTV Download Machine — fetch, search, check, and record M3U/HLS streams.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_fetch = sub.add_parser("fetch", help="Fetch and parse an M3U/JSON playlist")
    p_fetch.add_argument("source", nargs="?", default="tv", help=source_help)
    p_fetch.add_argument("-o", "--out", help="Optional JSON output path")
    _add_network_args(p_fetch)
    p_fetch.set_defaults(func=cmd_fetch)

    p_search = sub.add_parser("search", help="Search channels in a playlist")
    p_search.add_argument("source", nargs="?", default="tv", help=source_help)
    p_search.add_argument("-q", "--query", default="", help="Channel name filter")
    p_search.add_argument("-g", "--group", default="", help="Group title filter")
    p_search.add_argument("-n", "--limit", type=int, default=25, help="Max results to display")
    _add_network_args(p_search)
    p_search.set_defaults(func=cmd_search)

    p_check = sub.add_parser("check", help="Check which streams (and HLS segments) are live")
    p_check.add_argument("source", nargs="?", default="tv", help=source_help)
    p_check.add_argument("-q", "--query", default="", help="Channel name filter")
    p_check.add_argument("-g", "--group", default="", help="Group title filter")
    p_check.add_argument("-n", "--limit", type=int, default=20, help="Max streams to check")
    p_check.add_argument("-w", "--workers", type=int, default=8, help="Concurrent workers")
    p_check.add_argument("-t", "--timeout", type=int, default=6, help="Per-stream timeout (s)")
    _add_network_args(p_check)
    p_check.set_defaults(func=cmd_check)

    p_groups = sub.add_parser("groups", help="List all categories/groups in a playlist")
    p_groups.add_argument("source", nargs="?", default="all", help=source_help)
    _add_network_args(p_groups)
    p_groups.set_defaults(func=cmd_groups)

    p_pick = sub.add_parser(
        "pick",
        help="Interactively search and pick a channel/stream to download",
    )
    p_pick.add_argument("source", nargs="?", default="all", help=source_help)
    p_pick.add_argument("-q", "--query", default="", help="Title/channel name filter")
    p_pick.add_argument("-g", "--group", default="", help="Group/category filter")
    p_pick.add_argument("-n", "--limit", type=int, default=30, help="Max results to display")
    p_pick.add_argument(
        "-c",
        "--check",
        action="store_true",
        help="Pre-check matching streams and only list playable ones",
    )
    p_pick.add_argument(
        "--fallback",
        action="store_true",
        help="Automatically try other matching streams if the picked one fails",
    )
    p_pick.add_argument("-o", "--output", help="Output file path (optional)")
    p_pick.add_argument(
        "-d",
        "--duration",
        type=int,
        help="Optional duration limit in seconds (recommended for 24/7 live TV)",
    )
    p_pick.add_argument("-r", "--retries", type=int, default=2, help="Retry count on failure")
    _add_download_net_args(p_pick)
    p_pick.set_defaults(func=cmd_pick)

    p_dl = sub.add_parser("download", help="Download/record a stream using ffmpeg")
    p_dl.add_argument("source", nargs="?", default="tv", help=source_help)
    p_dl.add_argument("-q", "--query", default="", help="Channel name to match")
    p_dl.add_argument("-g", "--group", default="", help="Group title filter")
    p_dl.add_argument("--url", help="Direct stream URL (overrides playlist search)")
    p_dl.add_argument("-o", "--output", help="Output file path (e.g. recording.mp4)")
    p_dl.add_argument("-d", "--duration", type=int, help="Recording duration in seconds")
    p_dl.add_argument("-r", "--retries", type=int, default=2, help="Retry count on failure")
    p_dl.add_argument(
        "--fallbacks",
        type=int,
        default=5,
        help="Max matching channels to try when earlier mirrors fail (default: 5)",
    )
    _add_download_net_args(p_dl)
    p_dl.set_defaults(func=cmd_download)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
