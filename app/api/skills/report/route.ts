import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createSession,
  endSession,
  saveReport,
  getRecentSessions,
  getLearnings,
} from '@/lib/skills/reporter';

const reportSchema = z.object({
  profileId: z.string().min(1),
  sessionId: z.string().min(1),
  type: z.enum(['cycle', 'daily', 'weekly']),
  summary: z.string().min(1),
  decisions: z.array(z.object({
    action: z.string(),
    conditionId: z.string().optional(),
    reason: z.string(),
    outcome: z.string().optional(),
  })),
  learnings: z.array(z.string()),
  nextPlan: z.string(),
});

// POST: save report, create/end session
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Create new session
    if (body.action === 'create-session') {
      if (!body.profileId) {
        return NextResponse.json({ error: 'profileId required' }, { status: 400 });
      }
      const sessionId = await createSession(body.profileId);
      return NextResponse.json({ sessionId });
    }

    // End session
    if (body.action === 'end-session') {
      if (!body.sessionId) {
        return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
      }
      const session = await endSession(body.sessionId, body.summary);
      return NextResponse.json({ session });
    }

    // Save report
    const parsed = reportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid report', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await saveReport(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Skills/report error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Report save failed' },
      { status: 500 },
    );
  }
}

// GET: fetch sessions and learnings
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const profileId = searchParams.get('profileId');
    const type = searchParams.get('type') || 'sessions';

    if (!profileId) {
      return NextResponse.json({ error: 'profileId required' }, { status: 400 });
    }

    if (type === 'learnings') {
      const category = searchParams.get('category') || undefined;
      const learnings = await getLearnings(profileId, category);
      return NextResponse.json({ learnings });
    }

    const sessions = await getRecentSessions(
      profileId,
      Number(searchParams.get('limit')) || 10,
    );
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error('Skills/report GET error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Report fetch failed' },
      { status: 500 },
    );
  }
}
