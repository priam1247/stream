'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell,
  BookOpen,
  Home,
  MessageSquare,
  Smartphone,
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  ShieldBan,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  ActivityEvent,
  AdminOverviewPayload,
  AuthUser,
  PairCodePayload,
  PanelLiveStatus,
  UserQuota,
} from '@/lib/types';
import {
  authHeaders,
  fetchCurrentSession,
  performSignOut,
  setSavedSessionToken,
} from '@/lib/client-session';
import { PairingCodeBanner } from './pairing-code-banner';
import { accountStatusLabel, serviceText } from '@/lib/whatsapp-accounts';
import { AccountModal } from './account-modal';
import { LiveAnalytics } from './live-analytics';
import { MemberCommandControls } from './member-command-controls';
import { CommandDirectory } from './command-directory';
import { SupportDesk } from './support-desk';
import { ControlRoomHome } from './control-room-home';
import { ControlRoomActivity } from './control-room-activity';
import { SectionNav } from './section-nav';
import { WorkspaceShell, type WorkspaceNavGroup } from './workspace-shell';
import { getRoomAlerts, type ActivityPage, type OwnerTab, type RoomAlert, type RoomTarget, type WhatsAppPage } from '@/lib/control-room';
import { isRoomAlertRead, resolvedRoomAlertIds } from '@/lib/room-alert-reads';
import { useRoomAlertReads } from './use-room-alert-reads';

type AdminTab = OwnerTab;
type MemberFilter = 'all' | 'allowed' | 'disallowed';
const WHATSAPP_PAGES: { id: WhatsAppPage; label: string }[] = [
  { id: 'numbers', label: 'Numbers' },
  { id: 'commands', label: 'Commands' },
  { id: 'service', label: 'Status' },
  { id: 'power', label: 'Power' },
  { id: 'sync', label: 'Sync' },
  { id: 'hosting', label: 'Hosting' },
];

export function AdminConsole() {
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
    botApiUrl: '',
    hasBotToken: false,
    botEnabledForMembers: true,
    storageEngine: 'persistent-db',
    upstreamHost: null,
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
  const [botUrlInput, setBotUrlInput] = useState('');
  const [botTokenInput, setBotTokenInput] = useState('');
  const [botSyncTokenInput, setBotSyncTokenInput] = useState('');
  const [showBotToken, setShowBotToken] = useState(false);
  const [savingBot, setSavingBot] = useState(false);

  // Optional Botkeep Developer API controls
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
          setBotUrlInput(json.botApiUrl || '');
          setBotTokenInput(json.hasBotToken ? '••••••••' : '');
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
      if (memberFilter === 'allowed' && !m.allowed) return false;
      if (memberFilter === 'disallowed' && m.allowed) return false;
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

  const handleSyncNumber = async (number: string) => {
    setBusyNumber(number);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(number)}/sync`, { method: 'POST', headers: authHeaders() });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not request sync.');
      setNotice({ text: json.message || 'Sync requested.' });
      void loadOverview(true, false);
      void loadActivity();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not request sync.', bad: true });
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
      setNotice({ text: `Allowed ${newMemberEmail.trim().toLowerCase()}` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to allow member',
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
    if (!window.confirm(`${allowed ? 'Allow' : 'Block'} ${email}? This will also ${allowed ? 'enable' : 'disable'} their linked numbers.`)) return;
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
        text: allowed ? `Allowed ${email}` : `Disallowed ${email}`,
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
          bridgeTarget: 'botkeep',
          botApiUrl: botUrlInput.trim(),
          botAdminToken: botTokenInput.trim(),
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
        text: enabled ? `Allowed +${number}` : `Disallowed +${number}`,
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
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Remove failed');
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
      if (!res.ok) throw new Error(json?.error || 'Could not save Botkeep settings');
      if (json.panelServerId) setPanelServerIdInput(json.panelServerId);
      if (json.hasPanelApiKey) setPanelKeyInput('••••••••');
      await loadOverview(true, false);
      void loadPanelStatus();

      if (json.verified) {
        setNotice({ text: 'Saved. Botkeep responded; check server status for its state.' });
      } else if (json.verificationError) {
        setNotice({
          text: `Saved (${json.verificationError})`,
          bad: true,
        });
      } else {
        setNotice({ text: 'Botkeep settings saved.' });
      }
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to save Botkeep settings',
        bad: true,
      });
    } finally {
      setSavingPanel(false);
    }
  };

  const handlePanelPower = async (signal: 'restart' | 'start' | 'stop') => {
    const target = data.panelServerId ? ` Botkeep server: ${data.panelServerId}.` : '';
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

  if (checking || !user) {
    return (
      <div className="bg-portal-canvas flex min-h-screen items-center justify-center px-4">
        <div className="flex items-center gap-2.5 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs font-semibold text-slate-700 shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin text-teal-600" />
          Connecting…
        </div>
      </div>
    );
  }

  const lastRestartEvent = events.find((event) => event.action === 'Service restart requested' || event.action === 'Bot restart requested');
  const allowedMembersCount = data.members.filter((m) => m.allowed).length;
  const enabledNumbersCount = data.users.filter((u) => u.enabled).length;
  const navGroups: WorkspaceNavGroup<AdminTab>[] = [
    { label: 'Workspace', items: [
      { id: 'overview', label: 'Home', icon: Home },
      { id: 'server', label: 'WhatsApp', icon: Smartphone },
    ] },
    { label: 'Management', items: [
      { id: 'members', label: 'Members', icon: Users },
      { id: 'support', label: 'Reports', icon: MessageSquare, ...(supportUnread ? { badge: supportUnread, alert: true } : {}) },
      { id: 'activity', label: 'Activity', icon: Bell, ...(unreadAlertIds.size ? { badge: unreadAlertIds.size, alert: true } : {}) },
    ] },
  ];

  return (
    <WorkspaceShell
      kind="owner"
      user={user}
      groups={navGroups}
      current={tab}
      onNavigate={(next) => navigate({ tab: next } as RoomTarget)}
      mobileItems={['overview', 'server', 'members', 'activity']}
      refreshing={refreshing}
      onRefresh={() => { void loadOverview(false, false); void loadPanelStatus(); void loadActivity(false); }}
      onAccount={() => setAccountOpen(true)}
      onSignOut={handleSignOut}
      alternate={{ href: '/dashboard', label: 'Member view', ariaLabel: 'Open member portal' }}
    >
        {notice && (
          <div
            role={notice.bad ? 'alert' : 'status'}
            className={`mb-4 flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-xs font-medium ${
              notice.bad
                ? 'border-rose-200 bg-rose-50 text-rose-800'
                : 'border-teal-200 bg-teal-50 text-teal-900'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              {notice.bad ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-teal-600" />
              )}
              <span className="min-w-0 break-words">{notice.text}</span>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {notice.pair && activePair && (
                <button
                  type="button"
                  onClick={() => {
                    navigate({ tab: 'server', page: 'numbers' });
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

        {tab === 'overview' && <ControlRoomHome data={data} overviewCheckedAt={overviewCheckedAt} overviewError={overviewError} alerts={alerts} onNavigate={navigate} onOpenAlert={openAlert} />}
        {activityVisited && <div hidden={tab !== 'activity'}><ControlRoomActivity alerts={alerts} unreadAlertIds={unreadAlertIds} events={events} storage={eventsStorage} loading={eventsLoading} error={eventsError} page={activityPage} onPageChange={setActivityPage} onRefresh={() => { void loadActivity(false); void loadOverview(true, false); void loadPanelStatus(); }} onOpenAlert={openAlert} /></div>}

        {tab === 'server' && (
          <div className="space-y-4">
            <h1 className="px-0.5 text-2xl font-bold tracking-tight text-slate-950">WhatsApp</h1>
            <SectionNav label="WhatsApp pages" items={WHATSAPP_PAGES} value={whatsAppPage} onChange={setWhatsAppPage} />
            {whatsAppPage === 'service' && (
              <>
                <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                  <h2 className="text-sm font-bold text-slate-900 sm:text-base">Service status</h2>
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Botkeep server</p><p className="mt-1 text-sm font-semibold capitalize text-slate-800">{!panelStatus ? 'Checking' : panelStatus.configured === false ? 'Not configured' : panelStatus.state}</p>{panelStatus?.error && <p className="mt-1 break-words text-[11px] text-slate-500">{panelStatus.error}</p>}</div>
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Service bridge</p><p className="mt-1 text-sm font-semibold text-slate-800">{overviewError || overviewCheckedAt == null ? 'Unknown' : data.botReachable ? 'Reachable' : data.botServerLinked ? 'Not reporting' : 'Not linked'}</p><p className="mt-1 text-[11px] text-slate-500">{overviewError ? 'Last check failed' : overviewCheckedAt == null ? 'Awaiting first check' : data.lastSeenSecondsAgo != null ? `Last heartbeat ${data.lastSeenSecondsAgo}s ago` : data.connectionMode === 'direct' ? 'Direct connection' : 'No heartbeat reported'}</p></div>
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">WhatsApp</p><p className="mt-1 text-sm font-semibold text-slate-800">{overviewError || !data.botReachable || data.connected == null ? 'Unknown' : data.connected ? 'Connected' : 'Disconnected'}</p></div>
                  </div>
                  {overviewError && <p role="alert" className="mt-3 text-xs text-rose-700">Status could not be refreshed. Check Sync settings.</p>}
                  {!overviewError && data.botVersion && <p className="mt-3 break-all text-xs text-slate-500">Reported version {data.botVersion}</p>}
                  {!overviewError && data.botError && <p className="mt-3 text-xs leading-5 text-amber-700">{serviceText(data.botError)} Check the service process and Sync settings.</p>}
                </section>
                {/* Live Server Analytics: Commands, Successful Downloads, Failed, Uptime + RAM/Disk/Queues */}
                <LiveAnalytics
                  reachable={overviewError ? false : data.botReachable}
                  connected={overviewError ? null : data.connected}
                  botNumber={data.botNumber}
                  lastSeenSecondsAgo={overviewError ? null : data.lastSeenSecondsAgo}
                  uptimeSeconds={overviewError ? null : data.uptimeSeconds}
                  commandsTotal={overviewError ? null : data.commandsTotal}
                  downloadsSuccess={overviewError ? null : data.downloadsSuccess}
                  failedTotal={overviewError ? null : data.failedTotal}
                  ramUsedMB={overviewError ? null : data.ramUsedMB}
                  diskUsedMB={overviewError ? null : data.diskUsedMB}
                  diskBudgetMB={overviewError ? null : data.diskBudgetMB}
                  queueLight={overviewError ? null : data.queueLight}
                  queueHeavy={overviewError ? null : data.queueHeavy}
                  showResources
                />
              </>
            )}

            {whatsAppPage === 'power' && (
              <section className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:px-4">
                <div className="flex w-full items-center justify-between gap-2"><h2 className="text-sm font-bold text-slate-900">Server power</h2><span className="text-xs font-semibold capitalize text-slate-600">{!panelStatus ? 'Checking' : panelStatus.configured === false ? 'Not configured' : panelStatus.state}</span></div>
                {panelStatus?.error && <p className="w-full break-words text-xs text-amber-700">{panelStatus.error}</p>}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={sendingPower !== null}
                    onClick={() => handlePanelPower('restart')}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-teal-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${sendingPower === 'restart' ? 'animate-spin' : ''}`}
                    />
                    {sendingPower === 'restart' ? 'Restarting…' : 'Restart service'}
                  </button>

                  <button
                    type="button"
                    disabled={sendingPower !== null}
                    onClick={() => handlePanelPower('start')}
                    className="min-h-11 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50"
                  >
                    {sendingPower === 'start' ? 'Starting…' : 'Start service'}
                  </button>

                  <button
                    type="button"
                    disabled={sendingPower !== null}
                    onClick={() => handlePanelPower('stop')}
                    className="min-h-11 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
                  >
                    {sendingPower === 'stop' ? 'Stopping…' : 'Stop service'}
                  </button>
                </div>

                <p className="w-full text-[11px] leading-5 text-slate-500">Power targets the selected Botkeep server and requires the optional Developer API settings.</p>
                {lastRestartEvent && <p className="w-full text-[11px] text-slate-500">Last restart request: {new Date(lastRestartEvent.createdAt).toLocaleString()}. A request is not confirmation of a completed restart.</p>}
              </section>
            )}

            {whatsAppPage === 'commands' && <><MemberCommandControls />
              <section aria-label="Service command reference" className="mt-4 space-y-2.5"><h2 className="px-0.5 text-sm font-bold text-slate-900 sm:text-base">Service command reference</h2><p className="px-0.5 text-xs text-slate-500">Every command on the service, including owner-only ones. Members only see the member catalog.</p><CommandDirectory /></section></>}

            {whatsAppPage === 'sync' && <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Session recovery status">
              <h2 className="text-sm font-bold text-slate-900">Encrypted session recovery</h2>
              <p className="mt-1 text-xs leading-5 text-slate-600">{!data.botReachable ? 'Service offline; backup status cannot be confirmed.' : !data.sessionBackup ? 'The service has not reported recovery status. Update the service to enable it.' : data.sessionBackup.state === 'disabled' ? 'Not configured. Set a private SESSION_BACKUP_KEY on the service and configure durable D1 storage.' : data.sessionBackup.state === 'error' ? 'Backup or revocation failed. Check the service logs and dashboard storage.' : data.sessionBackup.state === 'conflict' ? 'Local sessions were preserved; a backup conflict needs review.' : data.sessionBackup.state === 'starting' ? 'Connecting to encrypted recovery.' : data.sessionBackup.lastBackupAt ? `Recovery connected. Last encrypted snapshot: ${new Date(data.sessionBackup.lastBackupAt).toLocaleString()}.` : 'Recovery connected. No session snapshot has been saved yet.'}</p>
              {data.botReachable && data.sessionBackup?.state === 'ready' && data.sessionBackup.sessions !== undefined && data.sessionBackup.backedUp !== undefined && <p className="mt-2 text-xs font-semibold text-slate-700">{data.sessionBackup.backedUp} of {data.sessionBackup.sessions} registered sessions have a current snapshot.</p>}
              {data.storageEngine !== 'cloudflare-d1' && <p className="mt-2 text-xs font-semibold text-amber-800">Durable D1 storage has not been confirmed.</p>}
            </section>}

            {whatsAppPage === 'numbers' && <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-slate-900 sm:text-base">
                  Approved numbers
                </h2>
                <span className="whitespace-nowrap font-mono text-xs text-slate-500 tabular-nums">
                  {enabledNumbersCount}/{data.users.length} allowed
                </span>
              </div>

              <div className={`mt-3 rounded-xl border px-3 py-2.5 text-xs leading-5 ${data.whitelistSync === 'synced' && !overviewError ? 'border-teal-100 bg-teal-50/60 text-teal-800' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                <span className="font-semibold">{overviewError ? 'Sync status unavailable' : data.whitelistSync === 'synced' ? 'Service reports the latest number list' : data.whitelistSync === 'pending' ? 'Number list waiting for service sync' : 'Number sync not confirmed'}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="min-w-0"><p className="text-xs font-semibold text-slate-800">Member linking: {data.botEnabledForMembers ? 'Open' : 'Paused'}</p><p className="mt-1 text-[11px] leading-4 text-slate-500">Pausing stops new requests, not approved numbers.</p></div>
                <button
                  type="button"
                  onClick={handleToggleGlobalBot}
                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition ${
                    data.botEnabledForMembers
                      ? 'border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100'
                      : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                  }`}
                >
                  <Power className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {data.botEnabledForMembers ? 'Pause linking' : 'Resume linking'}
                  </span>
                </button>
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-500">Approve a number, then request a code. A code alone does not confirm linking.</p>

              <form
                onSubmit={handleAddNumber}
                className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-[1.1fr_1fr_auto] sm:items-end"
              >
                <div className="min-w-0">
                  <label
                    htmlFor="admin-add-num"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    Number
                  </label>
                  <input
                    id="admin-add-num"
                    type="text"
                    inputMode="numeric"
                    required
                    value={numInput}
                    onChange={(e) => setNumInput(e.target.value)}
                    placeholder="265991234567"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none tabular-nums"
                  />
                </div>
                <div className="min-w-0">
                  <label
                    htmlFor="admin-add-label"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    Label
                  </label>
                  <input
                    id="admin-add-label"
                    type="text"
                    value={numLabel}
                    onChange={(e) => setNumLabel(e.target.value)}
                    placeholder="Operator"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={addingNumber}
                  className="inline-flex h-[42px] items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
                >
                  <Plus className="h-4 w-4" />
                  {addingNumber ? 'Adding…' : 'Approve'}
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

              <div className="mt-3 flex flex-wrap gap-2">
                <div className="relative min-w-0 flex-1 basis-44"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input type="search" aria-label="Search WhatsApp numbers" value={numberSearch} onChange={(event) => setNumberSearch(event.target.value)} placeholder="Search number, label or owner" className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-base text-slate-900 outline-none focus:border-teal-400 focus:bg-white sm:text-sm" /></div>
                <select aria-label="Filter WhatsApp numbers" value={numberFilter} onChange={(event) => setNumberFilter(event.target.value as 'all' | 'allowed' | 'blocked')} className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700"><option value="all">All numbers</option><option value="allowed">Allowed</option><option value="blocked">Blocked</option></select>
              </div>
              <div className="mt-2 divide-y divide-slate-100">
                {filteredNumbers.length === 0 ? (
                  <p className="py-6 text-center font-mono text-xs text-slate-400">
                    {data.users.length ? 'No numbers match this filter' : 'No numbers approved'}
                  </p>
                ) : (
                  filteredNumbers.map((u) => {
                    const busy = busyNumber === u.number;
                    const confirming = confirmDeleteNum === u.number;
                    const accountState = data.accounts?.find((account) => account.number === u.number)?.state;
                    return (
                      <div
                        key={u.number}
                        className="flex flex-col gap-2.5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                              +{u.number}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                                u.enabled
                                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                                  : 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
                              }`}
                            >
                              {u.enabled ? 'Allowed' : 'Blocked'}
                            </span>
                          </div>
                          <p className="mt-1 text-xs font-medium text-teal-700">{accountStatusLabel(overviewError || !data.botReachable ? null : data.accounts, u.number)}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                            <span className="truncate">{u.label || 'Approved'}</span>
                            {u.addedBy && (
                              <>
                                <span>·</span>
                                <span className="break-all font-mono text-[11px] text-slate-600">
                                  {u.addedBy}
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <button type="button" disabled={busy} onClick={() => handleSyncNumber(u.number)} aria-label={`Retry sync for +${u.number}`} className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:border-teal-200 hover:bg-teal-50 disabled:opacity-40"><RefreshCw className="h-3.5 w-3.5 text-teal-600" /> Sync</button>
                          <button
                            type="button"
                            disabled={!u.enabled || busy || accountState === 'connected' || accountState === 'connecting'}
                            onClick={() => handlePairNumber(u.number)}
                            className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800 disabled:opacity-40"
                          >
                            <Link2 className="h-3.5 w-3.5 text-teal-600" />
                            Get code
                          </button>

                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleToggleNumber(u.number, !u.enabled)}
                            className={`min-h-11 rounded-xl px-2.5 py-1.5 text-xs font-semibold transition ${
                              u.enabled
                                ? 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                                : 'bg-teal-600 text-white hover:bg-teal-700'
                            }`}
                          >
                            {u.enabled ? 'Block' : 'Allow'}
                          </button>

                          {confirming ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleDeleteNumber(u.number)}
                                className="min-h-11 rounded-xl bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteNum(null)}
                                className="min-h-11 rounded-xl bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-600"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteNum(u.number)}
                              className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:border-rose-200 hover:bg-rose-50"
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
            </section>}

            {whatsAppPage === 'sync' && <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <Server className="h-4 w-4 text-teal-600" />
                    Service Sync Bridge
                  </h2>
                  <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-slate-600">
                    {data.connectionMode || 'sync'}
                  </span>
                </div>

                <form onSubmit={handleSaveBotConfig} className="mt-3.5 space-y-3">
                  <div className="min-w-0">
                    <label
                      htmlFor="admin-bot-sync-token"
                      className="mb-1 block font-mono text-[11px] font-semibold text-slate-600"
                    >
                      BOT_SYNC_TOKEN
                    </label>
                    <div className="relative">
                      <input
                        id="admin-bot-sync-token"
                        type={showBotToken ? 'text' : 'password'}
                        value={botSyncTokenInput}
                        onChange={(e) => setBotSyncTokenInput(e.target.value)}
                        placeholder="Sync token"
                        className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-3 pr-9 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowBotToken((s) => !s)}
                        aria-label={showBotToken ? 'Hide token' : 'Show token'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      >
                        {showBotToken ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <div className="min-w-0">
                      <label
                        htmlFor="admin-bot-url"
                        className="mb-1 block font-mono text-[11px] font-semibold text-slate-600"
                      >
                        Botkeep inbound URL (optional)
                      </label>
                      <input
                        id="admin-bot-url"
                        type="url"
                        value={botUrlInput}
                        onChange={(e) => setBotUrlInput(e.target.value)}
                        placeholder="Blank = outbound"
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                      />
                    </div>

                    <div className="min-w-0">
                      <label
                        htmlFor="admin-bot-token"
                        className="mb-1 block font-mono text-[11px] font-semibold text-slate-600"
                      >
                          Botkeep bridge token
                      </label>
                      <input
                        id="admin-bot-token"
                        type={showBotToken ? 'text' : 'password'}
                        value={botTokenInput}
                        onChange={(e) => setBotTokenInput(e.target.value)}
                        placeholder="Optional"
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={savingBot}
                    className="inline-flex h-[38px] w-full items-center justify-center rounded-xl bg-teal-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60 sm:w-auto"
                  >
                    {savingBot ? 'Saving…' : 'Save Sync'}
                  </button>
                </form>
              </section>}

              {whatsAppPage === 'hosting' && <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <Power className="h-4 w-4 text-teal-600" />
                    Botkeep server controls
                  </h2>
                  <span
                    className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                      data.panelConfigured
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {data.panelConfigured ? 'Configured' : 'Unset'}
                  </span>
                </div>

                <form onSubmit={handleSavePanel} className="mt-3.5 space-y-3">
                  <p className="text-xs leading-5 text-slate-500">Optional: use a Botkeep Developer API key with workload read and power access. Server status and power controls need both fields.</p>
                  <div className="min-w-0">
                    <label htmlFor="admin-panel-sid" className="mb-1 block text-[11px] font-semibold text-slate-600">Botkeep server ID</label>
                    <input id="admin-panel-sid" type="text" value={panelServerIdInput}
                      onChange={(e) => setPanelServerIdInput(e.target.value)} placeholder="Server ID from Botkeep"
                      className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none" />
                  </div>

                  <div className="min-w-0">
                    <label
                      htmlFor="admin-panel-key"
                      className="mb-1 block font-mono text-[11px] font-semibold text-slate-600"
                    >
                      Botkeep Developer API key
                    </label>
                    <div className="relative">
                      <input
                        id="admin-panel-key"
                        type={showPanelKey ? 'text' : 'password'}
                        value={panelKeyInput}
                        onChange={(e) => setPanelKeyInput(e.target.value)}
                        placeholder="API key"
                        className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-3 pr-9 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPanelKey((s) => !s)}
                        aria-label={showPanelKey ? 'Hide API key' : 'Show API key'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      >
                        {showPanelKey ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={savingPanel}
                    className="inline-flex h-[38px] w-full items-center justify-center rounded-xl border border-teal-600 bg-teal-50 px-4 text-xs font-semibold text-teal-800 transition hover:bg-teal-100 disabled:opacity-60 sm:w-auto"
                  >
                    {savingPanel ? 'Verifying…' : 'Save Botkeep'}
                  </button>
                </form>
              </section>}
          </div>
        )}

        {tab === 'support' && <SupportDesk admin onUnreadChange={setSupportUnread} />}

        {/* Members access control */}
        {tab === 'members' && (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 sm:text-base">
                <UserCheck className="h-4 w-4 text-teal-600" />
                Members
              </h2>

              <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1 text-xs">
                {(['all', 'allowed', 'disallowed'] as MemberFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setMemberFilter(f)}
                    className={`rounded-lg px-2.5 py-1 font-semibold capitalize transition ${
                      memberFilter === f
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {data.users.some((item) => item.approval === 'pending') && <div role="region" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3" aria-label="Pending link approvals">
              <h3 className="text-xs font-bold text-amber-950">Link requests</h3>
              <p className="mt-1 text-[11px] text-amber-800">Members link first. Approve only after their connection is ready.</p>
              <div className="mt-2 space-y-2">{data.users.filter((item) => item.approval === 'pending').map((item) => {
                const linked = data.botReachable && data.accounts?.some((account) => account.number === item.number && account.sessionId && account.claimCurrent === true && ['connected', 'connecting', 'paused'].includes(account.state));
                return <div key={item.number} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-2.5">
                  <div className="min-w-0"><p className="truncate text-xs font-semibold text-slate-800">{item.label || 'Member'} · {item.number}</p><p className="truncate text-[11px] text-slate-500">{item.addedBy || 'Member'} · {linked ? 'Linked, awaiting approval' : 'Waiting for link or service'}</p></div>
                  <div className="flex gap-2"><button type="button" disabled={!linked || busyNumber === item.number} onClick={() => void handleApproval(item.number, 'approve')} className="min-h-[40px] rounded-lg bg-teal-700 px-3 text-xs font-semibold text-white disabled:opacity-40">Approve</button><button type="button" disabled={busyNumber === item.number} onClick={() => void handleApproval(item.number, 'reject')} className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 disabled:opacity-40">Reject</button></div>
                </div>;
              })}</div>
            </div>}

            <p className="mt-2 text-xs leading-5 text-slate-500">{allowedMembersCount} of {data.members.length} allowed.</p>
            <form
              onSubmit={handleAddMember}
              className="mt-3.5 grid grid-cols-1 gap-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-[1.2fr_1fr_auto] sm:items-end"
            >
              <div className="min-w-0">
                <label
                  htmlFor="add-member-email"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Email
                </label>
                <input
                  id="add-member-email"
                  type="email"
                  required
                  value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                  placeholder="member@gmail.com"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div className="min-w-0">
                <label
                  htmlFor="add-member-name"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Name
                </label>
                <input
                  id="add-member-name"
                  type="text"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  placeholder="Optional"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={addingMember}
                className="inline-flex h-[38px] items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
              >
                <UserPlus className="h-4 w-4" />
                {addingMember ? 'Saving…' : 'Allow'}
              </button>
            </form>

            <div className="relative mt-3.5">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Filter members…"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:bg-white focus:outline-none"
              />
            </div>

            <div className="mt-3 divide-y divide-slate-100">
              {filteredMembers.length === 0 ? (
                <p className="py-8 text-center font-mono text-xs text-slate-400">
                  No members found
                </p>
              ) : (
                filteredMembers.map((member) => {
                  const busy = busyEmail === member.email;
                  return (
                    <div
                      key={member.email}
                      className="flex flex-col gap-2.5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-bold text-slate-900">
                            {member.name}
                          </span>
                          {member.isAdmin ? (
                            <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-bold uppercase text-teal-800 ring-1 ring-teal-200">
                              Root
                            </span>
                          ) : member.allowed ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700 ring-1 ring-emerald-200">
                              <ShieldCheck className="h-3 w-3" />
                              Allowed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-700 ring-1 ring-rose-200">
                              <ShieldBan className="h-3 w-3" />
                              Blocked
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                          <span className="break-all font-mono text-slate-700">
                            {member.email}
                          </span>
                          <span>·</span>
                          <span>{member.numbersCount} {member.numbersCount === 1 ? 'number' : 'numbers'}</span>
                          <span>·</span><span>{member.isVerified ? 'Verified' : 'Not verified'}</span>
                        </div>
                        {!member.isAdmin && events.find((event) => event.actor === member.email) && <p className="mt-1 text-xs text-slate-500">Last recorded activity {new Date(events.find((event) => event.actor === member.email)!.createdAt).toLocaleDateString()}</p>}
                      </div>

                      <div className="flex shrink-0 flex-wrap gap-2">
                        {member.isAdmin ? (
                          <span className="font-mono text-[11px] font-semibold text-slate-400">Owner</span>
                        ) : (<>
                          <button type="button" disabled={busy} onClick={() => handleToggleMember(member.email, !member.allowed, member.name)} className={`min-h-10 rounded-xl px-3.5 text-xs font-semibold transition disabled:opacity-50 ${member.allowed ? 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100' : 'bg-teal-600 text-white hover:bg-teal-700'}`}>
                            {busy ? 'Saving…' : member.allowed ? 'Block' : 'Allow'}
                          </button>
                        </>)}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}
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
