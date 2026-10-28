import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemberPortal } from '../components/member-portal';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../components/scribd-desk', () => ({
  ScribdDesk: () => <div>Scribd desk</div>,
}));

function reply(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('hides bot analytics on the Scribd tab but keeps it on other tabs', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/auth/me') {
      return reply({ user: { id: 1, name: 'Member', email: 'member@example.com', isAdmin: false } });
    }
    return reply({
      ok: true,
      adminEmail: 'admin@example.com',
      memberAllowed: true,
      botEnabledForMembers: true,
      botServerLinked: false,
      botConnected: false,
      botNumber: null,
      numbers: [],
    });
  }));

  render(<MemberPortal />);
  const nav = await screen.findByRole('navigation', { name: 'Console sections' });
  expect(screen.getByRole('region', { name: 'Live Server Analytics' })).toBeTruthy();
  fireEvent.click(within(nav).getByRole('button', { name: 'Scribd' }));
  expect(screen.queryByRole('region', { name: 'Live Server Analytics' })).toBeNull();
  expect(screen.getByText('Scribd desk')).toBeTruthy();
  fireEvent.click(within(nav).getByRole('button', { name: 'Numbers (0)' }));
  expect(screen.getByRole('region', { name: 'Live Server Analytics' })).toBeTruthy();
});
