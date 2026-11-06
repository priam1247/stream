'use client';

import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { MEMBER_COMMANDS } from '@/lib/bot-data';
import { authHeaders } from '@/lib/client-session';

type Policy = { disabled: string[]; sync: 'synced' | 'pending' };

export function MemberCommandControls() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'general' | 'media' | 'vault'>('general');
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/commands', { headers: authHeaders(), cache: 'no-store' });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Could not load command settings.');
      setPolicy({ disabled: json.disabled || [], sync: json.sync });
      setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load command settings.'); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [refresh]);
  const toggle = async (name: string, disabled: boolean) => {
    setBusy(name);
    try {
      const response = await fetch('/api/admin/commands', { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ name, disabled }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Could not update command.');
      setPolicy({ disabled: json.disabled || [], sync: json.sync });
      setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update command.'); }
    finally { setBusy(''); }
  };
  const q = query.trim().toLowerCase().replace(/^\./, '');
  const visible = MEMBER_COMMANDS.filter((command) => q
    ? [command.name, command.summary, ...command.aliases].some((part) => part.toLowerCase().includes(q))
    : command.category === category);
  return <section className="rounded-2xl border border-ink/10 bg-paper p-4 shadow-sm sm:p-5" aria-label="Member command controls">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-sm font-bold text-ink sm:text-base">Member commands</h2><p className="mt-1 text-xs text-ink/60">Switch off commands for members; the owner and configured bot admins keep access. Changes sync to the service on its next check-in.</p></div>
      <span role="status" className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${policy?.sync === 'synced' ? 'bg-accent/10 text-accent' : 'bg-accent/10 text-accent'}`}>{policy?.sync === 'synced' ? 'Service synced' : 'Awaiting service sync'}</span></div>
    {error && <p role="alert" className="mt-3 rounded-lg bg-accent/10 p-3 text-xs text-accent">{error}</p>}
    <div className="relative mt-4"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40"/><input type="search" aria-label="Search member commands" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commands" className="min-h-[44px] w-full rounded-xl border border-ink/10 pl-9 pr-3 text-base outline-none focus:border-accent"/></div>
    {!q && <div className="mt-3 flex gap-2">{(['general', 'media', 'vault'] as const).map((item) => <button key={item} type="button" aria-pressed={category === item} onClick={() => setCategory(item)} className={`min-h-[40px] rounded-full px-4 text-xs font-semibold capitalize ${category === item ? 'bg-accent text-paper' : 'bg-ink/5 text-ink/60'}`}>{item}</button>)}</div>}
    <div className="mt-3 divide-y divide-ink/5 rounded-xl border border-ink/5">{visible.map((command) => {
      const disabled = policy?.disabled.includes(command.name) === true;
      return <div key={command.name} className="flex min-h-[62px] items-center justify-between gap-3 px-3 py-2"><div className="min-w-0"><p className="font-mono text-xs font-bold text-ink/80">.{command.name}</p><p className="mt-1 truncate text-[11px] text-ink/60">{command.summary}</p></div><button type="button" role="switch" aria-label={`Allow .${command.name} for members`} aria-checked={!disabled} disabled={!policy || Boolean(busy)} onClick={() => void toggle(command.name, !disabled)} className={`min-h-[40px] min-w-[72px] rounded-lg px-3 text-xs font-semibold disabled:opacity-50 ${disabled ? 'bg-ink/5 text-ink/60' : 'bg-accent/10 text-accent'}`}>{disabled ? 'Off' : 'On'}</button></div>;
    })}{!visible.length && <p className="p-4 text-center text-xs text-ink/60">No commands found.</p>}</div>
  </section>;
}
