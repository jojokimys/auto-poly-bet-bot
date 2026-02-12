import { NextResponse } from 'next/server';
import { getActiveMarkets } from '@/lib/polymarket/markets';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const markets = await getActiveMarkets({ limit, offset });
    return NextResponse.json({ markets, count: markets.length });
  } catch (error) {
    console.error('Failed to fetch markets:', error);
    return NextResponse.json(
      { error: 'Failed to fetch markets' },
      { status: 500 },
    );
  }
}
