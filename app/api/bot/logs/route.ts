import { NextRequest, NextResponse } from 'next/server';
import { getBotLogs, getPersistedLogs } from '@/lib/bot/engine';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get('limit') || '50');
  const persisted = searchParams.get('persisted') === 'true';

  try {
    const logs = persisted ? await getPersistedLogs(limit) : getBotLogs(limit);
    return NextResponse.json({ logs });
  } catch (error) {
    console.error('Bot logs API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch bot logs' },
      { status: 500 }
    );
  }
}
