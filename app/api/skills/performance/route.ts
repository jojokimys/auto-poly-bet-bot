import { NextRequest, NextResponse } from 'next/server';
import { getPerformance } from '@/lib/skills/performance';

export async function GET(req: NextRequest) {
  try {
    const profileId = req.nextUrl.searchParams.get('profileId');
    if (!profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }

    const period = req.nextUrl.searchParams.get('period') || 'all';
    const data = await getPerformance(profileId, period);

    if (!data) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Skills/performance error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Performance analysis failed' },
      { status: 500 },
    );
  }
}
