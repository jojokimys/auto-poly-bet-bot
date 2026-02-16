import 'server-only';

import { prisma } from '@/lib/db/prisma';
import type { ReportRequest } from './types';

export async function createSession(profileId: string): Promise<string> {
  const session = await prisma.aiSession.create({
    data: { profileId },
  });
  return session.id;
}

export async function endSession(sessionId: string, summary?: string) {
  const session = await prisma.aiSession.findUnique({ where: { id: sessionId } });
  if (!session) return null;

  const decisions = await prisma.aiDecision.findMany({
    where: { sessionId },
  });

  const totalPnl = decisions.reduce((sum, d) => sum + (d.pnl ?? 0), 0);

  return prisma.aiSession.update({
    where: { id: sessionId },
    data: {
      endedAt: new Date(),
      cycleCount: session.cycleCount,
      totalPnl,
      summary,
    },
  });
}

export async function incrementCycle(sessionId: string) {
  return prisma.aiSession.update({
    where: { id: sessionId },
    data: { cycleCount: { increment: 1 } },
  });
}

export async function logDecision(params: {
  sessionId: string;
  profileId: string;
  type: string;
  conditionId?: string;
  action?: string;
  tokenId?: string;
  outcome?: string;
  price?: number;
  size?: number;
  reason: string;
  confidence: number;
  strategy?: string;
}) {
  return prisma.aiDecision.create({ data: params });
}

export async function logLearning(params: {
  profileId: string;
  category: string;
  insight: string;
  confidence: number;
  source: string;
}) {
  return prisma.aiLearning.create({ data: params });
}

export async function saveReport(req: ReportRequest) {
  // Save decisions
  for (const decision of req.decisions) {
    await prisma.aiDecision.create({
      data: {
        sessionId: req.sessionId,
        profileId: req.profileId,
        type: decision.action === 'BUY' || decision.action === 'SELL' ? 'trade' : 'skip',
        conditionId: decision.conditionId,
        action: decision.action,
        reason: decision.reason,
        confidence: 50,
        result: decision.outcome,
      },
    });
  }

  // Save learnings
  for (const insight of req.learnings) {
    await prisma.aiLearning.create({
      data: {
        profileId: req.profileId,
        category: 'session',
        insight,
        confidence: 70,
        source: `session:${req.sessionId}`,
      },
    });
  }

  // Update session summary
  await prisma.aiSession.update({
    where: { id: req.sessionId },
    data: {
      summary: `${req.summary}\n\nNext plan: ${req.nextPlan}`,
      cycleCount: { increment: 1 },
    },
  });

  return { saved: true, reportId: req.sessionId };
}

export async function getRecentSessions(profileId: string, limit = 10) {
  return prisma.aiSession.findMany({
    where: { profileId },
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: {
      decisions: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
  });
}

export async function getLearnings(profileId: string, category?: string) {
  return prisma.aiLearning.findMany({
    where: {
      profileId,
      isActive: true,
      ...(category ? { category } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
