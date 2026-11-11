'use client';

import { Bell, Home, MessageSquare, Smartphone, AlertCircle, CheckCircle2, Loader2, Users } from 'lucide-react';
import { AccountModal } from './account-modal';
import { SupportDesk } from './support-desk';
import { ControlRoomHome } from './control-room-home';
import { ControlRoomActivity } from './control-room-activity';
import { WorkspaceShell, type WorkspaceNavGroup } from './workspace-shell';
import type { RoomTarget } from '@/lib/control-room';
import { AdminTab } from './admin/constants';
import { ConsoleContext, useConsole } from './admin/console-context';
import { useAdminConsoleState } from './admin/use-admin-state';
import { ServerPage } from './admin/server-page';
import { MembersPage } from './admin/members-page';

// The console is only a container: all state, polling and mutations live in
// use-admin-state; each page owns its own markup.
export function AdminConsole() {
  const state = useAdminConsoleState();

  return (
    <ConsoleContext.Provider value={state}>
      <ConsoleShell />
    </ConsoleContext.Provider>
  );
}

function ConsoleShell() {
  const { accountOpen, activePair, activityPage, activityVisited, approvedMembersCount, alerts, checking, data, enabledNumbersCount, events, eventsError, eventsLoading, eventsStorage, lastRestartEvent, handleSignOut, handleUpdateName, loadActivity, loadOverview, loadPanelStatus, navigate, notice, openAlert, overviewCheckedAt, overviewError, pairBannerRef, quota, refreshing, setAccountOpen, setActivityPage, setNotice, setSupportUnread, supportUnread, tab, unreadAlertIds, user } = useConsole();

  if (checking || !user) {
    return (
      <div className="bg-paper flex min-h-screen items-center justify-center px-4">
        <div className="flex items-center gap-2.5 rounded-2xl border border-ink/10 bg-paper px-4 py-3 text-xs font-semibold text-ink/80 shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          Connecting…
        </div>
      </div>
    );
  }

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
                ? 'border-accent/25 bg-accent/10 text-accent'
                : 'border-accent/25 bg-accent/10 text-accent'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              {notice.bad ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-accent" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-accent" />
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

        {tab === 'server' && <ServerPage />}

        {tab === 'support' && <SupportDesk admin onUnreadChange={setSupportUnread} />}

        {/* Members access control */}
        {tab === 'members' && <MembersPage />}
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
