#!/usr/bin/env python3
"""Offline recognition tests against an installed yt-dlp, not live downloads.

Run: python3 scripts/test-media-extractors.py
The URLs are syntactic fixtures, not promises that the videos exist or are public.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import yt_dlp
    from yt_dlp.extractor import gen_extractor_classes
except ImportError:
    sys.exit("Install yt-dlp to run extractor recognition tests (no sites are contacted).")

CASES = (
    ('Bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD', 'BiliBili'),
    ('Bilibili international', 'https://www.bilibili.tv/en/video/1234567890123', 'BiliIntl'),
    ('Vimeo', 'https://vimeo.com/76979871', 'Vimeo'),
    ('Dailymotion', 'https://www.dailymotion.com/video/x7xyz', 'Dailymotion'),
    ('Reddit', 'https://www.reddit.com/r/test/comments/abc123/example/', 'Reddit'),
    ('Twitch VOD', 'https://www.twitch.tv/videos/123456789', 'TwitchVod'),
    ('Rumble', 'https://rumble.com/v1xyz-example.html', 'Rumble'),
    ('Odysee', 'https://odysee.com/@example:1/title:2', 'LBRY'),
    ('Weibo', 'https://www.weibo.com/1234567890/ABCxyz123', 'Weibo'),
    ('Douyin', 'https://www.douyin.com/video/1234567890123456789', 'Douyin'),
    ('AcFun', 'https://www.acfun.cn/v/ac12345678', 'AcFunVideo'),
    ('Youku', 'https://v.youku.com/v_show/id_XNTk2Mzc2OT.html', 'Youku'),
    ('VK', 'https://vk.com/video-123456_789012', 'VK'),
    ('Xiaohongshu', 'https://www.xiaohongshu.com/explore/123456789012345678901234', 'XiaoHongShu'),
    ('Niconico', 'https://www.nicovideo.jp/watch/sm9', 'Niconico'),
)


class MediaExtractors(unittest.TestCase):
    def test_provider_url_patterns(self):
        extractors = {c.ie_key(): c for c in gen_extractor_classes()}
        print(f'yt-dlp {yt_dlp.version.__version__}; testing extractor URL recognition only')
        for name, url, extractor in CASES:
            with self.subTest(provider=name):
                self.assertIn(extractor, extractors)
                self.assertTrue(extractors[extractor].suitable(url), f'{name}: {extractor} does not recognize the fixture')

    def test_niconico_search_url_pattern(self):
        extractors = {c.ie_key(): c for c in gen_extractor_classes()}
        self.assertIn('NicovideoSearch', extractors)
        self.assertTrue(extractors['NicovideoSearch'].suitable('nicosearch5:猫 & a video'))

    def test_search_print_template_with_real_ytdlp(self):
        # This is a local synthetic playlist, not a network or download test.
        fixture = {
            '_type': 'playlist', 'id': 'fixture', 'title': 'Fixture',
            'extractor': 'fixture', 'extractor_key': 'Fixture',
            'webpage_url': 'https://example.com/playlist',
            'entries': [
                {'id': 'sm9', 'title': 'First\tname\nline', 'duration': 63, 'uploader': 'Creator',
                 'extractor': 'fixture', 'extractor_key': 'Fixture',
                 'webpage_url': 'https://www.nicovideo.jp/watch/sm9',
                 'url': 'https://example.com/one.mp4', 'ext': 'mp4'},
                {'id': 'sm10', 'title': 'Second', 'duration': 90,
                 'extractor': 'fixture', 'extractor_key': 'Fixture',
                 'webpage_url': 'https://www.nicovideo.jp/watch/sm10',
                 'url': 'https://example.com/two.mp4', 'ext': 'mp4'},
            ],
        }
        template = '%(webpage_url)j\t%(url)j\t%(id)j\t%(title)j\t%(duration)j\t%(uploader)j'
        with tempfile.TemporaryDirectory() as folder:
            info = Path(folder, 'playlist.json')
            info.write_text(json.dumps(fixture), encoding='utf-8')
            result = subprocess.run(
                [sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-clean-infojson',
                 '--no-flat-playlist', '--skip-download', '--ignore-errors', '--playlist-end', '2',
                 '--print', template, '--load-info-json', str(info)],
                check=True, capture_output=True, text=True, timeout=30,
            )
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 2)
        fields = lines[0].split('\t')
        self.assertEqual(len(fields), 6)
        self.assertEqual(json.loads(fields[0]), 'https://www.nicovideo.jp/watch/sm9')
        self.assertEqual(json.loads(fields[3]), 'First\tname\nline')
        self.assertEqual(json.loads(fields[4]), 63)
        self.assertEqual(lines[1].split('\t')[-1], 'NA')


if __name__ == '__main__':
    unittest.main(verbosity=2)
