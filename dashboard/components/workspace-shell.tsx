'use client';

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, LogOut, Menu, MoreHorizontal, RefreshCw, X, type LucideIcon } from 'lucide-react';
import { ZafarFox } from './zafar-fox';
import type { AuthUser } from '@/lib/types';

export interface WorkspaceNavItem<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  ariaLabel?: string;
  badge?: string | number;
  alert?: boolean;
}

export interface WorkspaceNavGroup<T extends string> {
  label: string;
  items: readonly WorkspaceNavItem<T>[];
}

interface WorkspaceShellProps<T extends string> {
  kind: 'owner' | 'member';
  user: AuthUser;
  groups: readonly WorkspaceNavGroup<T>[];
  current: T;
  onNavigate: (item: T) => void;
  mobileItems: readonly T[];
  mobileMore?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onAccount: () => void;
  onSignOut: () => void | Promise<void>;
  alternate?: { href: string; label: string; ariaLabel: string };
  children: ReactNode;
}

function Navigation<T extends string>({ groups, current, label, onChoose }: {
  groups: readonly WorkspaceNavGroup<T>[];
  current: T;
  label: string;
  onChoose: (item: T) => void;
}) {
  return (
    <nav aria-label={label} className="space-y-7 px-3">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-ink/40">{group.label}</p>
          <div className="space-y-1">
            {group.items.map(({ id, label: itemLabel, icon: Icon, ariaLabel, badge, alert }) => (
              <button
                key={id}
                type="button"
                aria-label={ariaLabel || itemLabel}
                aria-description={alert && typeof badge === 'number' ? `${badge} unread ${badge === 1 ? 'alert' : 'alerts'}` : undefined}
                aria-current={current === id ? 'page' : undefined}
                onClick={() => onChoose(id)}
                className={`group  flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[13px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  current === id
                    ? 'bg-ink/5 text-ink'
                    : 'text-ink/60 hover:bg-ink/5 hover:text-ink'
                }`}
              >
                <Icon aria-hidden="true" className={`h-[18px] w-[18px] shrink-0 ${current === id ? 'text-accent' : 'text-ink/40 group-hover:text-accent'}`} strokeWidth={1.8} />
                <span className="min-w-0 flex-1 truncate">{itemLabel}</span>
                {badge !== undefined && <span aria-hidden="true" className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${alert ? 'bg-accent/10 text-accent' : 'bg-ink/5 text-ink/60'}`}>{badge}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function Sidebar<T extends string>({ kind, user, groups, current, navLabel, onChoose, onAccount, onSignOut, onClose }: {
  kind: 'owner' | 'member';
  user: AuthUser;
  groups: readonly WorkspaceNavGroup<T>[];
  current: T;
  navLabel: string;
  onChoose: (item: T) => void;
  onAccount: () => void;
  onSignOut: () => void | Promise<void>;
  onClose?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <div className="flex min-h-[76px] items-center gap-3 border-b border-ink/5 px-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink text-paper"><ZafarFox compact /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold tracking-tight text-ink">{kind === 'owner' ? 'Control Room' : 'My Workspace'}</p>
          <p className="mt-0.5 truncate text-[11px] font-medium text-ink/60">{kind === 'owner' ? 'Owner workspace' : 'Personal workspace'}</p>
        </div>
        {onClose && <button type="button" onClick={onClose} aria-label="Close workspace menu" className=" flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink/60 hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><X aria-hidden="true" className="h-5 w-5" /></button>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-6">
        <Navigation groups={groups} current={current} label={navLabel} onChoose={onChoose} />
      </div>

      <div className="border-t border-ink/5 p-3">
        <div className=" flex items-center gap-1 rounded-2xl bg-ink/5 p-1.5">
          <button type="button" onClick={onAccount} aria-label="Open account settings" className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1.5 text-left hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-xs font-bold uppercase text-accent">{(user.name || user.email).slice(0, 2)}</span>
            <span className="min-w-0"><span className="block truncate text-xs font-bold text-ink/80">{user.name || 'Account'}</span><span className="block truncate text-[11px] text-ink/60">{kind === 'owner' ? 'Owner' : 'Member'}</span></span>
          </button>
          <button type="button" onClick={() => void onSignOut()} aria-label="Sign out" title="Sign out" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink/40 hover:bg-paper hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><LogOut aria-hidden="true" className="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  );
}

/** Separate role-specific workspaces share only navigation presentation, never permissions. */
export function WorkspaceShell<T extends string>({
  kind, user, groups, current, onNavigate, mobileItems, mobileMore = false,
  refreshing, onRefresh, onAccount, onSignOut, alternate, children,
}: WorkspaceShellProps<T>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const skipRestoreRef = useRef(false);
  const items = groups.flatMap((group) => group.items);
  const active = items.find((item) => item.id === current);
  const shortcuts = mobileItems.flatMap((id) => {
    const item = items.find((candidate) => candidate.id === id);
    return item ? [item] : [];
  });
  const desktopLabel = kind === 'owner' ? 'Owner sections' : 'Console sections';
  const mobileLabel = kind === 'owner' ? 'Owner shortcuts' : 'Member shortcuts';
  const moreIsCurrent = mobileMore && !mobileItems.includes(current);
  // Reports live in the drawer on mobile. Keep their unread state visible
  // without adding a sixth button (and a second row) to the bottom bar.
  const hiddenUnread = items.reduce((total, item) => total + (item.alert && !mobileItems.includes(item.id) && typeof item.badge === 'number' ? item.badge : 0), 0);
  const drawerId = `${kind}-workspace-menu`;

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = drawerRef.current?.querySelector<HTMLButtonElement>('button');
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuOpen(false);
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === firstItem || !drawerRef.current.contains(document.activeElement))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (document.activeElement === lastItem || !drawerRef.current.contains(document.activeElement))) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      const desktop = typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches;
      if (!skipRestoreRef.current && !desktop) returnFocusRef.current?.focus();
      skipRestoreRef.current = false;
    };
  }, [menuOpen]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => { if (media.matches) setMenuOpen(false); };
    media.addEventListener?.('change', closeOnDesktop);
    return () => media.removeEventListener?.('change', closeOnDesktop);
  }, []);

  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    returnFocusRef.current = event.currentTarget;
    setMenuOpen(true);
  };
  const chooseFromDrawer = (item: T) => {
    setMenuOpen(false);
    onNavigate(item);
  };
  const openAccountFromDrawer = () => {
    skipRestoreRef.current = true;
    setMenuOpen(false);
    onAccount();
  };
  const signOutFromDrawer = () => {
    skipRestoreRef.current = true;
    setMenuOpen(false);
    void onSignOut();
  };

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-paper text-ink">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-ink/10 lg:block">
        <Sidebar kind={kind} user={user} groups={groups} current={current} navLabel={desktopLabel} onChoose={onNavigate} onAccount={onAccount} onSignOut={onSignOut} />
      </aside>

      {menuOpen && (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <button type="button" aria-hidden="true" tabIndex={-1} onClick={() => setMenuOpen(false)} className="absolute inset-0 h-full w-full bg-ink/40 backdrop-blur-[2px]" />
          <aside ref={drawerRef} id={drawerId} role="dialog" aria-modal="true" aria-label={kind === 'owner' ? 'Owner workspace menu' : 'Member workspace menu'} className="relative h-full w-[min(288px,88vw)] overflow-hidden shadow-2xl">
            <Sidebar kind={kind} user={user} groups={groups} current={current} navLabel={kind === 'owner' ? 'Owner menu' : 'Member menu'} onChoose={chooseFromDrawer} onAccount={openAccountFromDrawer} onSignOut={signOutFromDrawer} onClose={() => setMenuOpen(false)} />
          </aside>
        </div>
      )}

      <div className="min-h-screen lg:pl-[248px]">
        <header className="sticky top-0 z-30 border-b border-ink/10 bg-paper/90 backdrop-blur-md">
          <div className="mx-auto flex min-h-[68px] max-w-[1440px] items-center justify-between gap-2 px-3.5 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
              <button type="button" aria-label="Open workspace menu" aria-description={hiddenUnread ? `${hiddenUnread} unread ${hiddenUnread === 1 ? 'item' : 'items'} in menu` : undefined} aria-expanded={menuOpen} aria-controls={drawerId} onClick={openMenu} className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-ink/10 bg-paper text-ink/80 hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:hidden"><Menu aria-hidden="true" className="h-[19px] w-[19px]" />{hiddenUnread > 0 && <span aria-hidden="true" className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-paper bg-accent px-0.5 text-[9px] font-bold leading-none text-paper tabular-nums">{hiddenUnread}</span>}</button>
              <div className="min-w-0">
                <p className="truncate text-[10px] font-bold uppercase tracking-[0.13em] text-ink/40">{kind === 'owner' ? 'Owner workspace' : 'My workspace'}</p>
                <p className="mt-0.5 truncate text-sm font-bold text-ink">{active?.label || 'Home'}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              {alternate && <Link href={alternate.href} aria-label={alternate.ariaLabel} title={alternate.ariaLabel} className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-ink/10 bg-paper px-2.5 text-xs font-semibold text-ink/60 hover:border-accent/25 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><span className="hidden sm:inline">{alternate.label}</span><ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>}
              <button type="button" onClick={onRefresh} disabled={refreshing} title="Refresh" aria-label="Refresh" className="flex h-10 w-10 items-center justify-center rounded-xl border border-ink/10 bg-paper text-ink/60 hover:text-accent disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><RefreshCw aria-hidden="true" className={`h-4 w-4 ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`} /></button>
              <button type="button" onClick={onAccount} aria-label="Open account" className="flex h-10 items-center gap-2 rounded-xl border border-ink/10 bg-paper p-1 pr-1.5 text-left hover:border-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:pr-3"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-[11px] font-bold uppercase text-accent">{(user.name || user.email).slice(0, 2)}</span><span className="hidden max-w-[110px] truncate text-xs font-semibold text-ink/80 sm:inline">{user.name || 'Account'}</span></button>
            </div>
          </div>
        </header>

        <main id="workspace-content" className="mx-auto max-w-[1440px] px-3.5 pb-28 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pb-12">
          {children}
        </main>
      </div>

      <nav aria-label={mobileLabel} className={`fixed inset-x-0 bottom-0 z-40 grid border-t border-ink/10 bg-paper/95 px-1 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(15,23,42,0.06)] backdrop-blur-md lg:hidden ${shortcuts.length + (mobileMore ? 1 : 0) === 5 ? 'grid-cols-5' : 'grid-cols-4'}`}>
        {shortcuts.map(({ id, label, icon: Icon, ariaLabel, alert, badge }) => (
          <button key={id} type="button" aria-label={ariaLabel || label} aria-description={alert && typeof badge === 'number' ? `${badge} unread ${badge === 1 ? 'alert' : 'alerts'}` : undefined} aria-current={current === id ? 'page' : undefined} onClick={() => onNavigate(id)} className={`flex min-h-[60px] min-w-0 touch-manipulation flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${current === id ? 'text-accent' : 'text-ink/60'}`}>
            <span className="relative"><Icon aria-hidden="true" className="h-[19px] w-[19px]" strokeWidth={1.8} />{alert && badge !== undefined && <span aria-hidden="true" className="absolute -right-3 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-paper bg-accent px-0.5 text-[9px] font-bold leading-none text-paper tabular-nums">{badge}</span>}</span>
            <span className="truncate">{label}</span>
          </button>
        ))}
        {mobileMore && <button type="button" aria-label="More workspace pages" aria-expanded={menuOpen} aria-controls={drawerId} aria-current={moreIsCurrent ? 'page' : undefined} onClick={openMenu} className={`flex min-h-[60px] min-w-0 touch-manipulation flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${moreIsCurrent ? 'text-accent' : 'text-ink/60'}`}><MoreHorizontal aria-hidden="true" className="h-[19px] w-[19px]" /><span>More</span></button>}
      </nav>
    </div>
  );
}
