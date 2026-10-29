'use client';

import { useMemo, useState } from 'react';
import { Activity, AlertCircle, Bell, CheckCircle2, ChevronRight, Clock3, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import type { ActivityCategory, ActivityEvent } from '@/lib/types';
import type { OwnerTab, RoomAlert } from '@/lib/control-room';

interface Props {
  alerts: RoomAlert[];
  events: ActivityEvent[];
  storage: 'cloudflare-d1' | 'local' | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onNavigate: (tab: OwnerTab) => void;
}

type Filter = 'all' | ActivityCategory;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'bot', label: 'Bot' },
  { key: 'numbers', label: 'Numbers' }, { key: 'members', label: 'Members' },
  { key: 'scribd', label: 'Scribd' }, { key: 'account', label: 'Account' },
];
function dateText(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unavailable';
}

export function ControlRoomActivity({ alerts, events, storage, loading, error, onRefresh, onNavigate }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return events.filter((event) => (filter === 'all' || event.category === filter) && (!query || `${event.action} ${event.actor} ${event.detail}`.toLowerCase().includes(query)));
  }, [events, filter, search]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 px-0.5">
        <div><p className="text-[11px] font-bold uppercase tracking-[0.13em] text-teal-700">Stay informed</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Alerts & activity</h1><p className="mt-1 text-sm leading-5 text-slate-500">Important checks and actions in one place.</p></div>
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh activity" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:text-teal-700 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} /></button>
      </div>
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5" aria-label="Current alerts">
        <div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-bold text-slate-900"><Bell className="h-4 w-4 text-teal-600" /> Current alerts</h2><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">{alerts.length}</span></div>
        {alerts.length ? <div className="mt-2 divide-y divide-slate-100">{alerts.map((alert) => <button type="button" key={alert.id} onClick={() => onNavigate(alert.target)} className="flex min-h-14 w-full items-start gap-2.5 py-3 text-left"><AlertCircle className={`mt-0.5 h-4 w-4 shrink-0 ${alert.level === 'danger' ? 'text-rose-600' : 'text-amber-600'}`} /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-slate-800">{alert.title}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">{alert.detail}</span></span><ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" /></button>)}</div> : <div className="mt-3 flex items-center gap-2 rounded-xl bg-teal-50/70 p-3 text-xs leading-5 text-teal-800"><CheckCircle2 className="h-4 w-4 shrink-0" /> No alerts from the latest available checks.</div>}
        <p className="mt-3 text-xs leading-5 text-slate-400">Checks update while this page is open. Alerts are shown on the website only.</p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5" aria-label="Activity history">
        <div className="flex items-center justify-between gap-2"><div><h2 className="flex items-center gap-2 text-sm font-bold text-slate-900"><Activity className="h-4 w-4 text-teal-600" /> Activity history</h2><p className="mt-1 text-xs text-slate-500">Actions recorded after this feature was enabled.</p></div><ShieldCheck className="h-5 w-5 shrink-0 text-teal-600" /></div>
        {storage === 'local' && <p className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">History uses the server’s local disk. On serverless hosting it may not persist; configure Cloudflare D1 for durable history.</p>}
        {error && <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
        <div className="relative mt-4"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input type="search" aria-label="Search activity" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search actions or people" className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-base text-slate-900 outline-none focus:border-teal-400 focus:bg-white focus:ring-2 focus:ring-teal-100 sm:text-sm" /></div>
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1" aria-label="Activity filters">{FILTERS.map((item) => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)} className={`min-h-9 shrink-0 rounded-full border px-3 text-xs font-semibold transition ${filter === item.key ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>{item.label}</button>)}</div>
        {visible.length ? <ol className="mt-3 divide-y divide-slate-100">{visible.map((event) => <li key={event.id} className="flex items-start gap-3 py-3.5"><span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${event.outcome === 'failed' ? 'bg-rose-50 text-rose-600' : event.outcome === 'requested' ? 'bg-amber-50 text-amber-700' : 'bg-teal-50 text-teal-700'}`}>{event.outcome === 'failed' ? <AlertCircle className="h-4 w-4" /> : event.outcome === 'requested' ? <Clock3 className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-slate-900">{event.action}</p><span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500">{event.outcome}</span></div><p className="mt-1 break-all text-xs leading-5 text-slate-500">{event.actor || 'System'}{event.detail ? ` · ${event.detail}` : ''}</p><p className="mt-0.5 text-[11px] text-slate-400">{dateText(event.createdAt)}</p></div></li>)}</ol> : <p className="py-8 text-center text-xs text-slate-500">{loading ? 'Loading activity…' : events.length ? 'No activity matches this filter.' : 'No activity recorded yet.'}</p>}
      </section>
    </div>
  );
}
