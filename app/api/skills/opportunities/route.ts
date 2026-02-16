import { NextRequest, NextResponse } from 'next/server';
import {
  getPendingOpportunities,
  approveOpportunity,
  rejectOpportunity,
  clearQueue,
  getQueueStats,
} from '@/lib/bot/opportunity-queue';

export async function GET() {
  const opportunities = getPendingOpportunities();
  const stats = getQueueStats();

  return NextResponse.json({
    opportunities: opportunities.map((q) => ({
      id: q.id,
      ...q.opportunity,
      strategy: q.strategy,
      status: q.status,
      createdAt: new Date(q.createdAt).toISOString(),
      expiresAt: new Date(q.expiresAt).toISOString(),
    })),
    stats,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, action } = body;

    if (!id || !action) {
      return NextResponse.json(
        { error: 'Missing id or action' },
        { status: 400 },
      );
    }

    if (action === 'approve') {
      const result = approveOpportunity(id);
      if (!result) {
        return NextResponse.json(
          { error: 'Opportunity not found or not pending' },
          { status: 404 },
        );
      }
      return NextResponse.json({ success: true, opportunity: result });
    }

    if (action === 'reject') {
      const result = rejectOpportunity(id);
      if (!result) {
        return NextResponse.json(
          { error: 'Opportunity not found or not pending' },
          { status: 404 },
        );
      }
      return NextResponse.json({ success: true, opportunity: result });
    }

    return NextResponse.json(
      { error: 'Invalid action. Use "approve" or "reject".' },
      { status: 400 },
    );
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 },
    );
  }
}

export async function DELETE() {
  clearQueue();
  return NextResponse.json({ success: true, message: 'Queue cleared' });
}
