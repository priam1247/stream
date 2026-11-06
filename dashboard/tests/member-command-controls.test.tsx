import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemberCommandControls } from '../components/member-command-controls';
import { BOT_COMMANDS, MEMBER_COMMANDS } from '../lib/bot-data';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows site shortcuts, searches aliases, and toggles the canonical member command', async () => {
  let disabled: string[] = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      disabled = body.disabled ? [body.name] : [];
    }
    return { ok: true, json: async () => ({ disabled, sync: 'synced' }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemberCommandControls />);
  expect(await screen.findByText('Service synced')).toBeTruthy();
  expect(screen.getByText(/owner and configured bot admins keep access/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'media' }));
  expect(screen.getByRole('switch', { name: 'Allow .tiktok for members' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search member commands' }), { target: { value: 'tt' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Allow .tiktok for members' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Allow .tiktok for members' }).getAttribute('aria-checked')).toBe('false'));
  const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ name: 'tiktok', disabled: true });
});

it('matches the live service command set and drops the retired commands', () => {
  expect(BOT_COMMANDS).toHaveLength(31);
  const video = BOT_COMMANDS.find((item) => item.name === 'video');
  expect(video?.aliases).toContain('ytmp4');
  expect(MEMBER_COMMANDS.find((item) => item.name === 'video')?.usage).toBe(video?.usage);
  const drama = MEMBER_COMMANDS.find((item) => item.name === 'dramabox');
  expect(drama?.aliases).toEqual(['drama', 'dramastream']);
  expect(MEMBER_COMMANDS.map((item) => item.name)).toContain('dramabox');
  for (const name of ['ytv', 'dl', 'spotify', 'x', 'reddit', 'audius', 'deezer', 'bilibili', 'vimeo',
    'dailymotion', 'xiaohongshu', 'acfun', 'twitch', 'rumble', 'niconico', 'commons', 'broadcast', 'weibo',
    'pinterest', 'pintrest', 'douyin', 'odysee', 'vk', 'youku']) {
    expect(BOT_COMMANDS.some((item) => item.name === name || item.aliases.includes(name))).toBe(false);
    expect(MEMBER_COMMANDS.some((item) => item.name === name || item.aliases.includes(name))).toBe(false);
  }
  // Only members' commands are switchable; owner-only commands stay with the owner.
  expect(MEMBER_COMMANDS.some((item) => item.ownerOnly)).toBe(false);
});
