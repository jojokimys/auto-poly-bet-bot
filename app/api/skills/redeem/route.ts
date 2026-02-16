import { NextRequest, NextResponse } from 'next/server';
import { executeRedeem } from '@/lib/skills/redeem';

/** POST: Trigger Playwright redeem (claim resolved positions) */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { profileId, profileName } = body;

    if (!profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }

    const result = await executeRedeem(profileId, profileName);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Skills/redeem error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Redeem failed' },
      { status: 500 },
    );
  }
}
