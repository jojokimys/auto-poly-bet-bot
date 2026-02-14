import 'server-only';

import { prisma } from '@/lib/db/prisma';
import { getPositions } from './position-monitor';
import { DEFAULT_BOT_CONFIG } from '@/lib/bot/types';
import type { RiskData, RiskLevel } from './types';

export async function getRiskAssessment(profileId: string): Promise<RiskData | null> {
  const positions = await getPositions(profileId);
  if (!positions) return null;

  const config = DEFAULT_BOT_CONFIG;
  const { balance, exposure, openOrders, scalperPositions } = positions;

  // Compute exposure percent
  const exposurePercent = exposure.percentage;
  const maxExposurePercent = config.maxPortfolioExposure * 100;

  // Estimate drawdown from recent AI decisions
  const recentDecisions = await prisma.aiDecision.findMany({
    where: { profileId, type: 'trade' },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const totalRecentPnl = recentDecisions.reduce((sum, d) => sum + (d.pnl ?? 0), 0);

  // Estimate peak balance (current + any losses recovered)
  const peakBalance = totalRecentPnl < 0 ? balance - totalRecentPnl : balance;
  const drawdownPercent = peakBalance > 0
    ? Math.round(((balance - peakBalance) / peakBalance) * 10000) / 100
    : 0;
  const maxDrawdown = -10; // -10% max allowed

  // Determine risk level
  let riskLevel: RiskLevel = 'LOW';
  const warnings: string[] = [];

  if (drawdownPercent <= maxDrawdown) {
    riskLevel = 'CRITICAL';
    warnings.push(`Drawdown ${drawdownPercent}% exceeds max allowed ${maxDrawdown}%`);
  } else if (exposurePercent > maxExposurePercent * 1.2) {
    riskLevel = 'HIGH';
    warnings.push(`Exposure ${exposurePercent}% significantly above limit ${maxExposurePercent}%`);
  } else if (exposurePercent > maxExposurePercent) {
    riskLevel = 'MEDIUM';
    warnings.push(`Exposure ${exposurePercent}% slightly above limit ${maxExposurePercent}%`);
  }

  if (balance < 10) {
    riskLevel = 'HIGH';
    warnings.push(`Low balance: $${balance.toFixed(2)}`);
  }

  const totalPositions = openOrders.length + scalperPositions.length;
  const canTrade = riskLevel !== 'CRITICAL' && balance >= 1 && totalPositions < config.maxOpenPositions;

  if (totalPositions >= config.maxOpenPositions) {
    warnings.push(`Max open positions reached (${totalPositions}/${config.maxOpenPositions})`);
  }

  return {
    profileId,
    riskLevel,
    balance,
    totalExposure: exposure.total,
    exposurePercent,
    maxExposurePercent,
    drawdown: {
      current: drawdownPercent,
      maxAllowed: maxDrawdown,
      peakBalance,
    },
    canTrade,
    warnings,
    limits: {
      maxPositionSize: config.maxBetAmount,
      maxOpenPositions: config.maxOpenPositions,
      remainingCapacity: Math.max(0, config.maxOpenPositions - totalPositions),
    },
  };
}
