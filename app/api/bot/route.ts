import { NextRequest, NextResponse } from 'next/server';
import { startBot, stopBot, getBotState } from '@/lib/bot/engine';
import { hasTradeCredentials } from '@/lib/config/env';

export async function GET() {
  const state = getBotState();
  return NextResponse.json(state);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action;

    if (action === 'start') {
      if (!hasTradeCredentials()) {
        return NextResponse.json(
          { error: 'Trading credentials not configured. Set them in Settings first.' },
          { status: 400 }
        );
      }
      const state = await startBot();
      return NextResponse.json(state);
    }

    if (action === 'stop') {
      const state = await stopBot();
      return NextResponse.json(state);
    }

    return NextResponse.json({ error: 'Invalid action. Use "start" or "stop".' }, { status: 400 });
  } catch (error) {
    console.error('Bot API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to control bot' },
      { status: 500 }
    );
  }
}
