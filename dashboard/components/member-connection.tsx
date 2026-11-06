'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowRight, Check, ChevronRight, Copy, LayoutDashboard, Link2, Loader2, LogOut, MessageSquare, ShieldCheck } from 'lucide-react';
import { authHeaders, performSignOut } from '@/lib/client-session';
import { formatCountdown, normalizeMalawiNumber } from '@/lib/member-link';
import type { AuthUser, MemberOverviewPayload } from '@/lib/types';
import { ZafarFox } from './zafar-fox';
import { MemberWorkspace } from './member-workspace';

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
  relinking?: boolean;
}

const storeKey = (user: AuthUser) => `zafar-member-link-v1:${String(user.email).toLowerCase()}`;
const exploreKey = (user: AuthUser) => `zafar-member-explore-v1:${String(user.email).toLowerCase()}`;
const EMPTY_OVERVIEW: MemberOverviewPayload = { ok: true, adminEmail: '', memberAllowed: true, botEnabledForMembers: false, botServerLinked: false, botConnected: null, botNumber: null, numbers: [] };
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
      ...(raw.relinking === true ? { relinking: true } : {}),
    };
  } catch { return {}; }
}
function writeCache(key: string, value: LinkCache) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* server cooldown still applies */ }
}

export function MemberConnection({ user }: { user: AuthUser }) {
  const router = useRouter();
  const key = storeKey(user);
  const [explore, setExplore] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [cache, setCache] = useState<LinkCache>({});
  const [name, setName] = useState(user.name || '');
  const [phone, setPhone] = useState('');
  const [overview, setOverview] = useState<MemberOverviewPayload | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [removingPending, setRemovingPending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [copied, setCopied] = useState('');
  const [supportUnread, setSupportUnread] = useState(0);
  const checkedNumber = useRef('');
  const statusSequence = useRef(0);
  const statusApplied = useRef(0);
  const statusEpoch = useRef(0);
  const codeCard = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const saved = readCache(key);
    setCache(saved);
    setName(saved.name || user.name || '');
    setPhone(saved.number || '');
    try { setExplore(localStorage.getItem(exploreKey(user)) === '1'); } catch { setExplore(false); }
    setHydrated(true);
  }, [key, user]);
  const applyExplore = (next: boolean) => {
    setExplore(next);
    try { if (next) localStorage.setItem(exploreKey(user), '1'); else localStorage.removeItem(exploreKey(user)); } catch { /* storage unavailable */ }
  };
  useEffect(() => { if (hydrated) writeCache(key, cache); }, [cache, hydrated, key]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshStatus = useCallback(async () => {
    const sequence = ++statusSequence.current;
    const epoch = statusEpoch.current;
    const current = () => epoch === statusEpoch.current && sequence > statusApplied.current;
    try {
      const res = await fetch('/api/member/status', { headers: authHeaders(), cache: 'no-store' });
      if (!current()) return;
      if (res.status === 401) { statusApplied.current = sequence; router.replace('/login'); return; }
      if (!res.ok) throw new Error('Status unavailable');
      const next = await res.json();
      if (!current()) return;
      statusApplied.current = sequence;
      setOverview(next);
      setStatusError(false);
    } catch { if (current()) { statusApplied.current = sequence; setStatusError(true); } }
  }, [router]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => { if (!document.hidden) void refreshStatus(); }, 5000);
    const onVisible = () => { if (!document.hidden) { setNow(Date.now()); void refreshStatus(); } };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [refreshStatus]);

  useEffect(() => {
    const check = async () => { try { const response = await fetch('/api/support?summary=1', { headers: authHeaders(), cache: 'no-store' }); if (response.ok) { const json = await response.json(); setSupportUnread(Number(json.unread) || 0); } } catch { /* keep the last known count */ } };
    void check(); const timer = window.setInterval(() => void check(), 15000); return () => window.clearInterval(timer);
  }, []);

  // Adopt an existing connected number, without guessing that approval is a link.
  useEffect(() => {
    if (!hydrated || !overview) return;
    const confirmed = overview.numbers.find((item) => overview.confirmedLinks?.some((link) => link.number === item.number));
    // A later link on another device may replace an earlier explicit unlink.
    if (cache.unlinked && !confirmed) return;
    if (!cache.unlinked && cache.number && overview.numbers.some((item) => item.number === cache.number)) return;
    const current = confirmed ||
      overview.numbers.find((item) => overview.accounts?.some((a) => a.number === item.number && a.sessionId && ['connected', 'connecting', 'paused'].includes(a.state))) || overview.numbers[0];
    if (!current) return;
    setPhone(current.number);
    setCache((old) => ({ ...old, number: current.number, name: old.name || user.name, unlinked: false }));
  }, [hydrated, overview, cache.number, cache.unlinked, user.name]);

  const ownsNumber = Boolean(cache.number && overview?.numbers.some((item) => item.number === cache.number));
  const account = ownsNumber && !cache.unlinked ? overview?.accounts?.find((item) => item.number === cache.number) : undefined;
  const reachable = !statusError && overview?.botReachable === true;
  const confirmed = ownsNumber ? overview?.confirmedLinks?.find((item) => item.number === cache.number) : undefined;
  const accountIsLinked = Boolean(account?.sessionId) && (account?.state === 'connected' || account?.state === 'connecting' || account?.state === 'paused');
  const pendingNumber = overview?.numbers.find((item) => item.number === cache.number && item.approval === 'pending');
  // A saved number, approval or a code is not proof of linking. The server
  // remembers only claim-matched, completed sessions across devices/outages.
  const isLinked = !cache.unlinked && !cache.relinking && ownsNumber && (accountIsLinked || Boolean(confirmed) || Boolean(cache.unlinkRequestId));
  const disconnected = reachable && account?.state === 'logged_out';

  useEffect(() => {
    if (!account || !accountIsLinked || !cache.number) return;
    setCache((old) => {
      const linkedAt = account.linkedAt || old.linkedAt;
      if (old.hadLink && !old.relinking && !old.code && !old.starting && !old.requestId && old.linkedAt === linkedAt) return old;
      return { ...old, hadLink: true, linkedAt, code: undefined, requestId: undefined, starting: false, expired: false, unlinked: false, relinking: false };
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
          setCache((old) => old.hadLink && !old.unlinked && !old.relinking ? old : ({ ...old, code: String(json.code), issuedAt: Math.min(Number(json.issuedAt) || Date.now(), Date.now()),
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
    statusEpoch.current++;
    setCache((old) => ({ ...old, hadLink: false, linkedAt: undefined, unlinked: true, unlinkRequestId: undefined,
      code: undefined, starting: false, requestId: undefined, expired: false, relinking: false }));
    setOverview((old) => old ? { ...old, numbers } : old);
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
        setCache((old) => old.hadLink && !old.unlinked && !old.relinking ? old : ({ ...old, starting: false, code: String(json.code), issuedAt: Math.min(Number(json.issuedAt) || Date.now(), Date.now()),
          expiresInSeconds: Math.min(60, Math.max(1, Number(json.expiresInSeconds) || 60)), retryAt: Number(json.retryAt) || old.retryAt }));
      } else { throw new Error('The service did not return a code.'); }
    } catch (err) {
      // Unknown network outcome is recoverable via the authenticated GET.
      if (started && err instanceof TypeError) setNotice({ text: 'Checking whether your code request reached the service.' });
      else { if (started) setCache((old) => ({ ...old, starting: false })); setNotice({ text: err instanceof Error ? err.message : 'Could not request a code.', bad: true }); }
    } finally { setBusy(false); }
  };

  const cancelPending = async () => {
    if (!cache.number || busy || cache.starting || cache.unlinkRequestId) return;
    setBusy(true); setRemovingPending(true); setNotice(null);
    try {
      const res = await fetch('/api/member/cancel-pending', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ number: cache.number }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not remove this request.');
      statusEpoch.current++;
      setOverview((old) => old ? { ...old, numbers: Array.isArray(json.numbers) ? json.numbers : [] } : old);
      checkedNumber.current = '';
      setCache({}); setPhone('');
      setNotice({ text: 'Pending request removed. You can enter another number.' });
    } catch (err) { setNotice({ text: err instanceof Error ? err.message : 'Could not remove this request.', bad: true }); }
    finally { setBusy(false); setRemovingPending(false); }
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
      } else finishUnlink(Array.isArray(json.numbers) ? json.numbers : []);
    } catch (err) { setNotice({ text: err instanceof Error ? err.message : 'Could not unlink your number.', bad: true }); }
    finally { setBusy(false); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(text); window.setTimeout(() => setCopied(''), 1800); }
    catch { setNotice({ text: 'Copy is unavailable. Select the text and copy it instead.', bad: true }); }
  };
  const signOut = async () => { try { localStorage.removeItem(key); localStorage.removeItem(exploreKey(user)); } catch { /* ignore */ } await performSignOut(); router.replace('/login'); };

  const cooldownMs = Math.min(180_000, Math.max(0, (cache.retryAt || 0) - now));
  const codeMs = cache.code && cache.issuedAt ? Math.min((cache.expiresInSeconds || 60) * 1000, Math.max(0, cache.issuedAt + (cache.expiresInSeconds || 60) * 1000 - now)) : 0;
  const codeVisible = Boolean(cache.code && codeMs > 0);
  useEffect(() => {
    if (codeVisible) codeCard.current?.scrollIntoView?.({ behavior: 'auto', block: 'center' });
  }, [codeVisible]);
  const canRequest = Boolean(overview?.memberAllowed && overview.botEnabledForMembers);
  const loading = !hydrated || (!overview && !statusError);
  const headingName = (name.trim() || user.name || '').split(/\s+/)[0];

  if (!loading && isLinked && overview && cache.number) {
    return <MemberWorkspace user={user} overview={overview} number={cache.number} account={account}
      linkedAt={account?.linkedAt || confirmed?.linkedAt} statusError={statusError} busy={busy}
      unlinking={Boolean(cache.unlinkRequestId)} supportUnread={supportUnread} notice={notice}
      onRefresh={() => void refreshStatus()} onReconnect={() => {
        checkedNumber.current = '';
        setNotice(null);
        setCache((old) => ({ ...old, relinking: true, unlinked: false }));
      }} onUnlink={() => void unlink()} onSignOut={signOut} />;
  }

  if (!loading && explore) {
    return <MemberWorkspace user={user} overview={overview ?? EMPTY_OVERVIEW} statusError={statusError} busy={busy}
      unlinking={false} supportUnread={supportUnread} notice={notice}
      onRefresh={() => void refreshStatus()} onReconnect={() => applyExplore(false)} onUnlink={() => undefined}
      onSignOut={signOut} onLinkNumber={() => applyExplore(false)} />;
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-ink/10 bg-paper/90">
        <div className="mx-auto flex h-16 w-full max-w-[500px] items-center justify-between px-4 lg:h-[72px] lg:max-w-5xl lg:px-8">
          <div className="flex items-center gap-2.5"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-paper"><ZafarFox compact /></span><span className="text-[15px] font-extrabold tracking-tight">zAfAr</span></div>
          <button type="button" onClick={() => void signOut()} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-ink/60 hover:text-accent"><LogOut className="h-4 w-4" /> Sign out</button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[500px] px-4 pb-14 pt-6 lg:max-w-5xl lg:px-8 lg:pt-10">
        {loading ? <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-ink/60"><Loader2 className="h-4 w-4 animate-spin" /> Loading your connection…</div> : (
          <div className="flex flex-col lg:grid lg:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] lg:items-start lg:gap-10">
            <div className="order-1 lg:col-start-1 lg:row-start-1">
              {cache.relinking && confirmed && <button type="button" onClick={() => setCache((old) => ({ ...old, relinking: false }))} className="mb-4 min-h-10 text-xs font-semibold text-accent">← Back to workspace</button>}
              <div className="mb-4"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-accent">Your WhatsApp connection</p><h1 className="font-display mt-2 text-[26px] font-semibold tracking-tight lg:text-[36px] lg:leading-[1.02]">{disconnected ? 'Your number got disconnected' : headingName ? `Welcome, ${headingName}` : 'Welcome to zAfAr'}</h1><p className="mt-1.5 text-xs leading-5 text-ink/60 sm:text-sm">{disconnected ? 'Let’s get your number connected again.' : 'One quick step to get started.'}</p></div>
              <div className="mb-5 flex items-start gap-3 rounded-2xl bg-accent/10 px-4 py-3"><div className="mt-0.5 shrink-0"><ZafarFox compact /></div><div className="min-w-0"><p className="text-xs font-bold text-accent">{disconnected ? 'I’m ready when you are.' : 'Hi, I’m here to help.'}</p><p className="mt-1 text-xs leading-5 text-accent/80">{disconnected ? 'Get a new code to reconnect your number.' : 'Link your number and run the zAfAr WhatsApp bot from your own phone.'}</p></div></div>
            </div>
            <aside className="order-2 mb-6 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:mb-0 lg:pt-1">
              <div className="rounded-[22px] border border-ink bg-ink p-5 text-paper shadow-card sm:p-6">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-paper"><LayoutDashboard className="h-5 w-5" /></span>
                <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.18em] text-paper/50">No number needed</p>
                <h2 className="mt-1.5 text-[23px] font-extrabold leading-[1.08] tracking-tight">Visit the dashboard<br />before you link.</h2>
                <p className="mt-2.5 text-xs leading-5 text-paper/70">The dashboard is open to every member — linking just switches the bot on for you, and you can do it anytime from Settings.</p>
                <ul className="mt-5 space-y-2.5 border-t border-paper/10 pt-5">
                  {['Browse every WhatsApp command', 'See your activity once you link', 'Link in one code, right from Settings'].map((item) => <li key={item} className="flex items-start gap-2 text-xs leading-5 text-paper/85"><Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" /><span className="min-w-0">{item}</span></li>)}
                </ul>
                <button type="button" onClick={() => applyExplore(true)} className="mt-6 flex min-h-[50px] w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-bold text-paper transition hover:bg-accent/90">Open the dashboard <ArrowRight className="h-4 w-4" /></button>
              </div>
            </aside>
            <div className="order-3 lg:col-start-1 lg:row-start-2">
            <section className="rounded-[22px] border border-ink/10 bg-paper p-4 shadow-card"><div className="mb-4 flex items-start gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><Link2 className="h-4 w-4" /></div><div><h2 className="text-sm font-bold">Link your number</h2><p className="mt-1 text-[11px] text-ink/60">Enter your details to get a WhatsApp code.</p></div></div>
              {!overview?.memberAllowed && <p className="mb-3 rounded-xl bg-accent/10 p-3 text-xs text-accent">Your account access has been restricted.</p>}
              {overview?.memberAllowed && !overview.botEnabledForMembers && <p className="mb-3 rounded-xl bg-accent/10 p-3 text-xs text-accent">New number linking is currently paused.</p>}
              {statusError && <p className="mb-3 rounded-xl bg-accent/10 p-3 text-xs text-accent">Connection status is unavailable. Please try again.</p>}
              <form onSubmit={requestCode} className="space-y-3.5">
                <div><label htmlFor="link-name" className="mb-1.5 block text-xs font-semibold text-ink/80">Name</label><input id="link-name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} disabled={busy || cache.starting || Boolean(cache.unlinkRequestId) || codeVisible} placeholder="Your name" className="min-h-[48px] w-full rounded-xl border border-ink/10 bg-paper px-3.5 text-base outline-none placeholder:text-ink/40 focus:border-accent disabled:bg-ink/5" /></div>
                <div><label htmlFor="link-phone" className="mb-1.5 block text-xs font-semibold text-ink/80">Phone number</label><input id="link-phone" type="tel" inputMode="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} disabled={busy || cache.starting || Boolean(cache.unlinkRequestId) || codeVisible} placeholder="265991234567" className="min-h-[48px] w-full rounded-xl border border-ink/10 bg-paper px-3.5 text-base outline-none placeholder:text-ink/40 focus:border-accent disabled:bg-ink/5" /><p className="mt-1.5 text-[11px] text-ink/40">Enter 265 followed by your WhatsApp number.</p></div>
                <button type="submit" disabled={!canRequest || busy || Boolean(cache.starting) || Boolean(cache.unlinkRequestId) || cooldownMs > 0} className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-bold text-paper transition hover:bg-accent disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-ink/60">{cache.unlinkRequestId ? <><Loader2 className="h-4 w-4 animate-spin" /> Unlinking…</> : busy || cache.starting ? <><Loader2 className="h-4 w-4 animate-spin" /> {removingPending ? 'Removing…' : 'Requesting code…'}</> : cooldownMs > 0 ? <>Resend available in {formatCountdown(cooldownMs)}</> : <>{disconnected || cache.expired ? 'Get new code' : 'Get code'} <ArrowRight className="h-4 w-4" /></>}</button>
                {cooldownMs > 0 && <p className="text-center text-[11px] text-ink/60">Take your time. You can request another code when the timer ends.</p>}
              </form>
              {pendingNumber && !confirmed && !accountIsLinked && !cache.relinking && <button type="button" onClick={() => void cancelPending()} disabled={busy || Boolean(cache.starting) || Boolean(cache.unlinkRequestId) || cooldownMs > 0} className="mt-2 flex min-h-11 w-full items-center justify-center rounded-xl text-xs font-semibold text-accent hover:bg-accent/10 disabled:text-ink/40">{removingPending ? 'Removing…' : 'Use a different number'}</button>}
            </section>
            {(codeVisible || cache.expired || cache.starting) && <section ref={codeCard} aria-label="WhatsApp linking code" className="mt-4 rounded-[22px] border border-accent/25 bg-paper p-4 shadow-sm"><div className="flex items-center justify-between gap-2"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-accent">WhatsApp linking code</p><h2 className="mt-1 text-sm font-bold">{cache.expired ? 'Code expired, get a new one' : cache.starting ? 'Getting your code' : 'Your code is ready'}</h2></div><ShieldCheck className="h-5 w-5 text-accent" /></div>
              {codeVisible && <><div className="mt-4 flex items-center justify-between gap-2 rounded-xl border border-accent/15 bg-accent/10 px-3.5 py-3"><code className="min-w-0 break-all font-mono text-[24px] font-extrabold tracking-[.12em] text-accent">{cache.code}</code><button type="button" onClick={() => void copy(cache.code!)} className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-paper px-3 text-xs font-bold text-accent shadow-sm">{copied === cache.code ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied === cache.code ? 'Copied' : 'Copy'}</button></div><p className="mt-2 text-[11px] text-ink/60">Code valid for {formatCountdown(codeMs)}. Resend timer is separate.</p></>}
              {!cache.starting && <div className="mt-4 border-t border-ink/5 pt-3"><p className="text-xs font-semibold text-ink/80">On your phone</p><p className="mt-2 flex flex-wrap items-center gap-1 text-xs leading-5 text-ink/60">WhatsApp <ChevronRight className="h-3 w-3" /> Linked devices <ChevronRight className="h-3 w-3" /> Link with phone number</p><p className="mt-2 text-[11px] text-ink/40">This page updates automatically once connected.</p></div>}
            </section>}
          <button type="button" onClick={() => router.push('/support')} className="mt-6 flex min-h-[52px] w-full items-center gap-3 rounded-2xl border border-ink/10 bg-paper px-4 text-left text-xs font-bold text-ink/80"><MessageSquare className="h-4 w-4 text-accent"/> Report a problem {supportUnread > 0 && <span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] text-accent">{supportUnread} new</span>}<ChevronRight className="ml-auto h-4 w-4 text-ink/40"/></button>
              {notice && <div role={notice.bad ? 'alert' : 'status'} className={`mt-4 flex items-start gap-2 rounded-xl border px-3.5 py-3 text-xs leading-5 ${notice.bad ? 'border-accent/25 bg-accent/10 text-accent' : 'border-accent/15 bg-accent/10 text-accent'}`}><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{notice.text}</div>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
