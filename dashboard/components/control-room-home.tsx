'use client';

import { Activity, ArrowRight, Bell, CheckCircle2, ChevronRight, CircleAlert, ListChecks, Server, Smartphone, Users, type LucideIcon } from 'lucide-react';
import type { AdminOverviewPayload } from '@/lib/types';
import { formatCheckedTime, type RoomAlert, type RoomTarget } from '@/lib/control-room';
import { ZafarBubble, ZafarFox } from './zafar-fox';

interface Props {
  data: AdminOverviewPayload;
  overviewCheckedAt: number | null;
  overviewError: string | null;
  alerts: RoomAlert[];
  onNavigate: (target: RoomTarget) => void;
  onOpenAlert: (alert: RoomAlert) => void;
}

function StatusCard({ icon: Icon, label, value, tone, onClick }: {
  icon: typeof Server; label: string; value: string;
  tone: 'good' | 'warning' | 'muted'; onClick: () => void;
}) {
  const color = tone === 'good' ? 'bg-accent-50 text-accent-700' : tone === 'warning' ? 'bg-warn-50 text-warn-700' : 'bg-wash text-muted';
  return (
    <button type="button" onClick={onClick} className="group flex min-h-[126px] min-w-0 flex-col items-start rounded-2xl border border-line/80 bg-paper p-3.5 text-left shadow-[0_3px_15px_rgba(15,23,42,0.03)] transition hover:border-accent-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 sm:p-4">
      <span className="flex w-full items-start justify-between gap-2">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${color}`}><Icon className="h-[18px] w-[18px]" strokeWidth={1.9} /></span>
        <ArrowRight className="mt-1 h-4 w-4 text-linestrong transition group-hover:translate-x-0.5 group-hover:text-accent-600 motion-reduce:transform-none" />
      </span>
      <span className="mt-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">{label}</span>
      <span className="mt-1 break-words text-[15px] font-bold leading-tight text-ink">{value}</span>
    </button>
  );
}

function WorkspaceLink({ icon: Icon, title, detail, onClick }: {
  icon: LucideIcon; title: string; detail: string; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="group flex min-h-[68px] w-full items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-600">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-wash text-accent-700 ring-1 ring-wash"><Icon aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.8} /></span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-ink-soft">{title}</span><span className="mt-1 block text-xs text-muted">{detail}</span></span>
      <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-accent-700 motion-reduce:transform-none" />
    </button>
  );
}

export function ControlRoomHome({ data, overviewCheckedAt, overviewError, alerts, onNavigate, onOpenAlert }: Props) {
  const hasBotCheck = overviewCheckedAt != null && !overviewError;
  const botValue = !hasBotCheck ? 'Unknown' : data.botReachable ? 'Reachable' : data.botServerLinked ? 'Not reporting' : 'Not linked';
  const whatsappValue = !hasBotCheck || !data.botReachable || data.connected == null ? 'Unknown' : data.connected ? 'Connected' : 'Disconnected';
  const syncValue = !hasBotCheck || !data.whitelistSync || data.whitelistSync === 'unknown'
    ? 'Unconfirmed' : data.whitelistSync === 'synced' ? 'Up to date' : 'Pending';
  const enabledNumbers = data.users.filter((item) => item.enabled).length;
  const allowedMembers = data.members.filter((item) => item.allowed).length;
  const numberSummary = hasBotCheck ? `${enabledNumbers} enabled ${enabledNumbers === 1 ? 'number' : 'numbers'}` : 'Status unavailable';
  const memberSummary = hasBotCheck ? `${allowedMembers} allowed ${allowedMembers === 1 ? 'member' : 'members'}` : 'Status unavailable';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 px-0.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ZafarFox compact />
          <div className="min-w-0 shrink-0">
            <p className="eyebrow">Control room</p>
            <h1 className="font-display mt-1 text-[28px] font-semibold tracking-tight text-ink sm:text-3xl">Overview</h1>
          </div>
          <ZafarBubble className="hidden max-w-sm flex-1 bg-paper/70 text-xs text-ink-soft md:block">
            I’m checking the service bridge and WhatsApp connection for you.
          </ZafarBubble>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted"><Activity className="h-3.5 w-3.5 text-accent-600" /> {formatCheckedTime(overviewCheckedAt)}</span>
      </div>

      <section aria-label="Service status" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
        <StatusCard icon={Server} label="Service bridge" value={botValue} tone={!hasBotCheck ? 'muted' : data.botReachable ? 'good' : 'warning'} onClick={() => onNavigate({ tab: 'server', page: 'service' })} />
        <StatusCard icon={Smartphone} label="WhatsApp" value={whatsappValue} tone={!hasBotCheck || !data.botReachable || data.connected == null ? 'muted' : data.connected ? 'good' : 'warning'} onClick={() => onNavigate({ tab: 'server', page: 'numbers' })} />
        <StatusCard icon={ListChecks} label="Number list" value={syncValue} tone={syncValue === 'Up to date' ? 'good' : syncValue === 'Pending' ? 'warning' : 'muted'} onClick={() => onNavigate({ tab: 'server', page: 'numbers' })} />
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <section className="rounded-2xl border border-line/80 bg-paper p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-bold text-ink"><Bell className="h-4 w-4 text-accent-600" /> Needs attention</h2>
            <span className="rounded-full bg-wash px-2.5 py-1 text-[11px] font-bold text-muted">{alerts.length}</span>
          </div>
          {alerts.length ? (
            <div className="mt-2 divide-y divide-wash">
              {alerts.slice(0, 3).map((alert) => (
                <button key={alert.id} type="button" onClick={() => onOpenAlert(alert)} className="flex min-h-12 w-full items-center gap-3 py-2.5 text-left">
                  <CircleAlert className={`h-4 w-4 shrink-0 ${alert.level === 'danger' ? 'text-bad-600' : 'text-warn-600'}`} />
                  <span className="min-w-0 flex-1 text-sm font-semibold text-ink-soft">{alert.title}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-accent-50/70 p-3 text-xs text-accent-800"><CheckCircle2 className="h-4 w-4 shrink-0" /> No alerts from available checks.</div>
          )}
          <button type="button" onClick={() => onNavigate({ tab: 'activity', page: 'alerts' })} className="mt-2 inline-flex min-h-10 items-center gap-1 text-xs font-bold text-accent-700 hover:text-accent-900">View alerts <ArrowRight className="h-3.5 w-3.5" /></button>
        </section>
        <section aria-label="Workspace shortcuts" className="rounded-2xl border border-line/80 bg-paper p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-accent-700">Your workspace</p><h2 className="mt-1 text-base font-bold text-ink">Quick access</h2></div><span className="rounded-full bg-wash px-2.5 py-1 text-[10px] font-bold text-muted">OWNER</span></div>
          <div className="mt-2 divide-y divide-wash">
            <WorkspaceLink icon={Smartphone} title="WhatsApp" detail={numberSummary} onClick={() => onNavigate({ tab: 'server', page: 'numbers' })} />
            <WorkspaceLink icon={Users} title="Members" detail={memberSummary} onClick={() => onNavigate({ tab: 'members' })} />
          </div>
        </section>
      </div>
    </div>
  );
}
