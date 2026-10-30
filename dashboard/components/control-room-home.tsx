'use client';

import { Activity, ArrowRight, Bell, CheckCircle2, ChevronRight, CircleAlert, Library, ListChecks, Server, Smartphone, Users, type LucideIcon } from 'lucide-react';
import type { AdminOverviewPayload } from '@/lib/types';
import { formatCheckedTime, type RoomAlert, type RoomTarget, type ScribdSnapshot } from '@/lib/control-room';

interface Props {
  data: AdminOverviewPayload;
  overviewCheckedAt: number | null;
  overviewError: string | null;
  scribd: ScribdSnapshot;
  alerts: RoomAlert[];
  onNavigate: (target: RoomTarget) => void;
  onOpenAlert: (alert: RoomAlert) => void;
}

function StatusCard({ icon: Icon, label, value, tone, onClick }: {
  icon: typeof Server; label: string; value: string;
  tone: 'good' | 'warning' | 'muted'; onClick: () => void;
}) {
  const color = tone === 'good' ? 'bg-teal-50 text-teal-700' : tone === 'warning' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500';
  return (
    <button type="button" onClick={onClick} className="group flex min-h-[126px] min-w-0 flex-col items-start rounded-2xl border border-slate-200/80 bg-white p-3.5 text-left shadow-[0_3px_15px_rgba(15,23,42,0.03)] transition hover:border-teal-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 sm:p-4">
      <span className="flex w-full items-start justify-between gap-2">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${color}`}><Icon className="h-[18px] w-[18px]" strokeWidth={1.9} /></span>
        <ArrowRight className="mt-1 h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-teal-600 motion-reduce:transform-none" />
      </span>
      <span className="mt-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-500">{label}</span>
      <span className="mt-1 break-words text-[15px] font-bold leading-tight text-slate-900">{value}</span>
    </button>
  );
}

function WorkspaceLink({ icon: Icon, title, detail, onClick }: {
  icon: LucideIcon; title: string; detail: string; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="group flex min-h-[68px] w-full items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-teal-700 ring-1 ring-slate-100"><Icon aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.8} /></span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-slate-800">{title}</span><span className="mt-1 block text-xs text-slate-500">{detail}</span></span>
      <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-teal-700 motion-reduce:transform-none" />
    </button>
  );
}

export function ControlRoomHome({ data, overviewCheckedAt, overviewError, scribd, alerts, onNavigate, onOpenAlert }: Props) {
  const hasBotCheck = overviewCheckedAt != null && !overviewError;
  const botValue = !hasBotCheck ? 'Unknown' : data.botReachable ? 'Reachable' : data.botServerLinked ? 'Not reporting' : 'Not linked';
  const whatsappValue = !hasBotCheck || !data.botReachable || data.connected == null ? 'Unknown' : data.connected ? 'Connected' : 'Disconnected';
  const scribdValue = scribd.status?.panelOnline ? 'Reachable' : scribd.status || scribd.error ? 'Unavailable' : 'Checking';
  const syncValue = !hasBotCheck || !data.whitelistSync || data.whitelistSync === 'unknown'
    ? 'Unconfirmed' : data.whitelistSync === 'synced' ? 'Up to date' : 'Pending';
  const enabledNumbers = data.users.filter((item) => item.enabled).length;
  const allowedMembers = data.members.filter((item) => item.allowed).length;
  const numberSummary = hasBotCheck ? `${enabledNumbers} enabled ${enabledNumbers === 1 ? 'number' : 'numbers'}` : 'Status unavailable';
  const memberSummary = hasBotCheck ? `${allowedMembers} allowed ${allowedMembers === 1 ? 'member' : 'members'}` : 'Status unavailable';
  const librarySummary = scribd.status?.panelOnline ? `${scribd.status.active} active · ${scribd.status.finished} finished` : scribd.status || scribd.error ? 'Status unavailable' : 'Checking status';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3 px-0.5">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-700">Control room</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Overview</h1>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-500"><Activity className="h-3.5 w-3.5 text-teal-600" /> {formatCheckedTime(overviewCheckedAt)}</span>
      </div>

      <section aria-label="Service status" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
        <StatusCard icon={Server} label="Service bridge" value={botValue} tone={!hasBotCheck ? 'muted' : data.botReachable ? 'good' : 'warning'} onClick={() => onNavigate({ tab: 'server', page: 'service' })} />
        <StatusCard icon={Smartphone} label="WhatsApp" value={whatsappValue} tone={!hasBotCheck || !data.botReachable || data.connected == null ? 'muted' : data.connected ? 'good' : 'warning'} onClick={() => onNavigate({ tab: 'server', page: 'numbers' })} />
        <StatusCard icon={Library} label="Scribd" value={scribdValue} tone={scribd.status?.panelOnline ? 'good' : scribd.error || scribd.status ? 'warning' : 'muted'} onClick={() => onNavigate({ tab: 'scribd', page: 'queue' })} />
        <StatusCard icon={ListChecks} label="Number list" value={syncValue} tone={syncValue === 'Up to date' ? 'good' : syncValue === 'Pending' ? 'warning' : 'muted'} onClick={() => onNavigate({ tab: 'server', page: 'numbers' })} />
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-bold text-slate-900"><Bell className="h-4 w-4 text-teal-600" /> Needs attention</h2>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">{alerts.length}</span>
          </div>
          {alerts.length ? (
            <div className="mt-2 divide-y divide-slate-100">
              {alerts.slice(0, 3).map((alert) => (
                <button key={alert.id} type="button" onClick={() => onOpenAlert(alert)} className="flex min-h-12 w-full items-center gap-3 py-2.5 text-left">
                  <CircleAlert className={`h-4 w-4 shrink-0 ${alert.level === 'danger' ? 'text-rose-600' : 'text-amber-600'}`} />
                  <span className="min-w-0 flex-1 text-sm font-semibold text-slate-800">{alert.title}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-teal-50/70 p-3 text-xs text-teal-800"><CheckCircle2 className="h-4 w-4 shrink-0" /> No alerts from available checks.</div>
          )}
          <button type="button" onClick={() => onNavigate({ tab: 'activity', page: 'alerts' })} className="mt-2 inline-flex min-h-10 items-center gap-1 text-xs font-bold text-teal-700 hover:text-teal-900">View alerts <ArrowRight className="h-3.5 w-3.5" /></button>
        </section>
        <section aria-label="Workspace shortcuts" className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-teal-700">Your workspace</p><h2 className="mt-1 text-base font-bold text-slate-900">Quick access</h2></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-500">OWNER</span></div>
          <div className="mt-2 divide-y divide-slate-100">
            <WorkspaceLink icon={Smartphone} title="WhatsApp" detail={numberSummary} onClick={() => onNavigate({ tab: 'server', page: 'numbers' })} />
            <WorkspaceLink icon={Library} title="Scribd library" detail={librarySummary} onClick={() => onNavigate({ tab: 'scribd', page: 'search' })} />
            <WorkspaceLink icon={Users} title="Members" detail={memberSummary} onClick={() => onNavigate({ tab: 'members' })} />
          </div>
        </section>
      </div>
    </div>
  );
}
