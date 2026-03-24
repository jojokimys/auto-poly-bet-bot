import { NextResponse } from 'next/server';
import { getReversalEngine } from '@/lib/reversal/engine';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const engine = getReversalEngine();
  const url = new URL(req.url);

  if (url.searchParams.get('trades') === 'true') {
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    return NextResponse.json({ trades: engine.getTrades(limit) });
  }

  if (url.searchParams.get('logs') === 'true') {
    const limit = parseInt(url.searchParams.get('limit') ?? '200', 10);
    return NextResponse.json({ logs: engine.getLogs(limit) });
  }

  if (url.searchParams.get('depth') === 'true') {
    return NextResponse.json({ depth: engine.getDepthData() });
  }

  return NextResponse.json({ engine: engine.getStatus() });
}

export async function POST(req: Request) {
  const engine = getReversalEngine();
  const body = await req.json();

  const { action, profileId } = body;

  if (action === 'start') {
    if (!profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }
    if (engine.isRunning()) {
      return NextResponse.json({ error: 'Engine already running' }, { status: 409 });
    }
    try {
      await engine.start(profileId);
      return NextResponse.json({ ok: true, status: engine.getStatus() });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  if (action === 'stop') {
    engine.stop();
    return NextResponse.json({ ok: true });
  }

  if (action === 'toggles') {
    const { collect, trend, reversal } = body;
    engine.setToggles({ collect, trend, reversal });
    return NextResponse.json({ ok: true, status: engine.getStatus() });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
