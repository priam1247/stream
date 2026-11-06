'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  HardDrive,
  Layers,
  Terminal,
} from 'lucide-react';

interface LiveAnalyticsProps {
  reachable?: boolean;
  connected?: boolean | null;
  botNumber?: string | null;
  lastSeenSecondsAgo?: number | null;
  uptimeSeconds?: number | null;
  commandsTotal?: number | null;
  downloadsSuccess?: number | null;
  failedTotal?: number | null;
  ramUsedMB?: number | null;
  diskUsedMB?: number | null;
  diskBudgetMB?: number | null;
  queueLight?: number | null;
  queueHeavy?: number | null;
  showResources?: boolean;
}

function formatUptime(totalSec: number | null | undefined, reachable?: boolean): string {
  if (!reachable || totalSec == null || !Number.isFinite(totalSec)) return '—';
  const s = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function LiveAnalytics({
  reachable = false,
  connected = null,
  lastSeenSecondsAgo = null,
  uptimeSeconds = null,
  commandsTotal = null,
  downloadsSuccess = null,
  failedTotal = null,
  ramUsedMB = null,
  diskUsedMB = null,
  diskBudgetMB = null,
  queueLight = null,
  queueHeavy = null,
  showResources = false,
}: LiveAnalyticsProps) {
  const [tickOffset, setTickOffset] = useState(0);

  useEffect(() => {
    setTickOffset(0);
    if (!reachable || !uptimeSeconds) return;
    const id = setInterval(() => {
      setTickOffset((t) => t + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [reachable, uptimeSeconds, lastSeenSecondsAgo]);

  const liveUptime =
    reachable && uptimeSeconds != null ? uptimeSeconds + tickOffset : uptimeSeconds;
  const asCount = (value: number | null) => value != null && Number.isFinite(value) ? Math.max(0, value) : null;
  const cmds = asCount(commandsTotal);
  const okCount = asCount(downloadsSuccess);
  const failCount = asCount(failedTotal);
  const totalJobs = okCount != null && failCount != null ? okCount + failCount : null;
  const successRate = totalJobs != null && totalJobs > 0 && okCount != null
    ? Math.round((okCount / totalJobs) * 100) : null;

  const diskPct =
    diskUsedMB != null && diskBudgetMB && diskBudgetMB > 0
      ? Math.min(100, Math.round((diskUsedMB / diskBudgetMB) * 100))
      : null;

  return (
    <section
      aria-label="Live Server Analytics"
      className="mb-5 overflow-hidden rounded-2xl border border-line bg-paper shadow-sm"
    >
      {/* Server Telemetry Header Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-wash bg-wash px-3.5 py-2.5 text-ink sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {reachable && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok-600 opacity-75 motion-reduce:animate-none" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                reachable && connected === true
                  ? 'bg-ok-600'
                  : reachable && connected === false
                    ? 'bg-warn-600'
                    : 'bg-faint'
              }`}
            />
          </span>
          <Activity className="h-3.5 w-3.5 shrink-0 text-accent-600" />
          <span className="text-xs font-bold">
            Analytics
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              reachable && connected === true
                ? 'bg-ok-100 text-ok-800'
                : reachable && connected === false
                  ? 'bg-warn-100 text-warn-800'
                  : 'bg-line text-muted'
            }`}
          >
            {reachable && connected === true ? 'WhatsApp connected' : reachable && connected === false ? 'WhatsApp disconnected' : 'No current status'}
          </span>
        </div>

        <div className="flex min-w-0 items-center gap-2.5 font-mono text-[11px] text-muted tabular-nums">
          {lastSeenSecondsAgo != null && (
            <span className="text-faint">
              sync {Math.max(0, lastSeenSecondsAgo)}s
            </span>
          )}
        </div>
      </div>

      {/* 4 Core Live Counters: Commands, Successful Downloads, Failed, Uptime */}
      <div className="grid grid-cols-2 divide-x divide-y divide-wash sm:grid-cols-4 sm:divide-y-0">
        <div className="min-w-0 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <span className="truncate">Commands</span>
            <Terminal className="h-3.5 w-3.5 shrink-0 text-faint" />
          </div>
          <div className="mt-1 font-mono text-xl font-extrabold text-ink tabular-nums sm:text-2xl">
            {cmds == null ? '—' : cmds.toLocaleString()}
          </div>
        </div>

        <div className="min-w-0 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <span className="truncate" title="Successful downloads">Downloads OK</span>
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ok-600" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-xl font-extrabold text-ok-700 tabular-nums sm:text-2xl">
              {okCount == null ? '—' : okCount.toLocaleString()}
            </span>
            {successRate !== null && (
              <span className="font-mono text-[11px] font-semibold text-ok-600 tabular-nums">
                {successRate}%
              </span>
            )}
          </div>
        </div>

        <div className="min-w-0 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <span className="truncate">Failed</span>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-bad-500" />
          </div>
          <div className="mt-1 font-mono text-xl font-extrabold text-bad-600 tabular-nums sm:text-2xl">
            {failCount == null ? '—' : failCount.toLocaleString()}
          </div>
        </div>

        <div className="min-w-0 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <span className="truncate">Uptime</span>
            <Clock className="h-3.5 w-3.5 shrink-0 text-accent-600" />
          </div>
          <div className="mt-1 truncate font-mono text-lg font-extrabold text-ink tabular-nums sm:text-2xl">
            {formatUptime(liveUptime, reachable)}
          </div>
        </div>
      </div>

      {/* Live Server Resource Strip (RAM, Disk, Queues) */}
      {showResources && (
        <div className="grid grid-cols-1 gap-2 border-t border-wash bg-wash/80 px-3.5 py-2.5 text-xs sm:grid-cols-3 sm:gap-4 sm:px-5">
          <div className="flex min-w-0 items-center justify-between gap-2 font-mono text-[11px] text-muted tabular-nums">
            <span className="inline-flex items-center gap-1.5 font-sans font-semibold text-muted">
              <Cpu className="h-3.5 w-3.5 text-accent-600" />
              RAM
            </span>
            <span className="font-bold text-ink-soft">
              {ramUsedMB != null ? `${ramUsedMB} MB` : '—'}
            </span>
          </div>

          <div className="flex min-w-0 items-center justify-between gap-2 font-mono text-[11px] text-muted tabular-nums">
            <span className="inline-flex shrink-0 items-center gap-1.5 font-sans font-semibold text-muted">
              <HardDrive className="h-3.5 w-3.5 text-accent-600" />
              Disk
            </span>
            <div className="flex min-w-0 items-center gap-2">
              {diskPct !== null && (
                <div className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-line xs:block sm:block">
                  <div
                    className={`h-full ${diskPct > 85 ? 'bg-bad-500' : 'bg-accent-600'}`}
                    style={{ width: `${diskPct}%` }}
                  />
                </div>
              )}
              <span className="truncate font-bold text-ink-soft">
                {diskUsedMB != null && diskBudgetMB != null
                  ? `${diskUsedMB} / ${diskBudgetMB} MB`
                  : '—'}
              </span>
            </div>
          </div>

          <div className="flex min-w-0 items-center justify-between gap-2 font-mono text-[11px] text-muted tabular-nums">
            <span className="inline-flex items-center gap-1.5 font-sans font-semibold text-muted">
              <Layers className="h-3.5 w-3.5 text-accent-600" />
              Queues
            </span>
            <span className="font-bold text-ink-soft">
              L:{queueLight ?? '—'} · H:{queueHeavy ?? '—'}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
