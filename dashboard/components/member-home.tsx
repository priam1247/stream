'use client';

import { ArrowRight, BookOpen, Command, Library, LockKeyhole, Smartphone, type LucideIcon } from 'lucide-react';
import type { AuthUser, MemberOverviewPayload } from '@/lib/types';
import { ZafarBubble, ZafarFox } from './zafar-fox';

export type MemberDestination = 'numbers' | 'commands' | 'vault' | 'scribd' | 'status';

interface MemberHomeProps {
  user: AuthUser;
  overview: MemberOverviewPayload;
  statusUnavailable: boolean;
  canAccessScribd: boolean;
  onNavigate: (destination: MemberDestination) => void;
}

function ToolCard({ icon: Icon, title, detail, onClick, locked = false }: {
  icon: LucideIcon;
  title: string;
  detail: string;
  onClick: () => void;
  locked?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} className="group flex min-h-[138px] min-w-0 flex-col items-start rounded-2xl border border-slate-200/80 bg-white p-4 text-left shadow-[0_4px_18px_rgba(15,23,42,0.035)] transition hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 motion-reduce:transform-none">
      <span className="flex w-full items-start justify-between gap-2">
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${locked ? 'bg-slate-100 text-slate-500' : 'bg-teal-50 text-teal-700'}`}><Icon aria-hidden="true" className="h-[19px] w-[19px]" strokeWidth={1.8} /></span>
        <ArrowRight aria-hidden="true" className="mt-1 h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-teal-700 motion-reduce:transform-none" />
      </span>
      <span className="mt-4 text-sm font-bold text-slate-900">{title}</span>
      <span className="mt-1 text-xs leading-5 text-slate-500">{detail}</span>
    </button>
  );
}

export function MemberHome({ user, overview, statusUnavailable, canAccessScribd, onNavigate }: MemberHomeProps) {
  const name = (user.name || '').trim().split(/\s+/)[0];
  const access = statusUnavailable ? 'Unknown' : overview.memberAllowed ? 'Allowed' : 'Restricted';
  const bridge = statusUnavailable || overview.botReachable == null
    ? 'Unknown'
    : overview.botReachable ? 'Reachable' : overview.botServerLinked ? 'Not reporting' : 'Not linked';
  const count = overview.numbers.length;
  const countText = statusUnavailable ? 'Unknown' : `${count} saved`;

  return (
    <div className="space-y-6">
      {!statusUnavailable && overview.memberAllowed && !overview.botEnabledForMembers && !user.isAdmin && (
        <p role="status" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold leading-5 text-amber-800">New number approvals and pairing are paused.</p>
      )}
      <section className="ink relative overflow-hidden bg-gradient-to-br from-white via-[#f4fbf8] to-[#e6f5ef] p-5 sm:p-7">
        <div className="relative flex flex-wrap items-start gap-4 sm:gap-5">
          <ZafarFox />
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Personal workspace</p>
            <h1 className="mt-2 text-2xl text-slate-950 sm:text-3xl">{name ? `Welcome, ${name}` : 'Welcome'}</h1>
            <ZafarBubble className="mt-3 bg-white/70 text-slate-700">
              Your numbers and tools are here. I’ll help you keep your WhatsApp connection on track.
            </ZafarBubble>
            <button type="button" onClick={() => onNavigate('numbers')} className="mt-5 inline-flex min-h-11 items-center gap-2 bg-teal-700 px-4 text-xs font-bold text-white transition hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2">Manage my numbers <ArrowRight aria-hidden="true" className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="relative mt-6 grid grid-cols-3 gap-2 border-t border-teal-100/90 pt-4 sm:max-w-xl sm:gap-4">
          <div className="min-w-0"><p className="eyebrow">My access</p><p className="mt-1 text-sm font-bold text-slate-900">{access}</p></div>
          <div className="min-w-0"><p className="eyebrow">Numbers</p><p className="mt-1 text-sm font-bold text-slate-900">{countText}</p></div>
          <div className="min-w-0"><p className="eyebrow">Service bridge</p><p className="mt-1 text-sm font-bold text-slate-900">{bridge}</p></div>
        </div>
      </section>

      <section aria-label="Your tools">
        <div className="mb-3 flex items-end justify-between gap-3 px-0.5"><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-teal-700">Your space</p><h2 className="mt-1 text-lg font-bold tracking-tight text-slate-950">Your tools</h2></div><button type="button" onClick={() => onNavigate('status')} className="inline-flex min-h-10 items-center gap-1 text-xs font-semibold text-slate-500 hover:text-teal-700">Service status <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></button></div>
        <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4 xl:gap-3">
          <ToolCard icon={Smartphone} title="My numbers" detail={statusUnavailable ? 'Status unavailable' : `${count} saved · manage linking`} onClick={() => onNavigate('numbers')} />
          <ToolCard icon={Command} title="Commands" detail="Browse available commands" onClick={() => onNavigate('commands')} />
          <ToolCard icon={BookOpen} title="Vault" detail="Papers and providers" onClick={() => onNavigate('vault')} />
          <ToolCard icon={canAccessScribd ? Library : LockKeyhole} title="Scribd" detail={statusUnavailable ? 'Access status unavailable' : canAccessScribd ? 'Open the shared library' : 'Access requires approval'} locked={!canAccessScribd} onClick={() => onNavigate('scribd')} />
        </div>
      </section>
    </div>
  );
}
