import { NextRequest, NextResponse } from 'next/server';
import { getBotLogs, getPersistedLogs } from '@/lib/bot/skill-engine';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get('limit') || '50');
  const persisted = searchParams.get('persisted') === 'true';
  const profileId = searchParams.get('profileId') || undefined;

  try {
    const logs = persisted
      ? await getPersistedLogs(limit, profileId)
      : getBotLogs(profileId, limit);
    return NextResponse.json({ logs });
  } catch (error) {
    console.error('Bot logs API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch bot logs' },
      { status: 500 },
    );
  }
}
