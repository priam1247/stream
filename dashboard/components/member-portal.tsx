'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Home,
  Command,
  Link2,
  Loader2,
  Search,
  Plus,
  Smartphone,
  Trash2,
} from 'lucide-react';
import {
  AuthUser,
  MemberOverviewPayload,
  PairCodePayload,
  UserQuota,
} from '@/lib/types';
import {
  authHeaders,
  fetchCurrentSession,
  performSignOut,
  setSavedSessionToken,
} from '@/lib/client-session';
import { PairingCodeBanner } from './pairing-code-banner';
import { accountStatusLabel } from '@/lib/whatsapp-accounts';
import { CommandDirectory } from './command-directory';
import { MediaVaultDesk } from './media-vault-desk';
import { AccountModal } from './account-modal';
import { LiveAnalytics } from './live-analytics';
import { MemberHome, type MemberDestination } from './member-home';
import { MemberConnection } from './member-connection';
import { WorkspaceShell, type WorkspaceNavGroup } from './workspace-shell';

type MemberTab = 'home' | MemberDestination;

export function MemberPortal() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [quota, setQuota] = useState<UserQuota | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const [tab, setTab] = useState<MemberTab>('home');
  const [visitedTabs, setVisitedTabs] = useState<MemberTab[]>(['home']);
  const [refreshing, setRefreshing] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean; pair?: boolean } | null>(null);

  const [overview, setOverview] = useState<MemberOverviewPayload>({
    ok: true,
    adminEmail: '',
    memberAllowed: true,
    botEnabledForMembers: true,
    botServerLinked: false,
    botConnected: false,
    botNumber: null,
    numbers: [],
  });

  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [busyNumber, setBusyNumber] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [activePair, setActivePair] = useState<PairCodePayload | null>(null);
  const pairBannerRef = useRef<HTMLDivElement | null>(null);
  const [numberSearch, setNumberSearch] = useState('');

  const loadMemberStatus = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await fetch('/api/member/status', {
          headers: authHeaders(),
          cache: 'no-store',
        });
        if (res.status === 401) {
          router.replace('/login');
          return;
        }
        const json = (await res.json()) as MemberOverviewPayload & {
          error?: string;
        };
        if (!res.ok) throw new Error(json.error || 'Could not load portal');
        setOverview(json);
        setStatusUnavailable(false);
      } catch (err) {
        setStatusUnavailable(true);
        setNotice({
          text: err instanceof Error ? err.message : 'Unable to refresh',
          bad: true,
        });
      } finally {
        setRefreshing(false);
      }
    },
    [router],
  );

  useEffect(() => {
    (async () => {
      const session = await fetchCurrentSession();
      if (!session) {
        router.replace('/login');
        return;
      }
      setUser(session.user);
      setQuota(session.quota);
      if (!session.user.isAdmin) { setChecking(false); return; }
      await loadMemberStatus(true);
      setChecking(false);
    })();
  }, [router, loadMemberStatus]);

  useEffect(() => {
    if (!user?.isAdmin) return;
    const id = setInterval(() => {
      void loadMemberStatus(true);
    }, 15_000);
    return () => clearInterval(id);
  }, [user, loadMemberStatus]);

  const handleAllowNumber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!number.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/member/numbers', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ number, label }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not add number');
      setOverview((prev) => ({ ...prev, numbers: json.numbers || [] }));
      setNumber('');
      setLabel('');
      setNotice({
        text: `Allowed +${number.replace(/\D/g, '')}`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to allow number',
        bad: true,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleOwnNumber = async (num: string, enabled: boolean) => {
    setBusyNumber(num);
    try {
      const res = await fetch(`/api/member/numbers/${encodeURIComponent(num)}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Update failed');
      if (!enabled && activePair?.number === num) setActivePair(null);
      setOverview((prev) => ({ ...prev, numbers: json.numbers || [] }));
      setNotice({
        text: enabled ? `Enabled +${num}` : `Paused +${num}`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Could not update number',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleDeleteOwnNumber = async (num: string) => {
    setBusyNumber(num);
    try {
      const res = await fetch(`/api/member/numbers/${encodeURIComponent(num)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not remove number');
      setOverview((prev) => ({ ...prev, numbers: json.numbers || [] }));
      if (activePair?.number === num) setActivePair(null);
      setConfirmDelete(null);
      setNotice({ text: `Removed +${num}` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Could not remove number',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleRequestCode = async (num: string) => {
    setBusyNumber(num);
    try {
      const res = await fetch('/api/member/pair', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ number: num }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not request code');

      if (json.pending && json.requestId) {
        setNotice({ text: `Requesting code for +${num}…` });
        const deadline = Date.now() + 75_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const pollRes = await fetch(
            `/api/member/pair?requestId=${encodeURIComponent(json.requestId)}`,
            { headers: authHeaders(), cache: 'no-store' },
          );
          const pollJson = await pollRes.json();
          if (!pollRes.ok) {
            throw new Error(pollJson?.error || 'Failed to get code');
          }
          if (!pollJson.pending && pollJson.code) {
            setActivePair({
              ok: true,
              code: pollJson.code,
              expiresInSeconds: Number(pollJson.expiresInSeconds) || 60,
              number: num,
              issuedAt: Math.min(Number(pollJson.issuedAt) || Date.now(), Date.now()),
            });
            setNotice({ text: `Code issued for +${num}`, pair: true });
            return;
          }
        }
        throw new Error('Timed out waiting for the service. Please try again.');
      }

      if (!json.code) throw new Error('The service did not return a linking code. Please try again.');
      setActivePair({
        ok: true,
        code: json.code,
        expiresInSeconds: Number(json.expiresInSeconds) || 60,
        number: num,
        issuedAt: Math.min(Number(json.issuedAt) || Date.now(), Date.now()),
      });
      setNotice({ text: `Code issued for +${num}`, pair: true });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to get code',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleUpdateName = async (nextName: string) => {
    const res = await fetch('/api/auth/me', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: nextName }),
    });
    const json = await res.json();
    if (res.ok && json.user) {
      setUser(json.user);
      if (json.token) setSavedSessionToken(json.token);
      setNotice({ text: 'Profile updated.' });
    }
  };

  const handleSignOut = async () => {
    await performSignOut();
    router.replace('/login');
  };

  useEffect(() => {
    if (activePair && tab === 'numbers') pairBannerRef.current?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  }, [activePair, tab]);

  const navigate = (next: MemberTab) => {
    setVisitedTabs((current) => current.includes(next) ? current : [...current, next]);
    setTab(next);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  if (checking || !user) {
    return (
      <div className="bg-canvas flex min-h-screen items-center justify-center px-4">
        <div className="flex items-center gap-2.5 rounded-2xl border border-line bg-paper px-4 py-3 text-xs font-semibold text-ink-soft shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin text-accent-600" />
          Connecting…
        </div>
      </div>
    );
  }

  if (!user.isAdmin) return <MemberConnection key={user.email} user={user} />;

  const canLinkNumbers =
    overview.memberAllowed && (overview.botEnabledForMembers || user.isAdmin);
  const filteredNumbers = overview.numbers.filter((item) => `${item.number} ${item.label || ''}`.toLowerCase().includes(numberSearch.trim().toLowerCase()));
  const navGroups: WorkspaceNavGroup<MemberTab>[] = [
    { label: 'My space', items: [
      { id: 'home', label: 'Home', icon: Home },
      { id: 'numbers', label: 'Numbers', icon: Smartphone, ...(!statusUnavailable ? { ariaLabel: `Numbers (${overview.numbers.length})`, badge: overview.numbers.length } : {}) },
    ] },
    { label: 'Tools', items: [
      { id: 'commands', label: 'Commands', icon: Command },
      { id: 'vault', label: 'Vault', icon: BookOpen },
    ] },
    { label: 'Service', items: [
      { id: 'status', label: 'Status', icon: Activity },
    ] },
  ];

  return (
    <WorkspaceShell
      kind="member"
      user={user}
      groups={navGroups}
      current={tab}
      onNavigate={navigate}
      mobileItems={['home', 'numbers', 'vault']}
      mobileMore
      refreshing={refreshing}
      onRefresh={() => { void loadMemberStatus(false); }}
      onAccount={() => setAccountOpen(true)}
      onSignOut={handleSignOut}
      alternate={user.isAdmin ? { href: '/admin', label: 'Owner view', ariaLabel: 'Open owner workspace' } : undefined}
    >
        {notice && (
          <div
            role={notice.bad ? 'alert' : 'status'}
            className={`mb-4 flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-xs font-medium ${
              notice.bad
                ? 'border-bad-200 bg-bad-50 text-bad-800'
                : 'border-accent-200 bg-accent-50 text-accent-900'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              {notice.bad ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-bad-600" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-accent-600" />
              )}
              <span className="min-w-0 break-words">{notice.text}</span>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {notice.pair && activePair && (
                <button
                  type="button"
                  onClick={() => {
                    navigate('numbers');
                    pairBannerRef.current?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
                  }}
                  className="min-h-9 text-[11px] font-semibold underline"
                >
                  View code
                </button>
              )}
              <button type="button" onClick={() => setNotice(null)} className="min-h-9 text-[11px] font-semibold underline">
                Close
              </button>
            </div>
          </div>
        )}

        {!overview.memberAllowed && (
          <div className="mb-4 rounded-xl border border-bad-200 bg-bad-50 px-3.5 py-2.5 text-xs font-semibold text-bad-800">
            Account restricted
          </div>
        )}

        {tab === 'home' && <MemberHome user={user} overview={overview} statusUnavailable={statusUnavailable} onNavigate={navigate} />}

        {tab === 'status' && (
          <div className="space-y-4">
            <h1 className="font-display px-0.5 text-[28px] font-semibold tracking-tight text-ink">Service status</h1>
            {statusUnavailable && <p role="alert" className="text-xs text-bad-700">Status could not be refreshed.</p>}
            <LiveAnalytics
              reachable={statusUnavailable ? false : overview.botReachable}
              connected={statusUnavailable ? null : overview.botConnected}
              botNumber={overview.botNumber}
              lastSeenSecondsAgo={statusUnavailable ? null : overview.lastSeenSecondsAgo}
              uptimeSeconds={statusUnavailable ? null : overview.uptimeSeconds}
              commandsTotal={statusUnavailable ? null : overview.commandsTotal}
              downloadsSuccess={statusUnavailable ? null : overview.downloadsSuccess}
              failedTotal={statusUnavailable ? null : overview.failedTotal}
            />
          </div>
        )}

        {tab === 'numbers' && (
          <section className="rounded-2xl border border-line bg-paper p-4 shadow-sm sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <h1 className="text-sm font-bold text-ink sm:text-base">
                WhatsApp numbers
              </h1>
              <span className="font-mono text-xs text-muted tabular-nums">
                {overview.numbers.length} approved
              </span>
            </div>

            <div className="mt-3 rounded-xl bg-wash px-3 py-2.5 text-xs leading-5 text-muted"><span className="font-semibold">{overview.whitelistSync === 'synced' ? 'Service reports the latest number list' : overview.whitelistSync === 'pending' ? 'Waiting for service sync' : 'Number sync not confirmed'}</span><span className="block">Approve your number, then request a code. Other linked accounts stay connected.</span></div>
            {!overview.botEnabledForMembers && !user.isAdmin && <p className="mt-3 rounded-xl bg-warn-50 px-3 py-2.5 text-xs leading-5 text-warn-800">New number approvals and pairing are paused. Existing approvals remain enabled.</p>}
            <form
              onSubmit={handleAllowNumber}
              className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-[1.15fr_0.95fr_auto] sm:items-end"
            >
              <div className="min-w-0">
                <label
                  htmlFor="member-wa-number"
                  className="mb-1 block text-xs font-medium text-ink-soft"
                >
                  Number (with country code)
                </label>
                <input
                  id="member-wa-number"
                  type="text"
                  inputMode="numeric"
                  required
                  disabled={!canLinkNumbers}
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  placeholder="265991234567"
                  className="w-full rounded-xl border border-linestrong bg-paper px-3.5 py-2.5 font-mono text-sm text-ink placeholder:text-faint focus:border-accent-600 focus:outline-none disabled:bg-wash tabular-nums"
                />
              </div>

              <div className="min-w-0">
                <label
                  htmlFor="member-wa-label"
                  className="mb-1 block text-xs font-medium text-ink-soft"
                >
                  Label
                </label>
                <input
                  id="member-wa-label"
                  type="text"
                  maxLength={80}
                  disabled={!canLinkNumbers}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Mobile"
                  className="w-full rounded-xl border border-linestrong bg-paper px-3.5 py-2.5 text-sm text-ink placeholder:text-faint focus:border-accent-600 focus:outline-none disabled:bg-wash"
                />
              </div>

              <button
                type="submit"
                disabled={!canLinkNumbers || submitting}
                className="inline-flex h-[42px] items-center justify-center gap-1.5 rounded-xl bg-accent-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-700 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                {submitting ? 'Saving…' : 'Allow'}
              </button>
            </form>

            <div ref={pairBannerRef} className="mt-4">
              <PairingCodeBanner
                activePair={activePair}
                onDismiss={() => {
                  setActivePair(null);
                  setNotice((current) => current?.pair ? null : current);
                }}
              />
            </div>

            <div className="relative mt-3"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" /><input type="search" aria-label="Search my numbers" value={numberSearch} onChange={(event) => setNumberSearch(event.target.value)} placeholder="Search number or label" className="min-h-11 w-full rounded-xl border border-line bg-wash py-2 pl-9 pr-3 text-base text-ink outline-none focus:border-accent-600 focus:bg-paper sm:text-sm" /></div>
            <div className="mt-2 divide-y divide-wash">
              {filteredNumbers.length === 0 ? (
                <p className="py-8 text-center font-mono text-xs text-faint">
                  {overview.numbers.length ? 'No matching numbers' : 'No numbers approved'}
                </p>
              ) : (
                filteredNumbers.map((item) => {
                  const busy = busyNumber === item.number;
                  const confirming = confirmDelete === item.number;
                  const accountState = overview.accounts?.find((account) => account.number === item.number)?.state;
                  return (
                    <div
                      key={item.number}
                      className="flex flex-col gap-2.5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-bold text-ink tabular-nums">
                            +{item.number}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                              item.enabled
                                ? 'bg-ok-50 text-ok-700 ring-1 ring-ok-200'
                                : 'bg-wash text-muted'
                            }`}
                          >
                            {item.enabled ? 'Allowed' : 'Paused'}
                          </span>
                        </div>
                        <p className="mt-1 text-xs font-medium text-accent-700">{accountStatusLabel(statusUnavailable || overview.botReachable === false ? null : overview.accounts, item.number)}</p>
                        {item.label && (
                          <p className="mt-0.5 truncate text-xs text-muted">
                            {item.label}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={
                            !item.enabled ||
                            !canLinkNumbers ||
                            busy ||
                            overview.botReachable === false ||
                            accountState === 'connected' || accountState === 'connecting'
                          }
                          onClick={() => handleRequestCode(item.number)}
                          className="inline-flex min-h-11 items-center gap-1 rounded-xl bg-accent-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-accent-700 disabled:opacity-40"
                        >
                          <Link2 className="h-3.5 w-3.5" />
                          {overview.botReachable === false ? 'Offline' : 'Get Code'}
                        </button>

                        <button
                          type="button"
                          disabled={!overview.memberAllowed || busy}
                          onClick={() =>
                            handleToggleOwnNumber(item.number, !item.enabled)
                          }
                          className="min-h-11 rounded-xl border border-line bg-wash px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:bg-wash disabled:opacity-50"
                        >
                          {item.enabled ? 'Pause' : 'Enable'}
                        </button>

                        {confirming ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleDeleteOwnNumber(item.number)}
                              className="min-h-11 rounded-xl bg-bad-600 px-2.5 py-1.5 text-xs font-semibold text-white"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(null)}
                              className="min-h-11 rounded-xl bg-wash px-2.5 py-1.5 text-xs font-medium text-muted"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(item.number)}
                            aria-label="Remove number"
                            className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-line bg-paper px-2.5 py-1.5 text-xs font-semibold text-bad-600 hover:border-bad-200 hover:bg-bad-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}

        {visitedTabs.includes('commands') && <div hidden={tab !== 'commands'} className="space-y-4"><h1 className="font-display px-0.5 text-[28px] font-semibold tracking-tight text-ink">Commands</h1><CommandDirectory hideOwnerCommands /></div>}
        {visitedTabs.includes('vault') && <div hidden={tab !== 'vault'}><MediaVaultDesk /></div>}
      <AccountModal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        user={user}
        quota={quota}
        onUpdateName={handleUpdateName}
        onSignOut={handleSignOut}
      />
    </WorkspaceShell>
  );
}
