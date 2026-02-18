import { NextRequest, NextResponse } from 'next/server';
import { fetchKlines } from '@/lib/mm/volatility';

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol') ?? 'BTCUSDT';
  const interval = req.nextUrl.searchParams.get('interval') ?? '1m';
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10), 200);

  try {
    const candles = await fetchKlines(symbol, interval, limit);
    const klines = candles.map((c) => ({
      time: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    return NextResponse.json({ klines });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch klines' },
      { status: 500 },
    );
  }
}
