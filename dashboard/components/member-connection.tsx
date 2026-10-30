'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowRight, Check, ChevronRight, Copy, Link2, Loader2, LogOut, Search, ShieldCheck, Smartphone, Unlink } from 'lucide-react';
import { BOT_COMMANDS } from '@/lib/bot-data';
import { authHeaders, performSignOut } from '@/lib/client-session';
import { formatCountdown, maskMemberNumber, normalizeMalawiNumber } from '@/lib/member-link';
import type { AuthUser, MemberOverviewPayload } from '@/lib/types';
import { ZafarRobot } from './zafar-robot';

interface LinkCache {
  number?: string;
  name?: string;
  requestedAt?: number;
  retryAt?: number;
  starting?: boolean;
  requestId?: string;
  code?: string;
  issuedAt?: number;
  expiresInSeconds?: number;
  expired?: boolean;
  hadLink?: boolean;
  linkedAt?: number;
  unlinkRequestId?: string;
  unlinked?: boolean;
}

// The admin catalog groups some distinct commands into one row. Each member
// entry must instead copy the actual command the user searched for.
const MEMBER_COMMANDS = BOT_COMMANDS.filter((command) => !command.ownerOnly).flatMap((command) => {
  if (command.name === 'ping') return [
    { ...command, name: 'ping', aliases: ['p'], category: 'general', summary: 'Check response time' },
    { ...command, name: 'menu', aliases: ['help', 'commands'], category: 'general', summary: 'Show the command menu' },
    { ...command, name: 'info', aliases: ['meta', 'ids', 'lookup'], category: 'general', summary: 'Look up movie or series details' },
    { ...command, name: 'debrid', aliases: ['rd', 'debridstatus'], category: 'general', summary: 'Check debrid status' },
  ];
  if (command.name === 'providers') return [
    { ...command, aliases: ['sources'], category: 'general' },
    { ...command, name: 'moviestatus', aliases: ['moviestats', 'enginestats'], category: 'general', summary: 'Check download engine status' },
  ];
  return [{ ...command, category: ['sticker', 'viewonce'].includes(command.name) ? 'general' : command.category }];
});

const storeKey = (user: AuthUser) => `zafar-member-link-v1:${String(user.email).toLowerCase()}`;
function readCache(key: string): LinkCache {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    if (!raw || typeof raw !== 'object') return {};
    return {
      ...(typeof raw.number === 'string' && /^\d{12}$/.test(raw.number) ? { number: raw.number } : {}),
      ...(typeof raw.name === 'string' ? { name: raw.name.slice(0, 80) } : {}),
      ...(Number.isFinite(raw.requestedAt) ? { requestedAt: raw.requestedAt } : {}),
      ...(Number.isFinite(raw.retryAt) ? { retryAt: raw.retryAt } : {}),
      ...(raw.starting === true ? { starting: true } : {}),
      ...(typeof raw.requestId === 'string' ? { requestId: raw.requestId.slice(0, 100) } : {}),
      ...(typeof raw.code === 'string' && raw.code.length <= 32 ? { code: raw.code } : {}),
      ...(Number.isFinite(raw.issuedAt) ? { issuedAt: raw.issuedAt } : {}),
      ...(Number.isFinite(raw.expiresInSeconds) ? { expiresInSeconds: Math.min(60, Math.max(1, raw.expiresInSeconds)) } : {}),
      ...(raw.expired === true ? { expired: true } : {}),
      ...(raw.hadLink === true ? { hadLink: true } : {}),
      ...(Number.isFinite(raw.linkedAt) ? { linkedAt: raw.linkedAt } : {}),
      ...(typeof raw.unlinkRequestId === 'string' ? { unlinkRequestId: raw.unlinkRequestId.slice(0, 100) } : {}),
      ...(raw.unlinked === true ? { unlinked: true } : {}),
    };
  } catch { return {}; }
}
function writeCache(key: string, value: LinkCache) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* server cooldown still applies */ }
}
function friendlyDate(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return 'Date unavailable';
  try { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)); }
  catch { return 'Date unavailable'; }
}

export function MemberConnection({ user }: { user: AuthUser }) {
  const router = useRouter();
  const key = storeKey(user);
  const [hydrated, setHydrated] = useState(false);
  const [cache, setCache] = useState<LinkCache>({});
  const [name, setName] = useState(user.name || '');
  const [phone, setPhone] = useState('');
  const [overview, setOverview] = useState<MemberOverviewPayload | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [copied, setCopied] = useState('');
  const [search, setSearch] = useState('');
  const checkedNumber = useRef('');
  const codeCard = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const saved = readCache(key);
    setCache(saved);
    setName(saved.name || user.name || '');
    setPhone(saved.number || '');
    setHydrated(true);
  }, [key, user.name]);
  useEffect(() => { if (hydrated) writeCache(key, cache); }, [cache, hydrated, key]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/member/status', { headers: authHeaders(), cache: 'no-store' });
      if (res.status === 401) { router.replace('/login'); return; }
      if (!res.ok) throw new Error('Status unavailable');
      setOverview(await res.json());
      setStatusError(false);
    } catch { setStatusError(true); }
  }, [router]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => { if (!document.hidden) void refreshStatus(); }, 5000);
    const onVisible = () => { if (!document.hidden) { setNow(Date.now()); void refreshStatus(); } };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [refreshStatus]);

  // Adopt an existing connected number, without guessing that approval is a link.
  useEffect(() => {
    if (!hydrated || !overview || cache.number || cache.unlinked) return;
    const current = overview.numbers.find((item) => overview.accounts?.some((a) => a.number === item.number && ['connected', 'connecting', 'paused'].includes(a.state))) || overview.numbers[0];
    if (!current) return;
    setPhone(current.number);
    setCache((old) => ({ ...old, number: current.number, name: old.name || user.name }));
  }, [hydrated, overview, cache.number, cache.unlinked, user.name]);

  const ownsNumber = Boolean(cache.number && overview?.numbers.some((item) => item.number === cache.number));
  const account = ownsNumber && !cache.unlinked ? overview?.accounts?.find((item) => item.number === cache.number) : undefined;
  const reachable = !statusError && overview?.botReachable === true;
  const accountIsLinked = account?.state === 'connected' || account?.state === 'connecting' || account?.state === 'paused';
  const isLinked = !cache.unlinked && (accountIsLinked || (ownsNumber && Boolean(cache.unlinkRequestId)) || (!reachable && ownsNumber && cache.hadLink === true));
  const disconnected = reachable && account?.state === 'logged_out';

  useEffect(() => {
    if (!account || !accountIsLinked || !cache.number) return;
    setCache((old) => {
      const linkedAt = account.linkedAt || old.linkedAt;
      if (old.hadLink && !old.code && !old.starting && !old.requestId && old.linkedAt === linkedAt) return old;
      return { ...old, hadLink: true, linkedAt, code: undefined, requestId: undefined, starting: false, expired: false, unlinked: false };
    });
    setNotice(null);
  }, [account, accountIsLinked, cache.number]);

  useEffect(() => {
    if (!cache.code || !cache.issuedAt) return;
    if (now >= cache.issuedAt + (cache.expiresInSeconds || 60) * 1000) {
      setCache((old) => ({ ...old, code: undefined, expired: true }));
    }
  }, [cache.code, cache.issuedAt, cache.expiresInSeconds, now]);

  // A fresh device can recover the server's cooldown and an accepted queued or
  // direct request. All code lookups are still authenticated and owner-scoped.
  useEffect(() => {
    if (!hydrated || !cache.number || !ownsNumber || cache.starting || isLinked || checkedNumber.current === cache.number) return;
    const number = cache.number;
    checkedNumber.current = number;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/member/pair?number=${encodeURIComponent(number)}`, { headers: authHeaders(), cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setCache((old) => old.number !== number ? old : {
          ...old, retryAt: Number(json.retryAt) || old.retryAt,
          ...(!old.code && !old.expired && json.requestId ? { starting: true, requestId: String(json.requestId), requestedAt: old.requestedAt || Math.max(0, Number(json.retryAt) - 180_000) || Date.now() } : {}),
        });
      } catch { /* local countdown remains available */ }
    })();
    return () => { cancelled = true; };
  }, [hydrated, cache.number, cache.starting, cache.code, cache.expired, ownsNumber, isLinked]);

  useEffect(() => {
    if (!hydrated || !cache.starting || !cache.number || isLinked || cache.unlinkRequestId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const url = cache.requestId
          ? `/api/member/pair?requestId=${encodeURIComponent(cache.requestId)}`
          : `/api/member/pair?number=${encodeURIComponent(cache.number!)}`;
        const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          // A refresh can occur before the number registration finishes. Give
          // the in-flight request time to become visible before reporting it.
          if (!cache.requestId && res.status === 404 && Date.now() - (cache.requestedAt || 0) < 15_000) {
            timer = window.setTimeout(poll, 2000); return;
          }
          setCache((old) => ({ ...old, starting: false, requestId: undefined, expired: res.status === 410 || old.expired }));
          setNotice({ text: res.status === 410 ? 'Code expired, get a new one.' : (json.error || 'Could not get a code.'), bad: res.status !== 410 });
          return;
        }
        if (!cache.requestId) {
          if (json.requestId) {
            setCache((old) => ({ ...old, requestId: String(json.requestId), retryAt: Number(json.retryAt) || old.retryAt }));
            return;
          }
          if (Date.now() - (cache.requestedAt || 0) < 15_000 ||
            (Number(json.retryAt) > Date.now() && Date.now() - (cache.requestedAt || 0) < 70_000)) {
            if (Number(json.retryAt) > 0) setCache((old) => ({ ...old, retryAt: Number(json.retryAt) }));
            timer = window.setTimeout(poll, 2000); return;
          }
          setCache((old) => ({ ...old, starting: false, retryAt: Number(json.retryAt) || 0 }));
          setNotice({ text: 'The code request could not be recovered. Please try again.', bad: true });
          return;
        }
        if (json.pending) { timer = window.setTimeout(poll, 2000); return; }
        if (json.code) {
          setCache((old) => old.hadLink && !old.unlinked ? old : ({ ...old, code: String(json.code), issuedAt: Math.min(Number(json.issuedAt) || Date.now(), Date.now()),
            expiresInSeconds: Math.min(60, Math.max(1, Number(json.expiresInSeconds) || 60)), starting: false, requestId: undefined, expired: false }));
          setNotice(null);
          return;
        }
        throw new Error('The service did not return a code.');
      } catch (err) {
        if (cancelled) return;
        if (Date.now() - (cache.requestedAt || Date.now()) < 90_000) { timer = window.setTimeout(poll, 2500); return; }
        setCache((old) => ({ ...old, starting: false, requestId: undefined }));
        setNotice({ text: err instanceof Error ? err.message : 'Could not get a code.', bad: true });
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [hydrated, cache.starting, cache.number, cache.requestId, cache.requestedAt, cache.unlinkRequestId, isLinked]);

  const finishUnlink = useCallback((numbers: MemberOverviewPayload['numbers']) => {
    setCache((old) => ({ ...old, hadLink: false, linkedAt: undefined, unlinked: true, unlinkRequestId: undefined,
      code: undefined, starting: false, requestId: undefined, expired: false }));
    setOverview((old) => old ? { ...old, numbers } : old);
    setConfirmUnlink(false);
    setNotice({ text: 'Your number has been unlinked.' });
  }, []);

  useEffect(() => {
    if (!hydrated || !cache.unlinkRequestId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/member/unlink?requestId=${encodeURIComponent(cache.unlinkRequestId!)}`, { headers: authHeaders(), cache: 'no-store' });
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 401) { router.replace('/login'); return; }
        // A temporary dashboard failure does not cancel a logout already sent
        // to WhatsApp. Keep its ID across refreshes until the result is known.
        if (res.status >= 500 && res.status !== 504 && !(res.status === 502 && json.error === 'The service did not confirm the unlink.')) {
          setNotice({ text: 'Still checking your unlink request.' });
          timer = window.setTimeout(poll, 5000); return;
        }
        if (!res.ok) throw new Error(json.error || 'Could not unlink your number.');
        if (json.pending) { timer = window.setTimeout(poll, 2000); return; }
        finishUnlink(Array.isArray(json.numbers) ? json.numbers : []);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof TypeError) {
          setNotice({ text: 'Connection interrupted. Still checking your unlink request.' });
          timer = window.setTimeout(poll, 5000); return;
        }
        setCache((old) => ({ ...old, unlinkRequestId: undefined }));
        setNotice({ text: err instanceof Error ? err.message : 'Could not unlink your number.', bad: true });
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [hydrated, cache.unlinkRequestId, finishUnlink, router]);

  const requestCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || cache.starting || cache.unlinkRequestId) return;
    const cleanName = name.trim();
    if (!cleanName) { setNotice({ text: 'Enter your name.', bad: true }); return; }
    const parsed = normalizeMalawiNumber(phone);
    if (!parsed.number) { setNotice({ text: parsed.error || 'Enter a valid phone number.', bad: true }); return; }
    const number = parsed.number;
    if (cache.number === number && (cache.retryAt || 0) > Date.now()) return;
    setBusy(true); setNotice(null);
    let started: LinkCache | null = null;
    try {
      const add = await fetch('/api/member/numbers', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ number, label: cleanName }) });
      const added = await add.json();
      if (!add.ok) throw new Error(added.error || 'Could not save your number.');
      setOverview((old) => old ? { ...old, numbers: added.numbers || [] } : old);
      const requestedAt = Date.now();
      setNow(requestedAt);
      started = { ...cache, number, name: cleanName, requestedAt, retryAt: requestedAt + 180_000,
        starting: true, requestId: undefined, code: undefined, expired: false, unlinked: false, hadLink: false };
      // Store before the slow request so refresh/app switching can recover it.
      writeCache(key, started); setCache(started); setPhone(number);
      const res = await fetch('/api/member/pair', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ number }) });
      const json = await res.json();
      setNow(Date.now());
      if (!res.ok) {
        setCache((old) => ({ ...old, starting: false, retryAt: Number(json.retryAt) || 0 }));
        throw new Error(json.error || 'Could not request a code.');
      }
      if (json.pending && json.requestId) {
        setCache((old) => ({ ...old, starting: true, requestId: String(json.requestId), retryAt: Number(json.retryAt) || old.retryAt }));
      } else if (json.code) {
        setCache((old) => old.hadLink && !old.unlinked ? old : ({ ...old, starting: false, code: String(json.code), issuedAt: Math.min(Number(json.issuedAt) || Date.now(), Date.now()),
          expiresInSeconds: Math.min(60, Math.max(1, Number(json.expiresInSeconds) || 60)), retryAt: Number(json.retryAt) || old.retryAt }));
      } else { throw new Error('The service did not return a code.'); }
    } catch (err) {
      // Unknown network outcome is recoverable via the authenticated GET.
      if (started && err instanceof TypeError) setNotice({ text: 'Checking whether your code request reached the service.' });
      else { if (started) setCache((old) => ({ ...old, starting: false })); setNotice({ text: err instanceof Error ? err.message : 'Could not request a code.', bad: true }); }
    } finally { setBusy(false); }
  };

  const unlink = async () => {
    if (!cache.number || busy || cache.unlinkRequestId) return;
    setBusy(true); setNotice(null);
    try {
      const res = await fetch('/api/member/unlink', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ number: cache.number }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not unlink your number.');
      if (json.pending && json.requestId) {
        setCache((old) => ({ ...old, unlinkRequestId: String(json.requestId) }));
        setConfirmUnlink(false);
      } else finishUnlink(Array.isArray(json.numbers) ? json.numbers : []);
    } catch (err) { setNotice({ text: err instanceof Error ? err.message : 'Could not unlink your number.', bad: true }); }
    finally { setBusy(false); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); window.setTimeout(() => setCopied(''), 1800); }
    catch { setNotice({ text: 'Copy is unavailable. Select the text and copy it instead.', bad: true }); }
  };
  const signOut = async () => { try { localStorage.removeItem(key); } catch { /* ignore */ } await performSignOut(); router.replace('/login'); };
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^\./, '');
    return MEMBER_COMMANDS.filter((cmd) => !q || [cmd.name, cmd.summary, ...cmd.aliases].some((part) => part.toLowerCase().includes(q)));
  }, [search]);

  const cooldownMs = Math.min(180_000, Math.max(0, (cache.retryAt || 0) - now));
  const codeMs = cache.code && cache.issuedAt ? Math.min((cache.expiresInSeconds || 60) * 1000, Math.max(0, cache.issuedAt + (cache.expiresInSeconds || 60) * 1000 - now)) : 0;
  const codeVisible = Boolean(cache.code && codeMs > 0);
  useEffect(() => {
    if (codeVisible) codeCard.current?.scrollIntoView?.({ behavior: 'auto', block: 'center' });
  }, [codeVisible]);
  const canRequest = Boolean(overview?.memberAllowed && overview.botEnabledForMembers);
  const loading = !hydrated || (!overview && !statusError);
  const headingName = (name.trim() || user.name || '').split(/\s+/)[0];

  return (
    <div className="min-h-screen bg-[#f5f9f7] text-slate-900">
      <header className="border-b border-[#e2eee9] bg-white/90">
        <div className="mx-auto flex h-16 w-full max-w-[500px] items-center justify-between px-4">
          <div className="flex items-center gap-2.5"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-700 text-sm font-black text-white">z</span><span className="text-[15px] font-extrabold tracking-tight">zAfAr</span></div>
          <button type="button" onClick={() => void signOut()} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-slate-500 hover:text-teal-800"><LogOut className="h-4 w-4" /> Sign out</button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[500px] px-4 pb-12 pt-7">
        {loading ? <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading your connection…</div> : <>
          {isLinked ? <>
            <div className="mb-5"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-teal-700">Your connection</p><h1 className="mt-2 text-[25px] font-bold tracking-tight">You’re linked, {headingName || 'welcome'}.</h1><p className="mt-1 text-xs leading-5 text-slate-500">Your WhatsApp number is ready to use.</p></div>
            <section aria-label="Linked number" className="overflow-hidden rounded-[22px] border border-[#d9ebe4] bg-white shadow-[0_12px_38px_-28px_rgba(15,80,65,.35)]">
              <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-4">
                <div className="flex min-w-0 gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-teal-50 text-teal-700"><Smartphone className="h-5 w-5" /></div><div><p className="text-[11px] font-medium text-slate-500">WhatsApp number</p><p className="mt-1 font-mono text-[15px] font-bold tracking-tight">{maskMemberNumber(cache.number || '')}</p></div></div>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[10px] font-bold ${reachable && account?.state === 'connected' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}><span className={`h-1.5 w-1.5 rounded-full ${reachable && account?.state === 'connected' ? 'bg-emerald-500' : 'bg-slate-400'}`} />{reachable && account?.state === 'connected' ? 'Bot active' : 'Bot offline'}</span>
              </div>
              <div className="flex items-center justify-between gap-2 px-4 py-3"><p className="text-xs text-slate-500">Linked <span className="font-semibold text-slate-700">{friendlyDate(account?.linkedAt || cache.linkedAt)}</span></p><button type="button" disabled={busy || Boolean(cache.unlinkRequestId)} onClick={() => setConfirmUnlink(true)} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-slate-500 hover:text-rose-700 disabled:opacity-50"><Unlink className="h-3.5 w-3.5" />{cache.unlinkRequestId ? 'Unlinking…' : 'Unlink'}</button></div>
            </section>
            {confirmUnlink && <div role="alertdialog" aria-modal="true" aria-labelledby="unlink-title" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"><div className="w-full max-w-[360px] rounded-2xl bg-white p-5 shadow-xl"><h2 id="unlink-title" className="text-base font-bold">Unlink this number?</h2><p className="mt-2 text-xs leading-5 text-slate-600">The WhatsApp session will be disconnected. You can link it again later.</p><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setConfirmUnlink(false)} className="min-h-[44px] rounded-xl px-4 text-xs font-semibold text-slate-600">Cancel</button><button type="button" disabled={busy} onClick={() => void unlink()} className="min-h-[44px] rounded-xl bg-rose-700 px-4 text-xs font-semibold text-white disabled:opacity-50">{busy ? 'Unlinking…' : 'Yes, unlink'}</button></div></div></div>}
            <section className="mt-8" aria-label="Commands"><div className="flex items-end justify-between gap-2"><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-teal-700">Explore</p><h2 className="mt-1 text-lg font-bold tracking-tight">Commands</h2></div><span className="pb-1 text-[11px] text-slate-400">Tap to copy</span></div>
              <div className="relative mt-3"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input type="search" aria-label="Search commands" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search commands" className="min-h-[46px] w-full rounded-xl border border-slate-200 bg-white pl-10 pr-3 text-base text-slate-900 outline-none focus:border-teal-600" /></div>
              {matches.length === 0 ? <p className="py-6 text-center text-xs text-slate-500">No commands found.</p> : (['media', 'vault', 'general'] as const).map((category) => {
                const items = matches.filter((cmd) => cmd.category === category);
                if (!items.length) return null;
                return <div key={category} className="mt-5"><h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">{category === 'media' ? 'Media' : category === 'vault' ? 'Vault' : 'General'}</h3><div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">{items.map((cmd) => <button type="button" key={cmd.name} onClick={() => void copy(`.${cmd.name}`)} aria-label={`Copy .${cmd.name} command`} className="flex min-h-[58px] w-full items-center gap-3 border-b border-slate-100 px-3.5 py-2 text-left last:border-0 hover:bg-teal-50/50"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 font-mono text-xs font-bold text-teal-700">›_</span><span className="min-w-0 flex-1"><span className="block font-mono text-xs font-bold text-slate-800">.{cmd.name}</span><span className="mt-0.5 block truncate text-[11px] text-slate-500">{cmd.summary}</span></span>{copied === `.${cmd.name}` ? <Check className="h-4 w-4 shrink-0 text-teal-600" /> : <Copy className="h-4 w-4 shrink-0 text-slate-400" />}</button>)}</div></div>;
              })}
            </section>
          </> : <>
            <div className="mb-4"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-teal-700">Your WhatsApp connection</p><h1 className="mt-2 text-[25px] font-bold tracking-tight">{disconnected ? 'Your number got disconnected' : headingName ? `Welcome, ${headingName}` : 'Welcome to zAfAr'}</h1><p className="mt-1 text-xs leading-5 text-slate-500">{disconnected ? 'Let’s get your number connected again.' : 'One quick step to get started.'}</p></div>
            <div className="mb-5 flex items-center gap-3 rounded-[20px] border border-teal-100 bg-[#eaf8f2] px-3 py-2"><ZafarRobot /><div className="min-w-0"><p className="text-xs font-bold text-teal-900">{disconnected ? 'I’m ready when you are.' : 'Hi, I’m here to help.'}</p><p className="mt-1 text-xs leading-5 text-teal-800/80">{disconnected ? 'Get a new code to reconnect your number.' : 'Let’s link your number to the zAfAr WhatsApp bot.'}</p></div></div>
            <section className="rounded-[22px] border border-[#dfeae5] bg-white p-4 shadow-[0_12px_38px_-28px_rgba(15,80,65,.3)]"><div className="mb-4 flex items-start gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><Link2 className="h-4 w-4" /></div><div><h2 className="text-sm font-bold">Link your number</h2><p className="mt-1 text-[11px] text-slate-500">Enter your details to get a WhatsApp code.</p></div></div>
              {!overview?.memberAllowed && <p className="mb-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-800">Your account access has been restricted.</p>}
              {overview?.memberAllowed && !overview.botEnabledForMembers && <p className="mb-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">New number linking is currently paused.</p>}
              {statusError && <p className="mb-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">Connection status is unavailable. Please try again.</p>}
              <form onSubmit={requestCode} className="space-y-3.5">
                <div><label htmlFor="link-name" className="mb-1.5 block text-xs font-semibold text-slate-700">Name</label><input id="link-name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} disabled={busy || cache.starting || Boolean(cache.unlinkRequestId) || codeVisible} placeholder="Your name" className="min-h-[48px] w-full rounded-xl border border-slate-200 bg-white px-3.5 text-base outline-none placeholder:text-slate-400 focus:border-teal-600 disabled:bg-slate-50" /></div>
                <div><label htmlFor="link-phone" className="mb-1.5 block text-xs font-semibold text-slate-700">Phone number</label><input id="link-phone" type="tel" inputMode="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} disabled={busy || cache.starting || Boolean(cache.unlinkRequestId) || codeVisible} placeholder="099 123 4567" className="min-h-[48px] w-full rounded-xl border border-slate-200 bg-white px-3.5 text-base outline-none placeholder:text-slate-400 focus:border-teal-600 disabled:bg-slate-50" /><p className="mt-1.5 text-[11px] text-slate-400">Malawi +265 · spaces and the leading zero are fine</p></div>
                <button type="submit" disabled={!canRequest || busy || Boolean(cache.starting) || Boolean(cache.unlinkRequestId) || cooldownMs > 0} className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-teal-700 px-4 text-xs font-bold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{cache.unlinkRequestId ? <><Loader2 className="h-4 w-4 animate-spin" /> Unlinking…</> : busy || cache.starting ? <><Loader2 className="h-4 w-4 animate-spin" /> Requesting code…</> : cooldownMs > 0 ? <>Resend available in {formatCountdown(cooldownMs)}</> : <>{disconnected || cache.expired ? 'Get new code' : 'Get code'} <ArrowRight className="h-4 w-4" /></>}</button>
                {cooldownMs > 0 && <p className="text-center text-[11px] text-slate-500">Take your time. You can request another code when the timer ends.</p>}
              </form>
            </section>
            {(codeVisible || cache.expired || cache.starting) && <section ref={codeCard} aria-label="WhatsApp linking code" className="mt-4 rounded-[22px] border border-teal-200 bg-white p-4 shadow-sm"><div className="flex items-center justify-between gap-2"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-teal-700">WhatsApp linking code</p><h2 className="mt-1 text-sm font-bold">{cache.expired ? 'Code expired, get a new one' : cache.starting ? 'Getting your code' : 'Your code is ready'}</h2></div><ShieldCheck className="h-5 w-5 text-teal-600" /></div>
              {codeVisible && <><div className="mt-4 flex items-center justify-between gap-2 rounded-xl border border-teal-100 bg-teal-50 px-3.5 py-3"><code className="min-w-0 break-all font-mono text-[24px] font-extrabold tracking-[.12em] text-teal-950">{cache.code}</code><button type="button" onClick={() => void copy(cache.code!)} className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-bold text-teal-800 shadow-sm">{copied === cache.code ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied === cache.code ? 'Copied' : 'Copy'}</button></div><p className="mt-2 text-[11px] text-slate-500">Code valid for {formatCountdown(codeMs)}. Resend timer is separate.</p></>}
              {!cache.starting && <div className="mt-4 border-t border-slate-100 pt-3"><p className="text-xs font-semibold text-slate-700">On your phone</p><p className="mt-2 flex flex-wrap items-center gap-1 text-xs leading-5 text-slate-600">WhatsApp <ChevronRight className="h-3 w-3" /> Linked devices <ChevronRight className="h-3 w-3" /> Link with phone number</p><p className="mt-2 text-[11px] text-slate-400">This page updates automatically once connected.</p></div>}
            </section>}
          </>}
          {notice && <div role={notice.bad ? 'alert' : 'status'} className={`mt-4 flex items-start gap-2 rounded-xl border px-3.5 py-3 text-xs leading-5 ${notice.bad ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-teal-100 bg-teal-50 text-teal-800'}`}><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{notice.text}</div>}
        </>}
      </main>
    </div>
  );
}
