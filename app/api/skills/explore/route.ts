import { NextRequest, NextResponse } from 'next/server';
import { explore } from '@/lib/skills/explorer';

export async function GET(req: NextRequest) {
  try {
    const focus = req.nextUrl.searchParams.get('focus') || 'all';
    const data = await explore(focus);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Skills/explore error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Exploration failed' },
      { status: 500 },
    );
  }
}
