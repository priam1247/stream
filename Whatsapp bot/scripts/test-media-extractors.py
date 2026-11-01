#!/usr/bin/env python3
"""Offline recognition tests against an installed yt-dlp, not live downloads.

Run: python3 scripts/test-media-extractors.py
The URLs are syntactic fixtures, not promises that the videos exist or are public.
"""
import sys
import unittest

try:
    import yt_dlp
    from yt_dlp.extractor import gen_extractor_classes
except ImportError:
    sys.exit("Install yt-dlp to run extractor recognition tests (no sites are contacted).")

CASES = (
    ('YouTube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Youtube'),
    ('Reddit', 'https://www.reddit.com/r/test/comments/abc123/example/', 'Reddit'),
    ('TikTok', 'https://www.tiktok.com/@creator/video/123456789', 'TikTok'),
    ('Instagram', 'https://www.instagram.com/reel/Example/', 'Instagram'),
    ('Facebook', 'https://www.facebook.com/watch/?v=123456789', 'Facebook'),
    ('Twitter', 'https://x.com/creator/status/123456789', 'Twitter'),
)



class MediaExtractors(unittest.TestCase):
    def test_provider_url_patterns(self):
        extractors = {c.ie_key(): c for c in gen_extractor_classes()}
        print(f'yt-dlp {yt_dlp.version.__version__}; testing extractor URL recognition only')
        for name, url, extractor in CASES:
            with self.subTest(provider=name):
                self.assertIn(extractor, extractors)
                self.assertTrue(extractors[extractor].suitable(url), f'{name}: {extractor} does not recognize the fixture')


if __name__ == '__main__':
    unittest.main(verbosity=2)
