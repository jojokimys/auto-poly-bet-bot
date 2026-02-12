import { NextResponse } from 'next/server';
import { getMarketByConditionId, getOrderBook } from '@/lib/polymarket/markets';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ conditionId: string }> },
) {
  try {
    const { conditionId } = await params;
    const market = await getMarketByConditionId(conditionId);

    // Fetch order books for each outcome
    const orderBooks = await Promise.all(
      market.outcomes.map(async (outcome) => {
        if (!outcome.tokenId) return null;
        try {
          return await getOrderBook(outcome.tokenId);
        } catch {
          return null;
        }
      }),
    );

    return NextResponse.json({ market, orderBooks: orderBooks.filter(Boolean) });
  } catch (error) {
    console.error('Failed to fetch market:', error);
    return NextResponse.json(
      { error: 'Failed to fetch market detail' },
      { status: 500 },
    );
  }
}
