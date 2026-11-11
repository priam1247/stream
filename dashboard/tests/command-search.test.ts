// @vitest-environment node
import { expect, it } from 'vitest';
import { isSubsequence, scoreCommandQuery } from '../lib/command-search';

const command = {
  name: 'mfind',
  aliases: ['findmusic', 'msearch'],
  summary: 'Keyless music search',
  usage: '.mfind <name|link> [--audio|--video]',
};

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
