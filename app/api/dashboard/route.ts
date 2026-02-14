import { NextRequest, NextResponse } from 'next/server';
import { getDashboardData } from '@/lib/polymarket/analytics';

export async function GET(req: NextRequest) {
  try {
    const profileId = req.nextUrl.searchParams.get('profileId');
    const data = await getDashboardData(profileId);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch dashboard data' },
      { status: 500 }
    );
  }
}
