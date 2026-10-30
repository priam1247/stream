import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupportDesk } from '../components/support-desk';

const reply = (body: unknown): Response => ({ ok: true, json: async () => body } as Response);
const threads = [
  { email: 'first@example.com', preview: 'First', latestAt: 1, unread: 1 },
  { email: 'second@example.com', preview: 'Second', latestAt: 2, unread: 1 },
];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('private report conversations', () => {
  it('ignores a slow response for a previously selected member', async () => {
    let finishFirst!: (response: Response) => void;
    const slow = new Promise<Response>((resolve) => { finishFirst = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('first%40example.com')) return slow;
      if (url.includes('second%40example.com')) return Promise.resolve(reply({ threads, unread: 1, messages: [{ id: 2, role: 'member', text: 'Second private message', createdAt: 1 }] }));
      return Promise.resolve(reply({ threads, unread: 2 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onUnread = vi.fn();
    render(<SupportDesk admin onUnreadChange={onUnread} />);
    fireEvent.click(await screen.findByRole('button', { name: /first@example.com/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('first%40example.com'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'All reports' }));
    fireEvent.click(await screen.findByRole('button', { name: /second@example.com/ }));
    expect(await screen.findByText('Second private message')).toBeTruthy();
    await act(async () => finishFirst(reply({ threads, unread: 9, messages: [{ id: 1, role: 'member', text: 'First private message', createdAt: 1 }] })));
    expect(screen.queryByText('First private message')).toBeNull();
    expect(screen.getByText('Second private message')).toBeTruthy();
    expect(onUnread).not.toHaveBeenCalledWith(9);
  });
});
