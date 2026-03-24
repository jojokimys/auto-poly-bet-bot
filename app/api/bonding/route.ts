import { NextResponse } from 'next/server';
import { getEngine } from '@/lib/bonding/engine';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const engine = getEngine();
  const url = new URL(req.url);

  if (url.searchParams.get('logs') === 'true') {
    const limit = parseInt(url.searchParams.get('limit') ?? '200', 10);
    return NextResponse.json({ logs: engine.getLogs(limit) });
  }

  return NextResponse.json({ engine: engine.getStatus() });
}

export async function POST(req: Request) {
  const engine = getEngine();
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

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
