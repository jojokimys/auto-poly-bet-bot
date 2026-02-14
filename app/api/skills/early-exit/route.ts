import { NextRequest, NextResponse } from 'next/server';
import { scanForEarlyExits, executeEarlyExits } from '@/lib/skills/early-exit';

/** GET: Scan for early exit candidates (dry run, no trades placed) */
export async function GET(req: NextRequest) {
  try {
    const profileId = req.nextUrl.searchParams.get('profileId');
    if (!profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }

    const threshold = parseFloat(req.nextUrl.searchParams.get('threshold') || '0.90');

    const result = await scanForEarlyExits(profileId, threshold);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Skills/early-exit scan error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Scan failed' },
      { status: 500 },
    );
  }
}

/** POST: Execute early exits (places SELL orders for near-confirmed winners) */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { profileId, threshold, maxSells } = body;

    if (!profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }

    const result = await executeEarlyExits(profileId, { threshold, maxSells });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Skills/early-exit execute error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Execution failed' },
      { status: 500 },
    );
  }
}
