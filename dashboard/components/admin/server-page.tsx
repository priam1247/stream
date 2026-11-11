'use client';

import { Eye, EyeOff, Link2, Plus, Power, RefreshCw, Search, Server, Trash2 } from 'lucide-react';
import { PairingCodeBanner } from '../pairing-code-banner';
import { accountStatusLabel } from '@/lib/whatsapp-accounts';
import { LiveAnalytics } from '../live-analytics';
import { CommandDirectory } from '../command-directory';
import { SectionNav } from '../section-nav';
import { WHATSAPP_PAGES } from './constants';

import { useConsole } from './console-context';

export function ServerPage() {
  const { activePair, addingNumber, botSyncTokenInput, busyNumber, confirmDeleteNum, data, enabledNumbersCount, events, filteredNumbers, handleAddNumber, handleDeleteNumber, handlePairNumber, handlePanelPower, handleSaveBotConfig, handleSavePanel, handleToggleGlobalBot, handleToggleNumber, lastRestartEvent, numInput, numLabel, numberFilter, numberSearch, overviewCheckedAt, overviewError, pairBannerRef, panelKeyInput, panelServerIdInput, panelStatus, savingBot, savingPanel, sendingPower, setActivePair, setBotSyncTokenInput, setConfirmDeleteNum, setNotice, setNumInput, setNumLabel, setNumberFilter, setNumberSearch, setPanelKeyInput, setPanelServerIdInput, setShowBotToken, setShowPanelKey, setWhatsAppPage, showBotToken, showPanelKey, whatsAppPage } = useConsole();

  return (
    <>
      <div className="space-y-4">
        <h1 className="font-display px-0.5 text-[28px] font-semibold tracking-tight text-ink">WhatsApp</h1>
        <SectionNav label="WhatsApp pages" items={WHATSAPP_PAGES} value={whatsAppPage} onChange={setWhatsAppPage} />
        {whatsAppPage === 'service' && (
              <>
            <section className="mb-4 rounded-2xl border border-ink/10 bg-paper p-4 shadow-sm sm:p-5">
              <h2 className="text-sm font-bold text-ink sm:text-base">Service status</h2>
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-xl bg-ink/5 p-3"><p className="text-xs text-ink/60">HiddenCloud server</p><p className="mt-1 text-sm font-semibold capitalize text-ink/80">{!panelStatus ? 'Checking' : panelStatus.configured === false ? 'Not configured' : panelStatus.state}</p>{panelStatus?.error && <p className="mt-1 break-words text-[11px] text-ink/60">{panelStatus.error}</p>}</div>
                <div className="rounded-xl bg-ink/5 p-3"><p className="text-xs text-ink/60">Service bridge</p><p className="mt-1 text-sm font-semibold text-ink/80">{overviewError || overviewCheckedAt == null ? 'Unknown' : data.botReachable ? 'Reachable' : data.botServerLinked ? 'Not reporting' : 'Not linked'}</p><p className="mt-1 text-[11px] text-ink/60">{overviewError ? 'Last check failed' : overviewCheckedAt == null ? 'Awaiting first check' : data.lastSeenSecondsAgo != null ? `Last heartbeat ${data.lastSeenSecondsAgo}s ago` : 'No heartbeat reported'}</p></div>
                <div className="rounded-xl bg-ink/5 p-3"><p className="text-xs text-ink/60">WhatsApp</p><p className="mt-1 text-sm font-semibold text-ink/80">{overviewError || !data.botReachable || data.connected == null ? 'Unknown' : data.connected ? 'Connected' : 'Disconnected'}</p></div>
              </div>
              {overviewError && <p role="alert" className="mt-3 text-xs text-accent">Status could not be refreshed. Check Sync settings.</p>}
              {!overviewError && data.botVersion && <p className="mt-3 break-all text-xs text-ink/60">Reported version {data.botVersion}</p>}
              {!overviewError && data.botError && <p className="mt-3 text-xs leading-5 text-accent">{data.botError} Check the service process and Sync settings.</p>}
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
              <section className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-ink/10 bg-paper p-3 shadow-sm sm:px-4">
                <div className="flex w-full items-center justify-between gap-2"><h2 className="text-sm font-bold text-ink">Server power</h2><span className="text-xs font-semibold capitalize text-ink/60">{!panelStatus ? 'Checking' : panelStatus.configured === false ? 'Not configured' : panelStatus.state}</span></div>
                {panelStatus?.error && <p className="w-full break-words text-xs text-accent">{panelStatus.error}</p>}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={sendingPower !== null}
                    onClick={() => handlePanelPower('restart')}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-paper shadow-sm transition hover:bg-accent disabled:opacity-50"
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
                    className="min-h-11 rounded-xl border border-ink/15 bg-ink/5 px-3 py-2 text-xs font-semibold text-ink transition hover:bg-ink/10 disabled:opacity-50"
                  >
                    {sendingPower === 'start' ? 'Starting…' : 'Start service'}
                  </button>

                  <button
                    type="button"
                    disabled={sendingPower !== null}
                    onClick={() => handlePanelPower('stop')}
                    className="min-h-11 rounded-xl border border-accent/25 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent transition hover:bg-accent/15 disabled:opacity-50"
                  >
                    {sendingPower === 'stop' ? 'Stopping…' : 'Stop service'}
                  </button>
                </div>

                                {lastRestartEvent && <p className="w-full text-[11px] text-ink/60">Last restart request: {new Date(lastRestartEvent.createdAt).toLocaleString()}. A request is not confirmation of a completed restart.</p>}
              </section>
            )}

            {whatsAppPage === 'commands' && <section aria-label="Service command reference" className="space-y-2.5"><h2 className="px-0.5 text-sm font-bold text-ink sm:text-base">Service command reference</h2><p className="px-0.5 text-xs text-ink/60">Reference only; command access is controlled by the bot.</p><CommandDirectory /></section>}

            {whatsAppPage === 'sync' && <section className="rounded-2xl border border-ink/10 bg-paper p-4 shadow-sm" aria-label="Session recovery status">
              <h2 className="text-sm font-bold text-ink">Encrypted session recovery</h2>
              <p className="mt-1 text-xs leading-5 text-ink/60">{!data.botReachable ? 'Service offline; backup status cannot be confirmed.' : !data.sessionBackup ? 'The service has not reported recovery status. Update the service to enable it.' : data.sessionBackup.state === 'disabled' ? 'Not configured. Set a private SESSION_BACKUP_KEY on the service and configure durable D1 storage.' : data.sessionBackup.state === 'error' ? 'Backup or revocation failed. Check the service logs and dashboard storage.' : data.sessionBackup.state === 'conflict' ? 'Local sessions were preserved; a backup conflict needs review.' : data.sessionBackup.state === 'starting' ? 'Connecting to encrypted recovery.' : data.sessionBackup.lastBackupAt ? `Recovery connected. Last encrypted snapshot: ${new Date(data.sessionBackup.lastBackupAt).toLocaleString()}.` : 'Recovery connected. No session snapshot has been saved yet.'}</p>
              {data.botReachable && data.sessionBackup?.state === 'ready' && data.sessionBackup.sessions !== undefined && data.sessionBackup.backedUp !== undefined && <p className="mt-2 text-xs font-semibold text-ink/80">{data.sessionBackup.backedUp} of {data.sessionBackup.sessions} registered sessions have a current snapshot.</p>}
              {data.storageEngine !== 'cloudflare-d1' && <p className="mt-2 text-xs font-semibold text-accent">Cloudflare D1 has not been confirmed. Storage calls fail until it is configured.</p>}
            </section>}

            {whatsAppPage === 'numbers' && <section className="rounded-2xl border border-ink/10 bg-paper p-4 shadow-sm sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-ink sm:text-base">
                  Approved numbers
                </h2>
                <span className="whitespace-nowrap font-mono text-xs text-ink/60 tabular-nums">
                  {enabledNumbersCount}/{data.users.length} enabled
                </span>
              </div>

              <div className={`mt-3 rounded-xl border px-3 py-2.5 text-xs leading-5 ${data.whitelistSync === 'synced' && !overviewError ? 'border-accent/15 bg-accent/10 text-accent' : 'border-ink/10 bg-ink/5 text-ink/60'}`}>
                <span className="font-semibold">{overviewError ? 'Sync status unavailable' : data.whitelistSync === 'synced' ? 'Service reports the latest number list' : data.whitelistSync === 'pending' ? 'Number list waiting for service sync' : 'Number sync not confirmed'}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink/10 bg-ink/5 p-3">
                <div className="min-w-0"><p className="text-xs font-semibold text-ink/80">Member linking: {data.botEnabledForMembers ? 'Open' : 'Paused'}</p><p className="mt-1 text-[11px] leading-4 text-ink/60">Pausing stops new requests, not approved numbers.</p></div>
                <button
                  type="button"
                  onClick={handleToggleGlobalBot}
                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition ${
                    data.botEnabledForMembers
                      ? 'border-accent/25 bg-accent/10 text-accent hover:bg-accent/15'
                      : 'border-accent/25 bg-accent/10 text-accent hover:bg-accent/15'
                  }`}
                >
                  <Power className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {data.botEnabledForMembers ? 'Pause linking' : 'Resume linking'}
                  </span>
                </button>
              </div>
              <p className="mt-3 text-xs leading-5 text-ink/60">Approve a number, then request a code. A code alone does not confirm linking.</p>

              <form
                onSubmit={handleAddNumber}
                className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-[1.1fr_1fr_auto] sm:items-end"
              >
                <div className="min-w-0">
                  <label
                    htmlFor="admin-add-num"
                    className="mb-1 block text-xs font-medium text-ink/80"
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
                    className="w-full rounded-xl border border-ink/20 bg-paper px-3.5 py-2.5 font-mono text-sm text-ink placeholder:text-ink/40 focus:border-accent focus:outline-none tabular-nums"
                  />
                </div>
                <div className="min-w-0">
                  <label
                    htmlFor="admin-add-label"
                    className="mb-1 block text-xs font-medium text-ink/80"
                  >
                    Label
                  </label>
                  <input
                    id="admin-add-label"
                    type="text"
                    value={numLabel}
                    onChange={(e) => setNumLabel(e.target.value)}
                    placeholder="Operator"
                    className="w-full rounded-xl border border-ink/20 bg-paper px-3.5 py-2.5 text-sm text-ink placeholder:text-ink/40 focus:border-accent focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={addingNumber}
                  className="inline-flex h-[42px] items-center justify-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-semibold text-paper shadow-sm transition hover:bg-accent disabled:opacity-60"
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
                <div className="relative min-w-0 flex-1 basis-44"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" /><input type="search" aria-label="Search WhatsApp numbers" value={numberSearch} onChange={(event) => setNumberSearch(event.target.value)} placeholder="Search number, label or owner" className="min-h-11 w-full rounded-xl border border-ink/10 bg-ink/5 py-2 pl-9 pr-3 text-base text-ink outline-none focus:border-accent focus:bg-paper sm:text-sm" /></div>
                <select aria-label="Filter WhatsApp numbers" value={numberFilter} onChange={(event) => setNumberFilter(event.target.value as 'all' | 'allowed' | 'blocked')} className="min-h-11 rounded-xl border border-ink/10 bg-paper px-3 text-sm text-ink/80"><option value="all">All numbers</option><option value="allowed">Allowed</option><option value="blocked">Blocked</option></select>
              </div>
              <div className="mt-2 divide-y divide-ink/5">
                {filteredNumbers.length === 0 ? (
                  <p className="py-6 text-center font-mono text-xs text-ink/40">
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
                            <span className="font-mono text-sm font-bold text-ink tabular-nums">
                              +{u.number}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                                u.enabled
                                  ? 'bg-ink/5 text-ink ring-1 ring-ink/15'
                                  : 'bg-accent/10 text-accent ring-1 ring-accent/25'
                              }`}
                            >
                              {u.enabled ? 'Allowed' : 'Blocked'}
                            </span>
                          </div>
                          <p className="mt-1 text-xs font-medium text-accent">{accountStatusLabel(overviewError || !data.botReachable ? null : data.accounts, u.number)}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink/60">
                            <span className="truncate">{u.label || 'Approved'}</span>
                            {u.addedBy && (
                              <>
                            <span>·</span>
                            <span className="break-all font-mono text-[11px] text-ink/60">
                              {u.addedBy}
                            </span>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={!u.enabled || busy || accountState === 'connected' || accountState === 'connecting'}
                            onClick={() => handlePairNumber(u.number)}
                            className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-ink/10 bg-ink/5 px-2.5 py-1.5 text-xs font-semibold text-ink/80 transition hover:border-accent/25 hover:bg-accent/10 hover:text-accent disabled:opacity-40"
                          >
                            <Link2 className="h-3.5 w-3.5 text-accent" />
                            Get code
                          </button>

                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleToggleNumber(u.number, !u.enabled)}
                            className={`min-h-11 rounded-xl px-2.5 py-1.5 text-xs font-semibold transition ${
                              u.enabled
                                ? 'border border-accent/25 bg-accent/10 text-accent hover:bg-accent/15'
                                : 'bg-accent text-paper hover:bg-accent'
                            }`}
                          >
                            {u.enabled ? 'Block' : 'Allow'}
                          </button>

                          {confirming ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleDeleteNumber(u.number)}
                                className="min-h-11 rounded-xl bg-accent px-2.5 py-1.5 text-xs font-semibold text-paper"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteNum(null)}
                                className="min-h-11 rounded-xl bg-ink/5 px-2.5 py-1.5 text-xs font-medium text-ink/60"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteNum(u.number)}
                              className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-ink/10 bg-paper px-2.5 py-1.5 text-xs font-semibold text-accent hover:border-accent/25 hover:bg-accent/10"
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

            {whatsAppPage === 'sync' && <section className="rounded-2xl border border-ink/10 bg-paper p-4 shadow-sm sm:p-5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
                    <Server className="h-4 w-4 text-accent" />
                    Service Sync
                  </h2>
                  <span className="rounded bg-ink/5 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-ink/60">
                    {data.connectionMode === 'heartbeat' ? 'outbound' : 'not linked'}
                  </span>
                </div>

                <form onSubmit={handleSaveBotConfig} className="mt-3.5 space-y-3">
                  <div className="min-w-0">
                    <label
                      htmlFor="admin-bot-sync-token"
                      className="mb-1 block font-mono text-[11px] font-semibold text-ink/60"
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
                        className="w-full rounded-xl border border-ink/20 bg-paper py-2 pl-3 pr-9 font-mono text-xs text-ink placeholder:text-ink/40 focus:border-accent focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowBotToken((s) => !s)}
                        aria-label={showBotToken ? 'Hide token' : 'Show token'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink/40 hover:text-ink/80"
                      >
                        {showBotToken ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={savingBot}
                    className="inline-flex h-[38px] w-full items-center justify-center rounded-xl bg-accent px-4 text-xs font-semibold text-paper shadow-sm transition hover:bg-accent disabled:opacity-60 sm:w-auto"
                  >
                    {savingBot ? 'Saving…' : 'Save Sync'}
                  </button>
                </form>
              </section>}

              {whatsAppPage === 'hosting' && <section className="rounded-2xl border border-ink/10 bg-paper p-4 shadow-sm sm:p-5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
                    <Power className="h-4 w-4 text-accent" />
                    HiddenCloud server controls
                  </h2>
                  <span
                    className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                      data.panelConfigured
                        ? 'bg-ink/5 text-ink'
                        : 'bg-ink/5 text-ink/60'
                    }`}
                  >
                    {data.panelConfigured ? 'Configured' : 'Unset'}
                  </span>
                </div>

                <form onSubmit={handleSavePanel} className="mt-3.5 space-y-3">
                  <p className="text-xs leading-5 text-ink/60">Client API key from Account → API Credentials. Status and power need both fields; the ID comes prefilled.</p>
                  <div className="min-w-0">
                    <label htmlFor="admin-panel-sid" className="mb-1 block text-[11px] font-semibold text-ink/60">HiddenCloud server ID</label>
                    <input id="admin-panel-sid" type="text" value={panelServerIdInput}
                      onChange={(e) => setPanelServerIdInput(e.target.value)} placeholder="a6451c6c"
                      className="w-full rounded-xl border border-ink/20 bg-paper px-3 py-2 font-mono text-xs text-ink placeholder:text-ink/40 focus:border-accent focus:outline-none" />
                  </div>

                  <div className="min-w-0">
                    <label
                      htmlFor="admin-panel-key"
                      className="mb-1 block font-mono text-[11px] font-semibold text-ink/60"
                    >
                      HiddenCloud client API key
                    </label>
                    <div className="relative">
                      <input
                        id="admin-panel-key"
                        type={showPanelKey ? 'text' : 'password'}
                        value={panelKeyInput}
                        onChange={(e) => setPanelKeyInput(e.target.value)}
                        placeholder="API key"
                        className="w-full rounded-xl border border-ink/20 bg-paper py-2 pl-3 pr-9 font-mono text-xs text-ink placeholder:text-ink/40 focus:border-accent focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPanelKey((s) => !s)}
                        aria-label={showPanelKey ? 'Hide API key' : 'Show API key'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink/40 hover:text-ink/80"
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
                    className="inline-flex h-[38px] w-full items-center justify-center rounded-xl border border-accent bg-accent/10 px-4 text-xs font-semibold text-accent transition hover:bg-accent/15 disabled:opacity-60 sm:w-auto"
                  >
                    {savingPanel ? 'Verifying…' : 'Save HiddenCloud'}
                  </button>
                </form>
              </section>}
          </div>
    </>
  );
}
