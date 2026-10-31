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
  expect(screen.getByText(/Site shortcuts do not block \.dl/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'media' }));
  expect(screen.getByRole('switch', { name: 'Allow .bilibili for members' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search member commands' }), { target: { value: 'bili' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Allow .bilibili for members' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Allow .bilibili for members' }).getAttribute('aria-checked')).toBe('false'));
  const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ name: 'bilibili', disabled: true });
});

it('documents title or link search for all 14 site shortcuts', () => {
  const sites = ['bilibili', 'vimeo', 'dailymotion', 'reddit', 'twitch', 'rumble', 'odysee', 'weibo', 'douyin', 'acfun', 'youku', 'vk', 'xiaohongshu', 'niconico'];
  for (const name of sites) {
    const command = BOT_COMMANDS.find((item) => item.name === name);
    const member = MEMBER_COMMANDS.find((item) => item.name === name);
    expect(command?.usage).toContain('<title or url>');
    expect(member?.usage).toBe(command?.usage);
  }
  expect(BOT_COMMANDS.find((item) => item.name === 'youku')?.example).toBe('.youku the blood of youth s01e1');
});
