'use client';

import {
  Activity, ArrowRight, Bell, BookOpen, CheckCircle2, ChevronRight, CircleAlert,
  HardDrive, Library, ListChecks, Radio, Server, Smartphone, Users,
} from 'lucide-react';
import type { AdminOverviewPayload, ActivityEvent, PanelLiveStatus } from '@/lib/types';
import { formatCheckedTime, type OwnerTab, type RoomAlert, type ScribdSnapshot } from '@/lib/control-room';

interface Props {
  name: string;
  data: AdminOverviewPayload;
  overviewCheckedAt: number | null;
  overviewError: string | null;
  scribd: ScribdSnapshot;
  panel: PanelLiveStatus | null;
  alerts: RoomAlert[];
  events: ActivityEvent[];
  eventsLoading: boolean;
  onNavigate: (tab: OwnerTab) => void;
}

function StatusCard({ icon: Icon, label, value, note, tone, onClick }: {
  icon: typeof Server; label: string; value: string; note: string;
  tone: 'good' | 'warning' | 'muted'; onClick: () => void;
}) {
  const color = tone === 'good' ? 'bg-teal-50 text-teal-700' : tone === 'warning' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500';
  return (
    <button type="button" onClick={onClick} className="group flex min-w-0 flex-col items-start rounded-2xl border border-slate-200/80 bg-white p-3.5 text-left shadow-[0_3px_15px_rgba(15,23,42,0.03)] transition hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-md motion-reduce:transform-none sm:p-4">
      <span className="flex w-full items-start justify-between gap-2">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${color}`}><Icon className="h-[18px] w-[18px]" strokeWidth={1.9} /></span>
        <ArrowRight className="mt-1 h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-teal-600 motion-reduce:transform-none" />
      </span>
      <span className="mt-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-500">{label}</span>
      <span className="mt-1 break-words text-[15px] font-bold leading-tight text-slate-900">{value}</span>
      <span className="mt-1 line-clamp-2 text-xs leading-4 text-slate-500">{note}</span>
    </button>
  );
}

function niceWhen(when: string): string {
  const date = new Date(when);
  if (!Number.isFinite(date.getTime())) return 'Time unavailable';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ControlRoomHome({ name, data, overviewCheckedAt, overviewError, scribd, panel, alerts, events, eventsLoading, onNavigate }: Props) {
  const hasBotCheck = overviewCheckedAt != null && !overviewError;
  const botValue = !hasBotCheck ? 'Unknown' : data.botReachable ? 'Reachable' : data.botServerLinked ? 'Not reporting' : 'Not linked';
  const whatsappValue = !hasBotCheck || !data.botReachable || data.connected == null ? 'Unknown' : data.connected ? 'Connected' : 'Disconnected';
  const scribdValue = scribd.status ? 'Reachable' : scribd.error ? 'Unavailable' : 'Checking';
  const syncValue = !hasBotCheck || !data.whitelistSync || data.whitelistSync === 'unknown'
    ? 'Unconfirmed' : data.whitelistSync === 'synced' ? 'Up to date' : 'Pending';
  const firstName = name.trim().split(/\s+/)[0] || 'Owner';
  const disk = hasBotCheck && data.botReachable && data.diskUsedMB != null
    ? `${data.diskUsedMB} MB${data.diskBudgetMB != null ? ` / ${data.diskBudgetMB} MB` : ' used'}` : 'Not reported';
  const ram = hasBotCheck && data.botReachable && data.ramUsedMB != null ? `${data.ramUsedMB} MB` : 'Not reported';

  return (
    <div className="space-y-4 sm:space-y-5">
      <section className="relative overflow-hidden rounded-[24px] border border-teal-100 bg-gradient-to-br from-white via-white to-teal-50/80 p-5 shadow-[0_6px_30px_rgba(15,118,110,0.06)] sm:p-7">
        <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full border-[26px] border-teal-100/50" />
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-teal-700">
              <span className="h-2 w-2 rounded-full bg-teal-500 motion-safe:animate-pulse" /> Owner workspace
            </div>
            <h1 className="mt-3 text-[26px] font-bold leading-tight tracking-tight text-slate-950 sm:text-3xl">Your control room</h1>
            <p className="mt-1.5 max-w-md text-sm leading-6 text-slate-600">Welcome back, {firstName}. Here is what your services are reporting.</p>
          </div>
          <span className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-teal-100 bg-white text-teal-600 shadow-sm min-[360px]:flex"><Radio className="h-6 w-6" /></span>
        </div>
        <div className="relative mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-teal-100/80 pt-4 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 text-teal-600" /> {formatCheckedTime(overviewCheckedAt)}</span>
          <span>{alerts.length ? `${alerts.length} ${alerts.length === 1 ? 'item needs' : 'items need'} attention` : 'No active alerts reported'}</span>
        </div>
      </section>

      <div className="flex items-end justify-between gap-2 px-0.5">
        <div><p className="text-[11px] font-bold uppercase tracking-[0.13em] text-teal-700">At a glance</p><h2 className="mt-1 text-lg font-bold tracking-tight text-slate-900">Service status</h2></div>
        <span className="text-[11px] text-slate-500">Live checks</span>
      </div>
      <section aria-label="Service status" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
        <StatusCard icon={Server} label="Bot bridge" value={botValue} note={data.lastSeenSecondsAgo != null && hasBotCheck ? `Last heartbeat ${data.lastSeenSecondsAgo}s ago` : 'Connection to your bot'} tone={!hasBotCheck ? 'muted' : data.botReachable ? 'good' : 'warning'} onClick={() => onNavigate('server')} />
        <StatusCard icon={Smartphone} label="WhatsApp" value={whatsappValue} note={!hasBotCheck || !data.botReachable || data.connected == null ? 'Waiting for bot status' : data.connected ? 'Bot reports a connection' : 'Bot is awaiting connection'} tone={!hasBotCheck || !data.botReachable || data.connected == null ? 'muted' : data.connected ? 'good' : 'warning'} onClick={() => onNavigate('server')} />
        <StatusCard icon={Library} label="Scribd" value={scribdValue} note={scribd.status ? `${scribd.status.active} active · ${scribd.status.finished} finished` : formatCheckedTime(scribd.checkedAt)} tone={scribd.status ? 'good' : scribd.error ? 'warning' : 'muted'} onClick={() => onNavigate('scribd')} />
        <StatusCard icon={ListChecks} label="Number list" value={syncValue} note={data.whitelistSync === 'synced' && hasBotCheck ? 'Bot reports the latest list' : data.whitelistSync === 'pending' && hasBotCheck ? 'Waiting for bot check-in' : 'No confirmation available'} tone={syncValue === 'Up to date' ? 'good' : syncValue === 'Pending' ? 'warning' : 'muted'} onClick={() => onNavigate('server')} />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-[11px] font-bold uppercase tracking-[0.13em] text-teal-700">Monitor</p><h2 className="mt-1 text-base font-bold text-slate-900">Needs attention</h2></div>
            <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${alerts.length ? 'bg-amber-50 text-amber-700' : 'bg-teal-50 text-teal-700'}`}><Bell className="h-[18px] w-[18px]" /></span>
          </div>
          {alerts.length ? (
            <div className="mt-3 divide-y divide-slate-100">
              {alerts.slice(0, 3).map((alert) => (
                <button key={alert.id} type="button" onClick={() => onNavigate(alert.target)} className="flex w-full items-start gap-3 py-3 text-left">
                  <CircleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${alert.level === 'danger' ? 'text-rose-600' : 'text-amber-600'}`} />
                  <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-slate-800">{alert.title}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">{alert.detail}</span></span>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-3 flex items-start gap-3 rounded-xl bg-teal-50/60 p-3.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
              <p className="text-xs leading-5 text-slate-600">No issues reported by the latest checks. Unavailable measurements are shown as unknown.</p>
            </div>
          )}
          <button type="button" onClick={() => onNavigate('activity')} className="mt-3 inline-flex min-h-10 items-center gap-1 text-xs font-bold text-teal-700 hover:text-teal-900">View alerts and history <ArrowRight className="h-3.5 w-3.5" /></button>
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-[11px] font-bold uppercase tracking-[0.13em] text-teal-700">Bot resources</p><h2 className="mt-1 text-base font-bold text-slate-900">System snapshot</h2></div>
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><HardDrive className="h-[18px] w-[18px]" /></span>
          </div>
          <dl className="mt-3 divide-y divide-slate-100 text-sm">
            <div className="flex justify-between gap-3 py-2.5"><dt className="text-slate-500">Hosting server</dt><dd className="text-right font-semibold capitalize text-slate-800">{!panel ? 'Checking' : panel.configured === false ? 'Not configured' : panel.state === 'unknown' ? 'Unknown' : panel.state}</dd></div>
            <div className="flex justify-between gap-3 py-2.5"><dt className="text-slate-500">Memory</dt><dd className="text-right font-semibold text-slate-800">{ram}</dd></div>
            <div className="flex justify-between gap-3 py-2.5"><dt className="text-slate-500">Disk budget</dt><dd className="text-right font-semibold text-slate-800">{disk}</dd></div>
            <div className="flex justify-between gap-3 py-2.5"><dt className="text-slate-500">Bot queues</dt><dd className="text-right font-semibold text-slate-800">{hasBotCheck && data.botReachable && data.queueLight != null && data.queueHeavy != null ? `${data.queueLight} light · ${data.queueHeavy} heavy` : 'Not reported'}</dd></div>
          </dl>
          <p className="mt-2 text-xs leading-5 text-slate-400">Resources are reported by the bot; hosting status comes from the panel.</p>
        </section>
      </div>

      <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex items-center justify-between gap-3"><div><p className="text-[11px] font-bold uppercase tracking-[0.13em] text-teal-700">Jump back in</p><h2 className="mt-1 text-base font-bold text-slate-900">Quick actions</h2></div></div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            { label: 'Bot & numbers', tab: 'server', icon: Smartphone },
            { label: 'Open Scribd', tab: 'scribd', icon: BookOpen },
            { label: 'Manage members', tab: 'members', icon: Users },
            { label: 'View activity', tab: 'activity', icon: Activity },
          ] as const).map(({ label, tab, icon: Icon }) => (
            <button key={tab} type="button" onClick={() => onNavigate(tab)} className="flex min-h-[52px] items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-left text-xs font-semibold text-slate-700 transition hover:border-teal-200 hover:bg-teal-50 hover:text-teal-800">
              <Icon className="h-4 w-4 shrink-0 text-teal-600" /> <span>{label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex items-center justify-between gap-3"><div><p className="text-[11px] font-bold uppercase tracking-[0.13em] text-teal-700">Recently</p><h2 className="mt-1 text-base font-bold text-slate-900">Activity</h2></div><button type="button" onClick={() => onNavigate('activity')} className="min-h-10 text-xs font-bold text-teal-700">See all</button></div>
        {events.length ? <ul className="mt-2 divide-y divide-slate-100">{events.slice(0, 3).map((event) => <li key={event.id} className="flex items-start justify-between gap-3 py-3"><div className="min-w-0"><p className="text-sm font-semibold text-slate-800">{event.action}</p><p className="mt-0.5 break-all text-xs text-slate-500">{event.actor || 'System'}</p></div><span className="shrink-0 text-right text-[11px] text-slate-400">{niceWhen(event.createdAt)}</span></li>)}</ul>
          : <p className="mt-3 text-xs leading-5 text-slate-500">{eventsLoading ? 'Loading recent activity…' : 'No recorded activity yet. New actions will appear here.'}</p>}
      </section>
    </div>
  );
}
