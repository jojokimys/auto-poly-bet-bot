import 'server-only';

import { prisma } from '@/lib/db/prisma';
import { getDashboardData } from '@/lib/polymarket/analytics';
import type { PerformanceData } from './types';

export async function getPerformance(
  profileId: string,
  period: string = 'all',
): Promise<PerformanceData | null> {
  // Verify profile exists
  const profile = await prisma.botProfile.findUnique({ where: { id: profileId } });
  if (!profile) return null;

  // Get dashboard data (trades + stats from Polymarket API)
  const dashboard = await getDashboardData(profileId);

  // Filter trades by period
  const now = Date.now();
  const periodMs: Record<string, number> = {
    '1d': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };

  let filteredTrades = dashboard.trades;
  if (period !== 'all' && periodMs[period]) {
    const since = now - periodMs[period];
    filteredTrades = dashboard.trades.filter(
      t => new Date(t.matchTime).getTime() >= since,
    );
  }

  // Get AI learnings for this profile
  const learnings = await prisma.aiLearning.findMany({
    where: { profileId, isActive: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  const sells = filteredTrades.filter(t => t.side === 'SELL' && t.realizedPnl !== null);
  const wins = sells.filter(t => t.realizedPnl! > 0);
  const totalPnl = sells.reduce((sum, t) => sum + t.realizedPnl!, 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.realizedPnl!, 0);
  const losses = sells.filter(t => t.realizedPnl! < 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPnl!, 0));

  return {
    period,
    profileId,
    stats: {
      totalTrades: filteredTrades.length,
      winRate: sells.length > 0 ? wins.length / sells.length : 0,
      totalPnl,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      avgTradeSize: filteredTrades.length > 0
        ? filteredTrades.reduce((s, t) => s + t.price * t.size, 0) / filteredTrades.length
        : 0,
      bestTrade: sells.length > 0 ? Math.max(...sells.map(t => t.realizedPnl!)) : 0,
      worstTrade: sells.length > 0 ? Math.min(...sells.map(t => t.realizedPnl!)) : 0,
      totalFees: filteredTrades.reduce((s, t) => s + t.fee, 0),
      openPositions: dashboard.stats.openPositions,
    },
    recentTrades: filteredTrades.slice(-20).reverse().map(t => ({
      conditionId: t.market,
      side: t.side,
      outcome: t.outcome,
      price: t.price,
      size: t.size,
      realizedPnl: t.realizedPnl,
      matchTime: t.matchTime,
    })),
    learnings: learnings.map(l => `[${l.category}] ${l.insight}`),
  };
}
