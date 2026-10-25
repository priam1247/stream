import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { cleanPanelUrl, testScribdConnection } from '@/lib/scribd-panel';
import { getScribdConnectionConfig, saveScribdConnectionConfig } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * GET /api/scribd/config — where the panel is, and whether the key works.
 *
 * The key is never echoed back: the page only learns whether one is saved, the
 * same way the Pterodactyl panel block in /admin behaves.
 */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  const config = await getScribdConnectionConfig();
  const check = await testScribdConnection();

  return NextResponse.json({
    ok: true,
    panelUrl: config.panelUrl,
    hasPanelKey: Boolean(config.panelKey),
    updatedAt: config.updatedAt || null,
    ...check,
  });
}

/**
 * PATCH /api/scribd/config  { panelUrl?: string, panelKey?: string }
 *
 * Saved into portal_settings in Cloudflare D1 (or the disk store in local dev),
 * so the address can be changed from the dashboard without a redeploy.
 */
export async function PATCH(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  const body = (await req.json().catch(() => null)) as
    | { panelUrl?: unknown; panelKey?: unknown }
    | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const patch: { panelUrl?: string; panelKey?: string } = {};

  if (typeof body.panelUrl === 'string') {
    const typed = body.panelUrl.trim();
    if (typed) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(typed);
      } catch {
        parsed = null;
      }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        return NextResponse.json(
          { error: 'The panel address must be a full URL, e.g. http://195.123.189.187:25811.' },
          { status: 400 },
        );
      }
      patch.panelUrl = cleanPanelUrl(typed);
    } else {
      patch.panelUrl = '';
    }
  }

  if (typeof body.panelKey === 'string') {
    // An empty string is meaningful: it clears a key from a panel that was
    // locked and then unlocked.
    patch.panelKey = body.panelKey.trim();
  }

  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: 'Nothing to save.' }, { status: 400 });
  }

  const saved = await saveScribdConnectionConfig(patch);
  const check = await testScribdConnection();

  return NextResponse.json({
    ok: true,
    panelUrl: saved.panelUrl,
    hasPanelKey: Boolean(saved.panelKey),
    updatedAt: saved.updatedAt || null,
    ...check,
  });
}
