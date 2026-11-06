import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { JwtConfigError } from '@/lib/jwt';
import { PANEL_BASE_URL, isPanelServerId } from '@/lib/panel-config';
import { readPanelStatus, sendPanelPowerSignal } from '@/lib/panel-client';
import { getPanelConnectionConfig, savePanelConnectionConfig } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let session;
  try { session = await getAuthenticatedSession(req); }
  catch (err) {
    if (err instanceof JwtConfigError) return NextResponse.json({ error: err.message }, { status: 503 });
    throw err;
  }
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  const action = String(body.action || 'save');

  if (action === 'save') {
    // Never forward a credential to a URL supplied by the browser or an older configuration.
    if (typeof body.panelUrl === 'string' && body.panelUrl.trim() && body.panelUrl.trim() !== PANEL_BASE_URL) {
      return NextResponse.json({ error: 'Only the HiddenCloud panel is supported.' }, { status: 400 });
    }
    const id = typeof body.panelServerId === 'string' ? body.panelServerId.trim() : undefined;
    const key = typeof body.panelApiKey === 'string' && body.panelApiKey !== '••••••••' ? body.panelApiKey.trim() : undefined;
    if (id && !isPanelServerId(id)) return NextResponse.json({ error: 'Invalid HiddenCloud server ID.' }, { status: 400 });
    if (key && !/^[\x21-\x7e]{16,512}$/.test(key)) return NextResponse.json({ error: 'Invalid Botkeep API key.' }, { status: 400 });
    const saved = await savePanelConnectionConfig({ panelServerId: id, panelApiKey: key });
    const status = await readPanelStatus(saved);
    return NextResponse.json({ ok: true, panelServerId: saved.panelServerId, hasPanelApiKey: Boolean(saved.panelApiKey),
      verified: status.configured && status.reachable === true && !status.error,
      verificationError: status.error });
  }

  if (action === 'power') {
    const signal = typeof body.signal === 'string' ? body.signal.toLowerCase() : '';
    if (signal !== 'restart' && signal !== 'start' && signal !== 'stop') {
      return NextResponse.json({ error: 'Unsupported power signal.' }, { status: 400 });
    }
    const cfg = await getPanelConnectionConfig();
    if (!cfg.panelApiKey || !cfg.panelServerId) {
      return NextResponse.json({ error: 'Configure HiddenCloud power controls or manage the server in HiddenCloud.' }, { status: 400 });
    }
    // Tie confirmation to the exact target even if another tab changes settings.
    if (body.serverId !== cfg.panelServerId) return NextResponse.json({ error: 'Server settings changed. Refresh and confirm the target again.' }, { status: 409 });
    const res = await sendPanelPowerSignal(signal, cfg);
    if (res.ok) {
      await recordActivity({ category: 'bot', action: `Service ${signal} requested`, actor: session.user.email, outcome: 'requested', detail: 'HiddenCloud accepted the request.' }).catch(() => {});
      return NextResponse.json({ ok: true, via: 'hiddencloud-api', serverId: res.serverId, message: res.message });
    }
    // Never queue a second action: older service code may still have its own
    // remote power target, and an uncertain API response may have succeeded.
    await recordActivity({ category: 'bot', action: `Service ${signal} request failed`, actor: session.user.email, outcome: 'failed', detail: 'HiddenCloud did not confirm the request.' }).catch(() => {});
    return NextResponse.json({ error: res.error || 'HiddenCloud did not confirm the request.' },
      { status: res.status >= 400 && res.status <= 599 ? res.status : 502 });
  }
  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
}
