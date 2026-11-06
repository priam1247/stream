'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity, ArrowRight, Check, CircleHelp, Clock3, Command, Copy, ExternalLink,
  Home, LogOut, MessageSquare, Search, Settings2, ShieldCheck, Smartphone, Unlink,
} from 'lucide-react';
import { MEMBER_COMMANDS } from '@/lib/bot-data';
import { authHeaders, setSavedSessionToken } from '@/lib/client-session';
import { memberAnalytics } from '@/lib/member-analytics';
import { maskMemberNumber } from '@/lib/member-link';
import type { AuthUser, MemberOverviewPayload, WhatsAppAccountStatus } from '@/lib/types';
import { WorkspaceShell, type WorkspaceNavGroup } from './workspace-shell';
import { ZafarBubble, ZafarFox } from './zafar-fox';

type Page = 'home' | 'commands' | 'settings' | 'support';
type Category = 'all' | 'general' | 'media' | 'vault';

const card = 'rounded-[22px] border border-line/80 bg-paper shadow-[0_10px_35px_-28px_rgba(15,45,37,0.3)]';
const eyebrow = 'text-[10px] font-bold uppercase tracking-[0.16em] text-accent-700';
const categoryNames = { general: 'General', media: 'Media', vault: 'Vault', other: 'Other' } as const;
const categoryColors = { general: 'bg-black', media: 'bg-neutral-700', vault: 'bg-neutral-500', other: 'bg-neutral-400' } as const;

function formatDate(value?: number) {
  if (!value || !Number.isFinite(value)) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(value);
}
function formatDateTime(value?: number) {
  if (!value || !Number.isFinite(value)) return 'Unavailable';
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(value);
}
function dayLabel(date: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

interface Props {
  user: AuthUser;
  overview: MemberOverviewPayload;
  number: string;
  account?: WhatsAppAccountStatus;
  linkedAt?: number;
  statusError: boolean;
  busy: boolean;
  unlinking: boolean;
  supportUnread: number;
  notice: { text: string; bad?: boolean } | null;
  onRefresh: () => void;
  onReconnect: () => void;
  onUnlink: () => void;
  onSignOut: () => void | Promise<void>;
}

export function MemberWorkspace({ user: initialUser, overview, number, account, linkedAt, statusError, busy, unlinking, supportUnread, notice, onRefresh, onReconnect, onUnlink, onSignOut }: Props) {
  const router = useRouter();
  const [user, setUser] = useState(initialUser);
  const [page, setPage] = useState<Page>('home');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [copied, setCopied] = useState('');
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [profileName, setProfileName] = useState(initialUser.name || '');
  const [saving, setSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const current = overview.numbers.find((item) => item.number === number);
  const approval = current?.approval || 'approved';
  const reachable = !statusError && overview.botReachable === true;
  const state = reachable ? account?.state : undefined;
  const connection = statusError ? 'Status unavailable' : !reachable ? 'Bot offline' : state === 'connected' ? 'Bot active' : state === 'connecting' ? 'Reconnecting' :
    state === 'paused' ? 'Connection paused' : state === 'logged_out' ? 'WhatsApp disconnected' :
      state === 'awaiting_link' ? 'Link in progress' : state === 'expired' ? 'Connection expired' : 'Session not reporting';
  const access = !overview.memberAllowed ? 'Access restricted' : approval === 'pending' ? 'Awaiting approval' :
    approval === 'rejected' ? 'Not approved' : current?.enabled === false ? 'Access paused' : 'Approved';
  const canReconnect = reachable && (state === 'logged_out' || state === 'expired' || state === 'awaiting_link' || !account);
  const usage = overview.personalUsage?.find((item) => item.number === number) || null;
  const analytics = useMemo(() => usage ? memberAnalytics(usage) : null, [usage]);
  const maxBar = Math.max(1, ...(analytics?.days.map((day) => day.total || 0) || []));
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase().replace(/^\./, '');
    return MEMBER_COMMANDS.filter((command) => (category === 'all' || command.category === category) &&
      (!value || [command.name, command.summary, ...command.aliases].some((part) => part.toLowerCase().includes(value))));
  }, [category, query]);

  const groups: WorkspaceNavGroup<Page>[] = [
    { label: 'My space', items: [
      { id: 'home', label: 'Overview', icon: Home },
      { id: 'commands', label: 'Commands', icon: Command },
      { id: 'settings', label: 'Settings', icon: Settings2 },
    ] },
    { label: 'More', items: [
      { id: 'support', label: 'Support', icon: MessageSquare, ...(supportUnread ? { badge: supportUnread, alert: true } : {}) },
    ] },
  ];
  const navigate = (next: Page) => {
    if (next === 'support') { router.push('/support'); return; }
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); window.setTimeout(() => setCopied(''), 1800); }
    catch { setProfileMessage({ text: 'Copy unavailable on this device.', bad: true }); }
  };
  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !profileName.trim()) return;
    setSaving(true); setProfileMessage(null);
    try {
      const response = await fetch('/api/auth/me', { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ name: profileName.trim() }) });
      const body = await response.json();
      if (!response.ok || !body.user) throw new Error(body.error || 'Unable to save your name.');
      setUser(body.user);
      if (body.token) setSavedSessionToken(body.token);
      setProfileMessage({ text: 'Profile saved.' });
    } catch (error) { setProfileMessage({ text: error instanceof Error ? error.message : 'Unable to save your name.', bad: true }); }
    finally { setSaving(false); }
  };
  const firstName = (user.name || 'there').trim().split(/\s+/)[0];

  return <WorkspaceShell kind="member" user={user} groups={groups} current={page} onNavigate={navigate}
    mobileItems={['home', 'commands', 'settings']} mobileMore refreshing={false} onRefresh={onRefresh}
    onAccount={() => navigate('settings')} onSignOut={onSignOut}>
    <div className="mx-auto max-w-[1180px]">
      {notice && <p role={notice.bad ? 'alert' : 'status'} className={`mb-4 rounded-2xl border px-4 py-3 text-xs ${notice.bad ? 'border-bad-200 bg-bad-50 text-bad-800' : 'border-accent-100 bg-accent-50 text-accent-800'}`}>{notice.text}</p>}
      {page === 'home' && <>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <ZafarFox compact />
            <div className="min-w-0">
              <p className={eyebrow}>Your personal space</p>
              <h1 className="font-display mt-1.5 text-[26px] font-semibold tracking-tight text-ink sm:text-[33px]">Good to see you, {firstName}.</h1>
              <p className="mt-1 text-xs text-muted sm:text-sm">Your connection and activity, in one place.</p>
            </div>
          </div>
          <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-semibold ${state === 'connected' && access === 'Approved' ? 'bg-ok-50 text-ok-800' : 'bg-warn-50 text-warn-800'}`}><span className={`h-2 w-2 rounded-full ${state === 'connected' && access === 'Approved' ? 'bg-ok-500' : 'bg-warn-500'}`} />{access}</span>
          <ZafarBubble className="basis-full bg-paper/80 text-xs text-ink-soft">
            {statusError
              ? 'I can’t reach your status right now. Try refresh and I’ll check again.'
              : state === 'connected'
                ? 'You’re connected. Your recent activity and tools are ready here.'
                : `Your connection is ${connection.toLowerCase()}. Visit Settings to manage it.`}
          </ZafarBubble>
        </div>
        {(!overview.memberAllowed || approval !== 'approved' || current?.enabled === false) && <div role="status" className="mb-4 rounded-2xl border border-warn-200 bg-warn-50 px-4 py-3 text-xs leading-5 text-warn-900">{!overview.memberAllowed ? 'Your account access is restricted.' : approval === 'pending' ? 'Your number is linked. Commands unlock after administrator approval.' : approval === 'rejected' ? 'Your request was not approved. Contact support or unlink your number.' : 'Your command access is paused.'}</div>}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(280px,1fr)]">
          <section aria-label="Command activity" className={`${card} p-4 sm:p-6`}>
            <div className="flex items-start justify-between gap-3"><div><p className={eyebrow}>Your activity</p><h2 className="mt-1 text-lg font-bold tracking-tight">Command activity</h2><p className="mt-1 text-xs text-muted">Last 7 days · UTC</p></div><span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent-50 text-accent-700"><Activity className="h-5 w-5" /></span></div>
            {analytics && usage ? <>
              <div className="mt-5 flex flex-wrap items-end gap-x-3 gap-y-1"><span className="text-[36px] font-bold leading-none tracking-tight text-ink tabular-nums">{analytics.measuredDays ? analytics.total.toLocaleString() : '—'}</span><span className="pb-0.5 text-xs text-muted">commands recorded</span>{analytics.previousTotal !== null && <span className="ml-auto rounded-full bg-wash px-2.5 py-1 text-[10px] font-semibold text-muted">{analytics.total - analytics.previousTotal >= 0 ? '+' : ''}{analytics.total - analytics.previousTotal} vs previous 7 days</span>}</div>
              <div role="img" aria-label={`Command activity over the last 7 days: ${analytics.days.map((day) => `${day.date}: ${day.total === null ? 'not measured' : day.total}`).join(', ')}`} className="mt-5 flex h-32 items-end gap-2 border-b border-wash sm:h-40 sm:gap-3">
                {analytics.days.map((day) => <div key={day.date} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-2"><div className="flex h-full items-end justify-center"><div title={`${day.date}: ${day.total === null ? 'Not measured' : `${day.total} commands`}`} style={{ height: day.total === null ? '4px' : `${Math.max(4, (day.total / maxBar) * 100)}%` }} className={`w-full max-w-[48px] rounded-t-lg ${day.total === null ? 'bg-wash' : day.total === 0 ? 'bg-accent-100' : 'bg-gradient-to-t from-accent-700 to-ok-600'}`} /></div><span className="pb-2 text-center text-[10px] font-medium text-faint">{dayLabel(day.date)}</span></div>)}
              </div>
              <p className="mt-3 text-[11px] leading-5 text-faint">Tracking since {formatDate(usage.trackedSince)} · Updated {formatDateTime(usage.updatedAt)}{analytics.measuredDays < 7 ? ' · Unmeasured days are muted' : ''}</p>
            </> : <div className="flex min-h-[205px] flex-col items-center justify-center text-center"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-50 text-accent-600"><Activity className="h-5 w-5" /></span><p className="mt-3 text-sm font-semibold text-ink-soft">Waiting for activity data</p><p className="mt-1 max-w-[230px] text-xs leading-5 text-muted">Personal stats appear when the service reports them.</p></div>}
          </section>
          <section aria-label="Linked number" className={`${card} overflow-hidden`}>
            <div className="border-b border-wash bg-gradient-to-br from-[#effaf5] to-white p-4 sm:p-6"><div className="flex items-start justify-between gap-3"><div><p className={eyebrow}>Your WhatsApp</p><h2 className="mt-1 text-lg font-bold tracking-tight">Connection</h2></div><span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-paper text-accent-700 shadow-sm"><Smartphone className="h-5 w-5" /></span></div><p className="mt-5 font-mono text-[17px] font-bold tracking-tight text-ink">{maskMemberNumber(number)}</p><p className="mt-1 text-xs text-muted">Linked {formatDate(linkedAt)}</p></div>
            <div className="space-y-3 p-4 text-xs sm:p-6"><div className="flex items-center justify-between gap-3"><span className="text-muted">Connection</span><span className="font-semibold text-ink-soft">{connection}</span></div><div className="flex items-center justify-between gap-3"><span className="text-muted">Access</span><span className="font-semibold text-ink-soft">{access}</span></div><button type="button" onClick={() => navigate('settings')} className="mt-1 inline-flex min-h-10 items-center gap-1.5 font-semibold text-accent-700 hover:text-accent-900">Manage connection <ArrowRight className="h-3.5 w-3.5" /></button></div>
          </section>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(240px,0.8fr)]">
          <section className={`${card} p-4 sm:p-5`}><div className="flex items-center justify-between"><h2 className="text-sm font-bold">Most used</h2><span className="text-[10px] text-faint">Last 7 days</span></div>{analytics?.top.length ? <div className="mt-4 space-y-3">{analytics.top.slice(0, 3).map(([name, count]) => <div key={name}><div className="flex justify-between text-xs"><span className="font-mono font-semibold text-ink-soft">{name === 'other' ? 'Other commands' : `.${name}`}</span><span className="text-muted tabular-nums">{count}</span></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-wash"><div className="h-full rounded-full bg-accent-600" style={{ width: `${(count / analytics.top[0][1]) * 100}%` }} /></div></div>)}</div> : <p className="mt-4 text-xs leading-5 text-muted">{analytics ? 'Your most-used commands will appear here.' : 'Activity data is not available yet.'}</p>}</section>
          <section className={`${card} p-4 sm:p-5`}><div className="flex items-center justify-between"><h2 className="text-sm font-bold">Command mix</h2><span className="text-[10px] text-faint">Last 7 days</span></div>{analytics && analytics.total > 0 ? <><div className="mt-5 flex h-2.5 overflow-hidden rounded-full bg-wash">{analytics.categories.map((name) => <span key={name} className={categoryColors[name]} style={{ width: `${analytics.categoryCounts[name] / analytics.total * 100}%` }} />)}</div><div className="mt-4 grid grid-cols-2 gap-2">{analytics.categories.filter((name) => analytics.categoryCounts[name] > 0).map((name) => <div key={name} className="flex items-center gap-2 text-[11px] text-muted"><span className={`h-2 w-2 rounded-full ${categoryColors[name]}`} />{categoryNames[name]} <span className="ml-auto font-semibold tabular-nums">{analytics.categoryCounts[name]}</span></div>)}</div></> : <p className="mt-4 text-xs leading-5 text-muted">Your command categories will appear after you use the bot.</p>}</section>
          <section className={`${card} p-4 sm:p-5`}><div className="flex items-center justify-between"><h2 className="text-sm font-bold">Recent activity</h2><Clock3 className="h-4 w-4 text-faint" /></div>{usage?.lastAt && usage.lastCommand ? <><p className="mt-4 font-mono text-sm font-bold text-ink-soft">.{usage.lastCommand}</p><p className="mt-1 text-xs text-muted">{formatDateTime(usage.lastAt)}</p></> : <p className="mt-4 text-xs leading-5 text-muted">No recent commands recorded.</p>}<button type="button" onClick={() => navigate('commands')} className="mt-4 inline-flex min-h-10 items-center gap-1.5 text-xs font-semibold text-accent-700">Explore commands <ArrowRight className="h-3.5 w-3.5" /></button></section>
        </div>
      </>}
      {page === 'commands' && <>
        <div className="mb-5"><p className={eyebrow}>Explore</p><h1 className="font-display mt-1.5 text-[27px] font-semibold tracking-tight">Commands</h1><p className="mt-1 text-xs text-muted">Find a command and tap to copy it.</p></div>
        {approval !== 'approved' && <p className="mb-4 rounded-2xl border border-warn-200 bg-warn-50 p-3 text-xs text-warn-900">Commands unlock after approval.</p>}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="relative w-full sm:max-w-sm"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" /><input type="search" aria-label="Search commands" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commands or aliases" className="min-h-12 w-full rounded-2xl border border-line bg-paper pl-10 pr-4 text-base outline-none focus:border-accent-600" /></div><div aria-label="Command categories" className="flex gap-1.5 overflow-x-auto">{(['all', 'general', 'media', 'vault'] as const).map((item) => <button type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)} className={`min-h-10 rounded-xl px-3 text-xs font-semibold capitalize ${category === item ? 'bg-accent-700 text-white' : 'bg-paper text-muted ring-1 ring-line'}`}>{item}</button>)}</div></div>
        {!filtered.length && <p className="py-12 text-center text-xs text-muted">No commands found.</p>}
        {(['general', 'media', 'vault'] as const).map((group) => {
          const items = filtered.filter((item) => item.category === group);
          if (!items.length) return null;
          return <section key={group} className="mt-7" aria-label={`${categoryNames[group]} commands`}><div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-bold">{categoryNames[group]}</h2><span className="rounded-md bg-wash px-1.5 py-0.5 text-[10px] font-semibold text-muted">{items.length}</span></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <button type="button" key={item.name} onClick={() => void copy(`.${item.name}`)} aria-label={`Copy .${item.name} command`} className={`${card} flex min-h-[90px] items-start gap-3 p-3.5 text-left transition hover:border-accent-200 hover:bg-accent-50/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-600`}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-50 font-mono text-xs font-bold text-accent-700">›_</span><span className="min-w-0 flex-1"><span className="block font-mono text-xs font-bold text-ink-soft">.{item.name}</span><span className="mt-1 block text-[11px] leading-4 text-muted">{overview.disabledMemberCommands?.includes(item.name) ? 'Temporarily unavailable' : item.summary}</span><span className="mt-1.5 block truncate font-mono text-[10px] text-faint">{item.usage}</span></span>{copied === `.${item.name}` ? <Check className="h-4 w-4 shrink-0 text-accent-600" /> : <Copy className="h-4 w-4 shrink-0 text-faint" />}</button>)}</div></section>;
        })}
      </>}
      {page === 'settings' && <>
        <div className="mb-5"><p className={eyebrow}>Your account</p><h1 className="font-display mt-1.5 text-[27px] font-semibold tracking-tight">Settings</h1><p className="mt-1 text-xs text-muted">Manage your profile and connection.</p></div>
        <div className="grid gap-4 lg:grid-cols-2"><section className={`${card} p-4 sm:p-6`}><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-50 text-accent-700"><ShieldCheck className="h-5 w-5" /></span><div><h2 className="text-sm font-bold">Profile</h2><p className="mt-0.5 text-[11px] text-muted">Your personal details</p></div></div><form onSubmit={(event) => void saveProfile(event)} className="mt-5 space-y-4"><div><label htmlFor="member-profile-name" className="mb-1.5 block text-xs font-semibold text-muted">Display name</label><input id="member-profile-name" required maxLength={100} value={profileName} onChange={(event) => setProfileName(event.target.value)} className="min-h-12 w-full rounded-xl border border-line px-3 text-base outline-none focus:border-accent-600" /></div><div><span className="block text-xs font-semibold text-muted">Email</span><p className="mt-1 break-all text-xs text-muted">{user.email}</p></div><button type="submit" disabled={saving} className="min-h-11 rounded-xl bg-accent-700 px-4 text-xs font-bold text-white hover:bg-accent-800 disabled:opacity-50">{saving ? 'Saving…' : 'Save changes'}</button></form></section>
          <section className={`${card} p-4 sm:p-6`}><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-50 text-accent-700"><Smartphone className="h-5 w-5" /></span><div><h2 className="text-sm font-bold">WhatsApp connection</h2><p className="mt-0.5 text-[11px] text-muted">{maskMemberNumber(number)}</p></div></div><div className="mt-5 space-y-3 rounded-2xl bg-wash p-4 text-xs"><div className="flex justify-between gap-2"><span className="text-muted">Connection</span><span className="font-semibold">{connection}</span></div><div className="flex justify-between gap-2"><span className="text-muted">Approval</span><span className="font-semibold">{access}</span></div><div className="flex justify-between gap-2"><span className="text-muted">Linked</span><span className="font-semibold">{formatDate(linkedAt)}</span></div></div><div className="mt-4 flex flex-wrap gap-2">{canReconnect && <button type="button" disabled={!overview.memberAllowed || !overview.botEnabledForMembers || unlinking} onClick={onReconnect} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-accent-700 px-3 text-xs font-semibold text-white disabled:opacity-50"><Smartphone className="h-4 w-4" />{state === 'awaiting_link' ? 'View linking code' : 'Reconnect'}</button>}<button type="button" disabled={busy || unlinking} onClick={() => setConfirmUnlink(true)} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-bad-200 px-3 text-xs font-semibold text-bad-700 disabled:opacity-50"><Unlink className="h-4 w-4" />{unlinking ? 'Unlinking…' : 'Unlink'}</button></div></section>
          <section className={`${card} p-4 sm:p-6`}><h2 className="text-sm font-bold">Need a hand?</h2><p className="mt-1 text-xs leading-5 text-muted">Send a message to support.{supportUnread ? ` ${supportUnread} unread.` : ''}</p><button type="button" onClick={() => navigate('support')} className="mt-3 inline-flex min-h-11 items-center gap-2 text-xs font-semibold text-accent-700"><CircleHelp className="h-4 w-4" /> Open support <ExternalLink className="h-3.5 w-3.5" /></button></section>
          <section className={`${card} p-4 sm:p-6`}><h2 className="text-sm font-bold">Session</h2><p className="mt-1 text-xs leading-5 text-muted">Sign in again after closing or refreshing this page.</p><button type="button" onClick={() => void onSignOut()} className="mt-3 inline-flex min-h-11 items-center gap-2 text-xs font-semibold text-bad-700"><LogOut className="h-4 w-4" /> Sign out</button></section></div>
      </>}
      {profileMessage && <p role={profileMessage.bad ? 'alert' : 'status'} className={`mt-4 text-xs ${profileMessage.bad ? 'text-bad-700' : 'text-accent-700'}`}>{profileMessage.text}</p>}
    </div>
    {confirmUnlink && <div role="alertdialog" aria-modal="true" aria-labelledby="member-unlink-title" className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"><div className="w-full max-w-[360px] rounded-2xl bg-paper p-5 shadow-xl"><h2 id="member-unlink-title" className="text-base font-bold">Unlink this number?</h2><p className="mt-2 text-xs leading-5 text-muted">The WhatsApp session will disconnect. You can link again later.</p><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setConfirmUnlink(false)} className="min-h-11 rounded-xl px-4 text-xs font-semibold text-muted">Cancel</button><button type="button" disabled={busy} onClick={() => { setConfirmUnlink(false); onUnlink(); }} className="min-h-11 rounded-xl bg-bad-700 px-4 text-xs font-semibold text-white disabled:opacity-50">{busy ? 'Unlinking…' : 'Yes, unlink'}</button></div></div></div>}
  </WorkspaceShell>;
}
