import unittest

from iptv_dl import Channel, filter_channels, parse_m3u, sanitize_filename

SAMPLE_M3U = """#EXTM3U
#EXTINF:-1 tvg-id="ch1" tvg-name="News One" tvg-logo="https://example.com/1.png" group-title="News",News One HD
https://stream.example.com/news1.m3u8
#EXTINF:-1 tvg-id="ch2" group-title="Sports",Sports Central
#EXTVLCOPT:http-user-agent=Mozilla/5.0
https://stream.example.com/sports.m3u8
"""


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


if __name__ == "__main__":
    unittest.main()
