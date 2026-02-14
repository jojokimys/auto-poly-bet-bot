import { NextRequest, NextResponse } from 'next/server';
import { getRiskAssessment } from '@/lib/skills/risk-manager';

export async function GET(req: NextRequest) {
  try {
    const profileId = req.nextUrl.searchParams.get('profileId');
    if (!profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }

    const data = await getRiskAssessment(profileId);
    if (!data) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Skills/risk error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Risk assessment failed' },
      { status: 500 },
    );
  }
}
