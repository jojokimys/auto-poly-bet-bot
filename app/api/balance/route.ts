import { NextResponse } from 'next/server';
import { getBalanceAllowance } from '@/lib/polymarket/trading';

export async function GET() {
  try {
    const balance = await getBalanceAllowance();
    return NextResponse.json(balance);
  } catch (error) {
    console.error('Failed to fetch balance:', error);
    return NextResponse.json(
      { error: 'Failed to fetch balance. Check trading credentials.' },
      { status: 500 },
    );
  }
}
