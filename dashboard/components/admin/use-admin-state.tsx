'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Power } from 'lucide-react';
import { ActivityEvent, AdminOverviewPayload, AuthUser, PairCodePayload, PanelLiveStatus, UserQuota } from '@/lib/types';
import { authHeaders, fetchCurrentSession, performSignOut, setSavedSessionToken } from '@/lib/client-session';
import { getRoomAlerts, type ActivityPage, type RoomAlert, type RoomTarget, type WhatsAppPage } from '@/lib/control-room';
import { isRoomAlertRead, resolvedRoomAlertIds } from '@/lib/room-alert-reads';
import { useRoomAlertReads } from '../use-room-alert-reads';
import { AdminTab, MemberFilter } from './constants';

export function useAdminConsoleState() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [quota, setQuota] = useState<UserQuota | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const [tab, setTab] = useState<AdminTab>('overview');
  const [whatsAppPage, setWhatsAppPage] = useState<WhatsAppPage>('numbers');
  const [activityPage, setActivityPage] = useState<ActivityPage>('alerts');
  const [activityVisited, setActivityVisited] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean; pair?: boolean } | null>(null);
  const [overviewCheckedAt, setOverviewCheckedAt] = useState<number | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [panelStatus, setPanelStatus] = useState<PanelLiveStatus | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [eventsStorage, setEventsStorage] = useState<'cloudflare-d1' | 'local' | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [data, setData] = useState<AdminOverviewPayload>({
    ok: true,
    adminEmail: '',
    botServerLinked: false,
    hasBotSyncToken: false,
    botEnabledForMembers: true,
    storageEngine: 'unavailable',
    connected: false,
    botNumber: null,
    users: [],
    members: [],
  });

  // Member management state
  const [memberSearch, setMemberSearch] = useState('');
  const [memberFilter, setMemberFilter] = useState<MemberFilter>('all');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [addingMember, setAddingMember] = useState(false);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [supportUnread, setSupportUnread] = useState(0);
  useEffect(() => {
    if (!user?.isAdmin) return;
    const check = async () => { try { const res = await fetch('/api/support?summary=1', { headers: authHeaders(), cache: 'no-store' }); if (res.ok) { const json = await res.json(); setSupportUnread(Number(json.unread) || 0); } } catch { /* keep last known count */ } };
    void check(); const timer = window.setInterval(() => void check(), 10000); return () => window.clearInterval(timer);
  }, [user?.isAdmin]);

  // Bot & numbers state
  const [botSyncTokenInput, setBotSyncTokenInput] = useState('');
  const [showBotToken, setShowBotToken] = useState(false);
  const [savingBot, setSavingBot] = useState(false);

  // Optional HiddenCloud panel client API controls
  const [panelServerIdInput, setPanelServerIdInput] = useState('');
  const [panelKeyInput, setPanelKeyInput] = useState('');
  const [showPanelKey, setShowPanelKey] = useState(false);
  const [savingPanel, setSavingPanel] = useState(false);
  const [sendingPower, setSendingPower] = useState<string | null>(null);

  const [numInput, setNumInput] = useState('');
  const [numLabel, setNumLabel] = useState('');
  const [addingNumber, setAddingNumber] = useState(false);
  const [busyNumber, setBusyNumber] = useState<string | null>(null);
  const [confirmDeleteNum, setConfirmDeleteNum] = useState<string | null>(null);
  const [numberSearch, setNumberSearch] = useState('');
  const [numberFilter, setNumberFilter] = useState<'all' | 'allowed' | 'blocked'>('all');
  const [activePair, setActivePair] = useState<PairCodePayload | null>(null);
  const pairBannerRef = useRef<HTMLDivElement | null>(null);

  const loadOverview = useCallback(
    async (silent = false, hydrateInputs = false) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await fetch('/api/admin/status', {
          headers: authHeaders(),
          cache: 'no-store',
        });
        if (res.status === 401) {
          router.replace('/login');
          return;
        }
        if (res.status === 403) {
          router.replace('/dashboard');
          return;
        }
        const json = (await res.json()) as AdminOverviewPayload & { error?: string };
        if (!res.ok) throw new Error(json.error || 'Failed to load server status');
        setData(json);
        setOverviewCheckedAt(Date.now());
        setOverviewError(null);
        if (hydrateInputs) {
          setBotSyncTokenInput(json.hasBotSyncToken ? '••••••••' : '');
          setPanelServerIdInput(json.panelServerId || '');
          setPanelKeyInput(json.hasPanelApiKey ? '••••••••' : '');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to fetch status';
        setOverviewError(message);
        if (!silent) setNotice({ text: message, bad: true });
      } finally {
        setRefreshing(false);
      }
    },
    [router],
  );

  const loadPanelStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/panel/status', { headers: authHeaders(), cache: 'no-store' });
      if (!res.ok) throw new Error('Panel status could not be checked.');
      setPanelStatus(await res.json() as PanelLiveStatus);
    } catch {
      setPanelStatus({ configured: null, reachable: false, state: 'unknown', error: 'Panel status could not be checked.', checkedAt: Date.now() });
    }
  }, []);

  const loadActivity = useCallback(async (silent = true) => {
    if (!silent) setEventsLoading(true);
    try {
      const res = await fetch('/api/admin/activity', { headers: authHeaders(), cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Could not load activity.');
      setEvents(Array.isArray(json.events) ? json.events : []);
      setEventsStorage(json.storage === 'cloudflare-d1' ? 'cloudflare-d1' : 'local');
      setEventsError(null);
    } catch (error) {
      setEventsError(error instanceof Error ? error.message : 'Could not load activity.');
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const session = await fetchCurrentSession();
      if (!session) {
        router.replace('/login');
        return;
      }
      if (!session.user.isAdmin) {
        router.replace('/dashboard');
        return;
      }
      setUser(session.user);
      setQuota(session.quota);
      await loadOverview(true, true);
      setChecking(false);
    })();
  }, [router, loadOverview]);

  useEffect(() => {
    if (!user) return;
    void loadActivity(false);
    const id = setInterval(() => {
      if (document.hidden) return;
      void loadOverview(true, false);
      void loadActivity();
    }, 15_000);
    return () => clearInterval(id);
  }, [user, loadOverview, loadActivity]);

  useEffect(() => {
    if (!user) return;
    void loadPanelStatus();
    const id = window.setInterval(() => { if (!document.hidden) void loadPanelStatus(); }, 60_000);
    return () => window.clearInterval(id);
  }, [user, loadPanelStatus]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    return data.members.filter((m) => {
      if (memberFilter === 'approved' && !m.allowed) return false;
      if (memberFilter === 'denied' && m.allowed) return false;
      if (!q) return true;
      return (
        m.email.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
      );
    });
  }, [data.members, memberSearch, memberFilter]);

  const filteredNumbers = useMemo(() => {
    const query = numberSearch.trim().toLowerCase();
    return data.users.filter((item) => {
      if (numberFilter === 'allowed' && !item.enabled) return false;
      if (numberFilter === 'blocked' && item.enabled) return false;
      return !query || `${item.number} ${item.label || ''} ${item.addedBy || ''}`.toLowerCase().includes(query);
    });
  }, [data.users, numberSearch, numberFilter]);

  const handleApproval = async (number: string, action: 'approve' | 'reject') => {
    setBusyNumber(number);
    try {
      const res = await fetch('/api/admin/approvals', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ number, action }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not update this request.');
      setNotice({ text: action === 'approve' ? 'Approved. The service will apply access on its next sync.' : 'Request rejected. The member can unlink their session.' });
      await loadOverview(true, false);
      void loadActivity();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not update this request.', bad: true });
    } finally { setBusyNumber(null); }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemberEmail.trim()) return;
    setAddingMember(true);
    try {
      const res = await fetch('/api/admin/members', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          email: newMemberEmail.trim(),
          name: newMemberName.trim(),
          allowed: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not add member');
      setData((prev) => ({ ...prev, members: json.members }));
      setNewMemberEmail('');
      setNewMemberName('');
      setNotice({ text: `Approved ${newMemberEmail.trim().toLowerCase()}` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to approve member',
        bad: true,
      });
    } finally {
      setAddingMember(false);
    }
  };

  const handleToggleMember = async (
    email: string,
    allowed: boolean,
    name: string,
  ) => {
    if (!window.confirm(`${allowed ? 'Approve' : 'Block'} ${email}? This will also ${allowed ? 'enable' : 'disable'} their linked numbers.`)) return;
    setBusyEmail(email);
    try {
      const res = await fetch('/api/admin/members', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ email, allowed, name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to update member');
      setData((prev) => ({
        ...prev,
        members: json.members || prev.members,
        users: json.users || prev.users,
      }));
      setNotice({
        text: allowed ? `Approved ${email}` : `Denied ${email}`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Update failed',
        bad: true,
      });
    } finally {
      setBusyEmail(null);
    }
  };

  const handleSaveBotConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBot(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          botSyncToken: botSyncTokenInput.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to save sync settings');

      await loadOverview(true, false);
      if (json.probe?.reachable) {
        setNotice({
          text: `Sync verified (${json.probe.connected ? 'ONLINE' : 'STANDBY'})`,
        });
      } else {
        setNotice({ text: 'Sync settings saved.' });
      }
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to save sync settings',
        bad: true,
      });
    } finally {
      setSavingBot(false);
    }
  };

  const handleToggleGlobalBot = async () => {
    const nextState = !data.botEnabledForMembers;
    if (!nextState && !window.confirm('Pause new member linking? This does not automatically disable already-approved numbers.')) return;
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ botEnabledForMembers: nextState }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to toggle access');
      setData((prev) => ({ ...prev, botEnabledForMembers: nextState }));
      setNotice({
        text: nextState ? 'New member linking enabled.' : 'New member linking paused. Already-approved numbers are not automatically disabled.',
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Could not update access',
        bad: true,
      });
    }
  };

  const handleAddNumber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!numInput.trim()) return;
    setAddingNumber(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ number: numInput, label: numLabel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not approve number');
      setData((prev) => ({ ...prev, users: json.users }));
      setNumInput('');
      setNumLabel('');
      setNotice({ text: `Approved +${numInput.replace(/\D/g, '')}` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to add number',
        bad: true,
      });
    } finally {
      setAddingNumber(false);
    }
  };

  const handleToggleNumber = async (number: string, enabled: boolean) => {
    setBusyNumber(number);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(number)}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Update failed');
      if (!enabled && activePair?.number === number) setActivePair(null);
      await loadOverview(true, false);
      setNotice({
        text: enabled ? `Enabled +${number}` : `Disabled +${number}`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to update number',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleDeleteNumber = async (number: string) => {
    setBusyNumber(number);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(number)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      let json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Remove failed');
      if (json.pending && typeof json.requestId === 'string') {
        for (let attempt = 0; attempt < 90; attempt++) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          const check = await fetch(`/api/admin/users/${encodeURIComponent(number)}?requestId=${encodeURIComponent(json.requestId)}`, { headers: authHeaders(), cache: 'no-store' });
          json = await check.json();
          if (check.status === 202 && json.pending) continue;
          if (!check.ok) throw new Error(json?.error || 'Unlink failed');
          break;
        }
        if (json.pending) throw new Error('Unlink is still pending. Approval has been withdrawn; check back before removing the row.');
      }
      setData((prev) => ({ ...prev, users: json.users || [] }));
      if (activePair?.number === number) setActivePair(null);
      setConfirmDeleteNum(null);
      setNotice({ text: `Removed +${number}` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to remove number',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleSavePanel = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPanel(true);
    try {
      const res = await fetch('/api/admin/panel', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'save',
          panelServerId: panelServerIdInput.trim(),
          panelApiKey: panelKeyInput.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not save HiddenCloud settings');
      if (json.panelServerId) setPanelServerIdInput(json.panelServerId);
      if (json.hasPanelApiKey) setPanelKeyInput('••••••••');
      await loadOverview(true, false);
      void loadPanelStatus();

      if (json.verified) {
        setNotice({ text: 'Saved. HiddenCloud responded; check server status for its state.' });
      } else if (json.verificationError) {
        setNotice({
          text: `Saved (${json.verificationError})`,
          bad: true,
        });
      } else {
        setNotice({ text: 'HiddenCloud settings saved.' });
      }
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to save HiddenCloud settings',
        bad: true,
      });
    } finally {
      setSavingPanel(false);
    }
  };

  const handlePanelPower = async (signal: 'restart' | 'start' | 'stop') => {
    const target = data.panelServerId ? ` HiddenCloud server: ${data.panelServerId}.` : '';
    if (!window.confirm(`${signal[0].toUpperCase()}${signal.slice(1)} the WhatsApp service?${target}`)) return;
    setSendingPower(signal);
    try {
      const res = await fetch('/api/admin/panel', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ action: 'power', signal, serverId: data.panelServerId || '' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Could not ${signal} the service`);
      setNotice({ text: `${json.message || `Signal accepted: ${signal}.`} Check the service status to confirm the result.` });
      void loadActivity();
      window.setTimeout(() => { void loadOverview(true, false); void loadPanelStatus(); }, 3000);
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Power command failed',
        bad: true,
      });
    } finally {
      setSendingPower(null);
    }
  };

  const handlePairNumber = async (number: string) => {
    setBusyNumber(number);
    try {
      const res = await fetch('/api/admin/pair', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ number }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not request code');

      if (json.pending && json.requestId) {
        setNotice({ text: `Requesting code for +${number}…` });
        const deadline = Date.now() + 75_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const pollRes = await fetch(
            `/api/admin/pair?requestId=${encodeURIComponent(json.requestId)}`,
            { headers: authHeaders(), cache: 'no-store' },
          );
          const pollJson = await pollRes.json();
          if (!pollRes.ok) {
            throw new Error(pollJson?.error || 'Pairing failed.');
          }
          if (!pollJson.pending && pollJson.code) {
            setActivePair({
              ok: true,
              code: pollJson.code,
              expiresInSeconds: Number(pollJson.expiresInSeconds) || 60,
              number,
              issuedAt: Math.min(Number(pollJson.issuedAt) || Date.now(), Date.now()),
            });
            setNotice({ text: `Code issued for +${number}`, pair: true });
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
        number,
        issuedAt: Math.min(Number(json.issuedAt) || Date.now(), Date.now()),
      });
      setNotice({ text: `Code issued for +${number}`, pair: true });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to request code',
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
      setNotice({ text: 'Display name updated.' });
    }
  };

  const handleSignOut = async () => {
    await performSignOut();
    router.replace('/login');
  };

  useEffect(() => {
    if (activePair && tab === 'server' && whatsAppPage === 'numbers') pairBannerRef.current?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  }, [activePair, tab, whatsAppPage]);

  const navigate = (target: RoomTarget) => {
    if (target.tab === 'server' && target.page) setWhatsAppPage(target.page);
    if (target.tab === 'activity') {
      setActivityVisited(true);
      if (target.page) setActivityPage(target.page);
    }
    setTab(target.tab);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const alerts = useMemo(() => getRoomAlerts(data, overviewCheckedAt, overviewError, panelStatus),
    [data, overviewCheckedAt, overviewError, panelStatus]);
  const resolvedIds = useMemo(() => resolvedRoomAlertIds(data, overviewCheckedAt, overviewError, panelStatus),
    [data, overviewCheckedAt, overviewError, panelStatus]);
  const { reads, markRead } = useRoomAlertReads(user?.email || '', resolvedIds);
  const unreadAlertIds = new Set(alerts.filter((alert) => !isRoomAlertRead(alert, reads)).map((alert) => alert.id));
  const openAlert = (alert: RoomAlert) => {
    markRead(alert);
    navigate(alert.target);
  };

  // Derived per-page values live here so pages stay presentational.
  const lastRestartEvent = events.find((event) => event.action === 'Service restart requested' || event.action === 'Bot restart requested');
  const approvedMembersCount = data.members.filter((m) => m.allowed).length;
  const enabledNumbersCount = data.users.filter((u) => u.enabled).length;

  return {
    accountOpen,
    activePair,
    activityPage,
    activityVisited,
    addingMember,
    addingNumber,
    alerts,
    botSyncTokenInput,
    busyEmail,
    busyNumber,
    checking,
    confirmDeleteNum,
    data,
    events,
    eventsError,
    eventsLoading,
    eventsStorage,
    approvedMembersCount,
    enabledNumbersCount,
    filteredMembers,
    filteredNumbers,
    lastRestartEvent,
    handleAddMember,
    handleAddNumber,
    handleApproval,
    handleDeleteNumber,
    handlePairNumber,
    handlePanelPower,
    handleSaveBotConfig,
    handleSavePanel,
    handleSignOut,
    handleToggleGlobalBot,
    handleToggleMember,
    handleToggleNumber,
    handleUpdateName,
    loadActivity,
    loadOverview,
    loadPanelStatus,
    memberFilter,
    memberSearch,
    navigate,
    newMemberEmail,
    newMemberName,
    notice,
    numInput,
    numLabel,
    numberFilter,
    numberSearch,
    openAlert,
    overviewCheckedAt,
    overviewError,
    pairBannerRef,
    panelKeyInput,
    panelServerIdInput,
    panelStatus,
    quota,
    refreshing,
    savingBot,
    savingPanel,
    sendingPower,
    setAccountOpen,
    setActivePair,
    setActivityPage,
    setBotSyncTokenInput,
    setConfirmDeleteNum,
    setMemberFilter,
    setMemberSearch,
    setNewMemberEmail,
    setNewMemberName,
    setNotice,
    setNumInput,
    setNumLabel,
    setNumberFilter,
    setNumberSearch,
    setPanelKeyInput,
    setPanelServerIdInput,
    setShowBotToken,
    setShowPanelKey,
    setWhatsAppPage,
    showBotToken,
    showPanelKey,
    setSupportUnread,
    supportUnread,
    tab,
    unreadAlertIds,
    user,
    whatsAppPage,
  };
}

export type AdminConsoleState = ReturnType<typeof useAdminConsoleState>;
