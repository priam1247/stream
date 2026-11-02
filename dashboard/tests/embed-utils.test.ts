// @vitest-environment node
import { expect, it } from 'vitest';
import {
  EMBED_IFRAME_DEFAULTS,
  EMBED_LOAD_GIVE_UP_MS,
  buildEmbedUrl,
  getAspectRatio,
  isEmbedUrl,
  isSubsequence,
  scoreCommandQuery,
} from '../lib/embed-utils';

const command = {
  name: 'mfind',
  aliases: ['findmusic', 'msearch'],
  summary: 'Keyless music search',
  usage: '.mfind <name|link> [--audio|--video]',
};

it('parses aspect ratios and falls back to 16:9', () => {
  expect(getAspectRatio('16:9')).toBe('aspect-ratio: 16 / 9;');
  expect(getAspectRatio('4:3')).toBe('aspect-ratio: 4 / 3;');
  expect(getAspectRatio('nonsense')).toBe('aspect-ratio: 16 / 9;');
  expect(getAspectRatio('0:0')).toBe('aspect-ratio: 16 / 9;');
});

it('builds public embed URLs for the recognised providers', () => {
  expect(buildEmbedUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'))
    .toBe('https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT');
  expect(buildEmbedUrl('https://www.deezer.com/album/302127'))
    .toBe('https://widget.deezer.com/widget/auto/album/302127');
  expect(buildEmbedUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'))
    .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  expect(buildEmbedUrl('https://vimeo.com/246846978'))
    .toBe('https://player.vimeo.com/video/246846978');
  expect(buildEmbedUrl('https://soundcloud.com/artist/track'))
    .toBe('https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack&visual=true');
  expect(buildEmbedUrl('http://example.com/x')).toBeNull();
  expect(buildEmbedUrl('not a url')).toBeNull();
});

it('recognises player URLs and keeps lazy iframe defaults', () => {
  expect(isEmbedUrl('https://open.spotify.com/embed/track/abc')).toBe(true);
  expect(isEmbedUrl('https://widget.deezer.com/widget/auto/track/1')).toBe(true);
  expect(isEmbedUrl('https://open.spotify.com/track/abc')).toBe(false);
  expect(EMBED_IFRAME_DEFAULTS.loading).toBe('lazy');
  expect(EMBED_IFRAME_DEFAULTS.width).toBe('100%');
  expect(EMBED_LOAD_GIVE_UP_MS).toBe(8000);
});

it('ranks command search results and tolerates abbreviations', () => {
  expect(scoreCommandQuery('mfind', command)).toBeGreaterThan(
    scoreCommandQuery('music', command),
  );
  expect(scoreCommandQuery('findmusic', command)).toBeGreaterThan(0);
  expect(scoreCommandQuery('mfind music', command)).toBeGreaterThan(0);
  expect(scoreCommandQuery('mfind nonsense', command)).toBe(0);
  expect(scoreCommandQuery('mfn', command)).toBeGreaterThan(0); // subsequence
  expect(isSubsequence('ytb', 'youtube')).toBe(true);
  expect(isSubsequence('zyb', 'youtube')).toBe(false);
  expect(scoreCommandQuery('', command)).toBe(1);
});
