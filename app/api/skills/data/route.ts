import { NextRequest, NextResponse } from 'next/server';
import { getMarkets, getOrderBook, getEvents, getSnapshots } from '@/lib/skills/data-collector';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const type = searchParams.get('type') || 'markets';

    switch (type) {
      case 'markets': {
        const markets = await getMarkets({
          limit: Number(searchParams.get('limit')) || 50,
          minLiquidity: Number(searchParams.get('minLiquidity')) || 0,
          minVolume: Number(searchParams.get('minVolume')) || 0,
          sortBy: searchParams.get('sortBy') || 'volume24hr',
        });
        return NextResponse.json({ markets });
      }

      case 'orderbook': {
        const conditionId = searchParams.get('conditionId');
        if (!conditionId) {
          return NextResponse.json({ error: 'conditionId required' }, { status: 400 });
        }
        const orderbook = await getOrderBook(conditionId);
        if (!orderbook) {
          return NextResponse.json({ error: 'Market not found' }, { status: 404 });
        }
        return NextResponse.json(orderbook);
      }

      case 'events': {
        const events = await getEvents({
          limit: Number(searchParams.get('limit')) || 20,
          active: searchParams.get('active') !== 'false',
        });
        return NextResponse.json({ events });
      }

      case 'snapshots': {
        const conditionId = searchParams.get('conditionId');
        if (!conditionId) {
          return NextResponse.json({ error: 'conditionId required' }, { status: 400 });
        }
        const snapshots = await getSnapshots(
          conditionId,
          Number(searchParams.get('hours')) || 24,
        );
        return NextResponse.json(snapshots);
      }

      default:
        return NextResponse.json({ error: `Unknown type: ${type}` }, { status: 400 });
    }
  } catch (error) {
    console.error('Skills/data error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Data collection failed' },
      { status: 500 },
    );
  }
}
