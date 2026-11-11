'use client';

import { useMemo, useState } from 'react';
import { Activity, AlertCircle, Bell, CheckCircle2, ChevronRight, Clock3, RefreshCw, Search } from 'lucide-react';
import type { ActivityCategory, ActivityEvent } from '@/lib/types';
import type { ActivityPage, RoomAlert } from '@/lib/control-room';
import { SectionNav } from './section-nav';

interface Props {
  alerts: RoomAlert[];
  unreadAlertIds: ReadonlySet<string>;
  events: ActivityEvent[];
  storage: 'cloudflare-d1' | 'local' | null;
  loading: boolean;
  error: string | null;
  page: ActivityPage;
  onPageChange: (page: ActivityPage) => void;
  onRefresh: () => void;
  onOpenAlert: (alert: RoomAlert) => void;
}

type Filter = 'all' | ActivityCategory;
const PAGES: { id: ActivityPage; label: string }[] = [
  { id: 'alerts', label: 'Alerts' },
  { id: 'history', label: 'History' },
];
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'bot', label: 'Service' },
  { key: 'numbers', label: 'Numbers' }, { key: 'members', label: 'Members' },
  { key: 'account', label: 'Account' },
];
function dateText(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unavailable';
}

export function ControlRoomActivity({ alerts, unreadAlertIds, events, storage, loading, error, page, onPageChange, onRefresh, onOpenAlert }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return events.filter((event) => (filter === 'all' || event.category === filter) && (!query || `${event.action} ${event.actor} ${event.detail}`.toLowerCase().includes(query)));
  }, [events, filter, search]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <h1 className="font-display text-[28px] font-semibold tracking-tight text-ink">Activity</h1>
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh activity" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-ink/10 bg-paper text-ink/60 shadow-sm hover:text-accent disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} /></button>
      </div>
      <SectionNav label="Activity pages" items={PAGES} value={page} onChange={onPageChange} />

      {page === 'alerts' && (
        <section className="rounded-2xl border border-ink/10 bg-paper p-4 shadow-sm sm:p-5" aria-label="Current alerts">
          <div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-bold text-ink"><Bell className="h-4 w-4 text-accent" /> Current alerts</h2><span className="rounded-full bg-ink/5 px-2.5 py-1 text-[11px] font-bold text-ink/60">{alerts.length} active · {unreadAlertIds.size} unread</span></div>
          {alerts.length ? (
            <div className="mt-2 divide-y divide-ink/5">
              {alerts.map((alert) => (
                <button type="button" key={alert.id} onClick={() => onOpenAlert(alert)} className="flex min-h-14 w-full items-start gap-2.5 py-3 text-left">
                  <AlertCircle className={`mt-0.5 h-4 w-4 shrink-0 ${alert.level === 'danger' ? 'text-accent' : 'text-accent'}`} />
                  <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-ink/80">{alert.title} {unreadAlertIds.has(alert.id) && <span className="ml-1 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold text-accent">New</span>}</span><span className="mt-0.5 block text-xs leading-5 text-ink/60">{alert.detail}</span></span>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink/40" />
                </button>
              ))}
            </div>
          ) : <div className="mt-3 flex items-center gap-2 rounded-xl bg-accent/10 p-3 text-xs leading-5 text-accent"><CheckCircle2 className="h-4 w-4 shrink-0" /> No alerts from available checks.</div>}
          <p className="mt-3 text-xs text-ink/60">Website-only alerts update while this page is open.</p>
        </section>
      )}

      {page === 'history' && (
        <section className="rounded-2xl border border-ink/10 bg-paper p-4 shadow-sm sm:p-5" aria-label="Activity history">
          <h2 className="flex items-center gap-2 text-sm font-bold text-ink"><Activity className="h-4 w-4 text-accent" /> Activity history</h2>
          {storage === 'local' && <p className="mt-3 rounded-xl border border-accent/15 bg-accent/10 px-3 py-2 text-xs leading-5 text-accent">History uses the server’s local disk and may not persist on serverless hosting. Configure Cloudflare D1 for durable history.</p>}
          {error && <p role="alert" className="mt-3 rounded-xl bg-accent/10 px-3 py-2 text-xs text-accent">{error}</p>}
          <div className="relative mt-4"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" /><input type="search" aria-label="Search activity" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search actions or people" className="min-h-11 w-full rounded-xl border border-ink/10 bg-ink/5 py-2 pl-9 pr-3 text-base text-ink outline-none focus:border-accent focus:bg-paper focus:ring-2 focus:ring-accent/15 sm:text-sm" /></div>
          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1" aria-label="Activity filters">{FILTERS.map((item) => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)} className={`min-h-9 shrink-0 rounded-full border px-3 text-xs font-semibold transition ${filter === item.key ? 'border-accent bg-accent text-paper' : 'border-ink/10 bg-paper text-ink/60 hover:bg-ink/5'}`}>{item.label}</button>)}</div>
          {visible.length ? (
            <ol className="mt-3 divide-y divide-ink/5">
              {visible.map((event) => (
                <li key={event.id} className="flex items-start gap-3 py-3.5">
                  <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${event.outcome === 'failed' ? 'bg-accent/10 text-accent' : event.outcome === 'requested' ? 'bg-accent/10 text-accent' : 'bg-accent/10 text-accent'}`}>{event.outcome === 'failed' ? <AlertCircle className="h-4 w-4" /> : event.outcome === 'requested' ? <Clock3 className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-ink">{event.action}</p><span className="rounded-md bg-ink/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink/60">{event.outcome}</span></div>
                    <p className="mt-1 break-all text-xs leading-5 text-ink/60">{event.actor || 'System'}{event.detail ? ` · ${event.detail}` : ''}</p>
                    <p className="mt-0.5 text-[11px] text-ink/40">{dateText(event.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="py-8 text-center text-xs text-ink/60">{loading ? 'Loading activity…' : events.length ? 'No activity matches this filter.' : 'No activity recorded yet.'}</p>}
        </section>
      )}
    </div>
  );
}
