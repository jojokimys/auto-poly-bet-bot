import 'server-only';

import { prisma } from '@/lib/db/prisma';
import { getPositions } from './position-monitor';
import { DEFAULT_BOT_CONFIG } from '@/lib/bot/types';
import type { ProfileCredentials } from '@/lib/bot/profile-client';
import type { RiskData, RiskLevel, PositionData } from './types';

export async function getRiskAssessment(profileId: string, cachedProfile?: ProfileCredentials, cachedPositions?: PositionData, maxPortfolioExposure?: number): Promise<RiskData | null> {
  const positions = cachedPositions ?? await getPositions(profileId, cachedProfile);
  if (!positions) return null;

  const config = DEFAULT_BOT_CONFIG;
  const effectiveExposure = maxPortfolioExposure ?? config.maxPortfolioExposure;
  const { balance, exposure } = positions;

  // Compute exposure percent
  const exposurePercent = exposure.percentage;
  const maxExposurePercent = effectiveExposure * 100;

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

  const canTrade = riskLevel !== 'CRITICAL' && balance >= 1;

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
    },
  };
}
