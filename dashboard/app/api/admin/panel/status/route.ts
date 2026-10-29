import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { normalizePanelBaseUrl } from '@/lib/panel-client';
import { getPanelConnectionConfig } from '@/lib/storage';
import type { PanelLiveStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Read the configured Pterodactyl-compatible resources endpoint; never infer a server state from the bot heartbeat. */
export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403 });
  const cfg = await getPanelConnectionConfig();
  const checkedAt = Date.now();
  const base: PanelLiveStatus = { configured: Boolean(cfg.panelApiKey && cfg.panelServerId), reachable: null, state: 'unknown', error: null, checkedAt };
  if (!base.configured) return NextResponse.json(base, { headers: { 'Cache-Control': 'no-store' } });

  const panel = normalizePanelBaseUrl(cfg.panelUrl);
  if (panel.error) return NextResponse.json({ ...base, error: 'The panel URL is invalid.' });
  try {
    const res = await fetch(`${panel.baseUrl}/api/client/servers/${encodeURIComponent(cfg.panelServerId)}/resources`, {
      headers: { Authorization: `Bearer ${cfg.panelApiKey}`, Accept: 'application/json' },
      cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) {
      return NextResponse.json({ ...base, reachable: true, error: res.status === 401 || res.status === 403 ? 'Panel credentials were rejected.' : 'Panel did not provide server status.' });
    }
    const json = await res.json().catch(() => null) as { attributes?: { current_state?: unknown; is_suspended?: unknown } } | null;
    const attrs = json?.attributes;
    const reported = typeof attrs?.current_state === 'string' ? attrs.current_state.toLowerCase() : '';
    const state: PanelLiveStatus['state'] = attrs?.is_suspended === true ? 'suspended'
      : reported === 'running' || reported === 'offline' || reported === 'starting' || reported === 'stopping' ? reported : 'unknown';
    return NextResponse.json({ ...base, reachable: true, state }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ...base, reachable: false, error: 'Panel status could not be reached.' }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
