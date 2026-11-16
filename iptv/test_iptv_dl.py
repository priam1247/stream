import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from iptv_dl import (
    PLAYLIST_PRESETS,
    Channel,
    _build_ffmpeg_input_args,
    _default_output_name,
    _parse_hls_master,
    filter_channels,
    parse_m3u,
    parse_streams_json,
    probe_hls_stream,
    sanitize_filename,
)

SAMPLE_M3U = """#EXTM3U
#EXTINF:-1 tvg-id="ch1" tvg-name="News One" tvg-logo="https://example.com/1.png" group-title="News",News One HD
https://stream.example.com/news1.m3u8
#EXTINF:-1 tvg-id="ch2" group-title="Sports",Sports Central
#EXTVLCOPT:http-user-agent=Mozilla/5.0
https://stream.example.com/sports.m3u8
"""

HEADER_M3U = """#EXTM3U
#EXTINF:-1 tvg-id="ch3" group-title="Movies" http-user-agent="CustomAgent/1.0" http-referrer="https://site.example.com/page",Movies Feed
https://stream.example.com/movies.m3u8
#EXTINF:-1 tvg-id="ch4" group-title="Kids",Kids Feed
#EXTVLCOPT:http-user-agent=VLC/3.0.20
#EXTVLCOPT:http-referrer=https://kids.example.com/
#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=Mozilla%2F5.0%20Test&Referer=https%3A%2F%2Fkodipro.example.com%2F
https://stream.example.com/kids.m3u8
"""

QUOTED_TITLE_M3U = """#EXTM3U
#EXTINF:-1 tvg-name="CNN, US" group-title="News",CNN / US: HD
https://stream.example.com/cnn.m3u8
"""

STREAMS_JSON = json.dumps(
    [
        {
            "channel": "Naruto.us",
            "feed": "US",
            "title": "Naruto (1080p)",
            "url": "https://d21vn5eki5qsdi.cloudfront.net/playlist.m3u8",
            "quality": "1080p",
            "labels": ["Geo-blocked"],
        },
        {
            "channel": "Naruto.us",
            "feed": "US",
            "title": "Naruto (1080p)",
            "url": "https://pluto.example.com/naruto.m3u8",
            "quality": "720p",
            "referrer": "https://pluto.tv/",
            "user_agent": "Mozilla/5.0 Pluto",
        },
    ]
)


class TestIptvDl(unittest.TestCase):
    def test_parse_m3u(self):
        channels = parse_m3u(SAMPLE_M3U)
        self.assertEqual(len(channels), 2)
        self.assertEqual(channels[0].name, "News One HD")
        self.assertEqual(channels[0].group, "News")
        self.assertEqual(channels[0].tvg_id, "ch1")
        self.assertEqual(channels[0].url, "https://stream.example.com/news1.m3u8")
        self.assertEqual(channels[1].name, "Sports Central")
        self.assertEqual(channels[1].url, "https://stream.example.com/sports.m3u8")
        self.assertEqual(channels[1].user_agent, "Mozilla/5.0")

    def test_parse_m3u_extinf_header_attributes(self):
        channels = parse_m3u(HEADER_M3U)
        self.assertEqual(len(channels), 2)
        self.assertEqual(channels[0].user_agent, "CustomAgent/1.0")
        self.assertEqual(channels[0].referrer, "https://site.example.com/page")

    def test_parse_m3u_kodiprop_and_vlcopt_headers(self):
        channels = parse_m3u(HEADER_M3U)
        kids = channels[1]
        # KODIPROP headers are decoded and override earlier VLC options
        self.assertEqual(kids.user_agent, "Mozilla/5.0 Test")
        self.assertEqual(kids.referrer, "https://kodipro.example.com/")

    def test_parse_m3u_title_with_comma_inside_quotes(self):
        channels = parse_m3u(QUOTED_TITLE_M3U)
        self.assertEqual(len(channels), 1)
        self.assertEqual(channels[0].name, "CNN / US: HD")
        self.assertEqual(channels[0].tvg_name, "CNN, US")

    def test_parse_streams_json_keeps_all_mirrors(self):
        channels = parse_streams_json(STREAMS_JSON)
        self.assertEqual(len(channels), 2)
        self.assertEqual(channels[0].url, "https://d21vn5eki5qsdi.cloudfront.net/playlist.m3u8")
        self.assertIn("Geo-blocked", channels[0].name)
        self.assertEqual(channels[1].referrer, "https://pluto.tv/")
        self.assertEqual(channels[1].user_agent, "Mozilla/5.0 Pluto")
        self.assertEqual(channels[0].tvg_id, "Naruto.us@US")

    def test_filter_channels(self):
        channels = [
            Channel(name="News One HD", url="u1", group="News"),
            Channel(name="Sports Central", url="u2", group="Sports"),
        ]
        self.assertEqual(len(filter_channels(channels, query="news")), 1)
        self.assertEqual(len(filter_channels(channels, group="sports")), 1)
        self.assertEqual(len(filter_channels(channels, query="missing")), 0)

    def test_sanitize_filename(self):
        self.assertEqual(sanitize_filename("CNN / US: HD!"), "CNN _ US_ HD_")
        self.assertEqual(sanitize_filename("Naruto (1080p) [Geo-blocked]"), "Naruto _1080p_ _Geo-blocked_")
        self.assertEqual(sanitize_filename(""), "stream")

    def test_default_output_name_strips_geo_labels(self):
        ch = Channel(name="Naruto (1080p) [Geo-blocked]", url="x")
        self.assertEqual(_default_output_name(ch), "Naruto _1080p_.mp4")
        self.assertEqual(
            _default_output_name(Channel(name="CNN / US: HD!", url="x")),
            "CNN _ US_ HD_.mp4",
        )

    def test_presets_cover_free_playlist_sources(self):
        for key in (
            "tv",
            "all",
            "iptv-org",
            "iptv-org-all",
            "iptv-org-es",
            "free-tv",
            "m3u-cl",
            "m3u-cl-top",
        ):
            self.assertIn(key, PLAYLIST_PRESETS)
            self.assertTrue(PLAYLIST_PRESETS[key].startswith("https://"))

    def test_ffmpeg_headers_are_crlf_terminated(self):
        args = _build_ffmpeg_input_args(
            "https://example.com/live.m3u8",
            user_agent="Agent/1.0",
            referrer="https://ref.example.com/",
            origin="https://ref.example.com",
        )
        self.assertEqual(args[args.index("-user_agent") + 1], "Agent/1.0")
        headers = args[args.index("-headers") + 1]
        self.assertTrue(headers.endswith("\r\n"))
        self.assertIn("Referer: https://ref.example.com/\r\n", headers)
        self.assertEqual(args[-1], "https://example.com/live.m3u8")

    def test_parse_hls_master_prefers_highest_and_caps_height(self):
        master = """#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"
720/index.m3u8
"""
        url, audio = _parse_hls_master(master, "https://cdn.example.com/live/master.m3u8")
        self.assertEqual(url, "https://cdn.example.com/live/1080/index.m3u8")
        self.assertEqual(audio, "https://cdn.example.com/live/audio/en.m3u8")

        url, _ = _parse_hls_master(
            master, "https://cdn.example.com/live/master.m3u8", max_height=720
        )
        self.assertEqual(url, "https://cdn.example.com/live/720/index.m3u8")


class _HlsHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # silence test output
        pass

    def _send(self, body: bytes, status: int = 200, ctype: str = "application/vnd.apple.mpegurl"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        routes = {
            "/master.m3u8": (
                b"#EXTM3U\n"
                b'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio.m3u8"\n'
                b'#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"\n'
                b"1080.m3u8\n"
                b'#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"\n'
                b"720.m3u8\n"
            ),
            "/1080.m3u8": b"#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.m3u8\n",
            "/720.m3u8": b"#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.m3u8\n",
            "/audio.m3u8": b"#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.m3u8\n",
            "/blocked.m3u8": b"#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nblocked.ts\n",
        }
        if self.path in ("/seg.m3u8", "/blocked.ts"):
            if self.path == "/blocked.ts":
                self._send(b"forbidden", status=403, ctype="text/plain")
            else:
                self._send(b"\x47" * 188, ctype="video/mp2t")
            return
        body = routes.get(self.path)
        if body is None:
            self._send(b"missing", status=404, ctype="text/plain")
            return
        self._send(body)

    def do_HEAD(self):
        self.do_GET()


class TestHlsProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _HlsHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def test_probe_resolves_variant_and_flags_live_stream(self):
        result = probe_hls_stream(f"{self.base}/master.m3u8", timeout=5)
        self.assertTrue(result.ok, result.detail)
        self.assertEqual(result.video_url, f"{self.base}/1080.m3u8")
        self.assertEqual(result.audio_url, f"{self.base}/audio.m3u8")
        self.assertTrue(result.is_live)  # no #EXT-X-ENDLIST
        self.assertEqual(result.status_code, 200)

    def test_probe_honors_max_height(self):
        result = probe_hls_stream(f"{self.base}/master.m3u8", timeout=5, max_height=720)
        self.assertTrue(result.ok, result.detail)
        self.assertEqual(result.video_url, f"{self.base}/720.m3u8")

    def test_probe_fails_fast_when_segments_are_forbidden(self):
        result = probe_hls_stream(f"{self.base}/blocked.m3u8", timeout=5)
        self.assertFalse(result.ok)
        self.assertEqual(result.status_code, 403)
        self.assertIn("403", result.detail)


if __name__ == "__main__":
    unittest.main()
