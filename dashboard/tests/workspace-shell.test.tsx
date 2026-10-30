import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { Home, Library } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceShell, type WorkspaceNavGroup } from '../components/workspace-shell';
import type { AuthUser } from '../lib/types';

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

type Page = 'home' | 'library';
const user: AuthUser = { id: 2, name: 'Maya Member', email: 'maya@example.test', username: 'maya', isAdmin: false, isVerified: true, memberAllowed: true };
const groups: WorkspaceNavGroup<Page>[] = [{ label: 'My space', items: [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'library', label: 'Library', icon: Library },
] }];

function Harness({ onAccount = () => {} }: { onAccount?: () => void }) {
  const [page, setPage] = useState<Page>('home');
  return <WorkspaceShell kind="member" user={user} groups={groups} current={page} onNavigate={setPage} mobileItems={['home']} mobileMore refreshing={false} onRefresh={() => {}} onAccount={onAccount} onSignOut={() => {}}><h1>{page === 'home' ? 'Personal home' : 'Library page'}</h1></WorkspaceShell>;
}

afterEach(() => { cleanup(); document.body.style.overflow = ''; vi.restoreAllMocks(); });

describe('responsive workspace navigation', () => {
  it('opens a labelled drawer, traps focus, and restores focus and scrolling on Escape', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open workspace menu' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Member workspace menu' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
    const close = within(dialog).getByRole('button', { name: 'Close workspace menu' });
    const signOut = within(dialog).getByRole('button', { name: 'Sign out' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(signOut);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Member workspace menu' })).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
  });

  it('navigates from the drawer, closes it and updates both navigation states', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'More workspace pages' }));
    const menu = screen.getByRole('navigation', { name: 'Member menu' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Library' }));
    expect(screen.queryByRole('dialog', { name: 'Member workspace menu' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Library page' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Console sections' })).getByRole('button', { name: 'Library' }).getAttribute('aria-current')).toBe('page');
    const more = screen.getByRole('button', { name: 'More workspace pages' });
    expect(more.getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(more);
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on backdrop click and restores focus to the opening control', () => {
    render(<Harness />);
    const more = screen.getByRole('button', { name: 'More workspace pages' });
    fireEvent.click(more);
    const dialog = screen.getByRole('dialog', { name: 'Member workspace menu' });
    const backdrop = dialog.parentElement?.querySelector<HTMLButtonElement>('button[aria-hidden="true"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(screen.queryByRole('dialog', { name: 'Member workspace menu' })).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('does not pull focus back to the menu trigger when opening account settings', () => {
    const onAccount = vi.fn();
    render(<Harness onAccount={onAccount} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace menu' }));
    const dialog = screen.getByRole('dialog', { name: 'Member workspace menu' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open account settings' }));
    expect(onAccount).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Member workspace menu' })).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Open workspace menu' }));
  });
});
