import { NextRequest, NextResponse } from 'next/server';
import { getCryptoPrices } from '@/lib/skills/crypto-data';

export async function GET(req: NextRequest) {
  try {
    const symbolsParam = req.nextUrl.searchParams.get('symbols') || 'BTC,ETH';
    const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);

    const data = await getCryptoPrices(symbols);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Skills/crypto error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Crypto data fetch failed' },
      { status: 500 },
    );
  }
}
