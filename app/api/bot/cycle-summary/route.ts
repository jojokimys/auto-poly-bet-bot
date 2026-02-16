import { NextRequest, NextResponse } from 'next/server';
import { loadProfile } from '@/lib/bot/profile-client';
import { prisma } from '@/lib/db/prisma';
import { getPositions } from '@/lib/skills/position-monitor';
import { getRiskAssessment } from '@/lib/skills/risk-manager';
import { scanForEarlyExits } from '@/lib/skills/early-exit';
import { getCryptoPrices } from '@/lib/skills/crypto-data';
import {
  getPendingOpportunities,
  getQueueStats,
} from '@/lib/bot/opportunity-queue';
import { getBotState, getBotLogs } from '@/lib/bot/skill-engine';
import type { BotState } from '@/lib/bot/types';

// ─── Market Category Detection ──────────────────────────

const CATEGORY_KEYWORDS: Record<string, RegExp> = {
  crypto: /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|token|blockchain|altcoin|defi|nft)\b/i,
  politics: /\b(president|election|trump|biden|congress|senate|vote|democrat|republican|governor|poll|political|impeach)\b/i,
  sports: /\b(nba|nfl|mlb|nhl|soccer|football|basketball|baseball|tennis|ufc|boxing|championship|playoff|super bowl|world cup|match|game score)\b/i,
  economics: /\b(gdp|inflation|fed|interest rate|recession|unemployment|cpi|tariff|stock market|s&p|nasdaq|dow|treasury|fomc|jobs report)\b/i,
  geopolitics: /\b(war|nato|china|russia|ukraine|taiwan|iran|sanction|ceasefire|invasion|conflict|nuclear|missile|diplomat)\b/i,
  tech: /\b(ai |openai|google|apple|microsoft|tesla|spacex|launch|chip|semiconductor|antitrust|ipo|acquisition)\b/i,
};

function detectMarketCategories(questions: string[]): string[] {
  const found = new Set<string>();
  for (const q of questions) {
    for (const [category, re] of Object.entries(CATEGORY_KEYWORDS)) {
      if (re.test(q)) found.add(category);
    }
  }
  return Array.from(found);
}

// ─── GET Handler ────────────────────────────────────────

export async function GET(req: NextRequest) {
  const profileId = req.nextUrl.searchParams.get('profileId');
  if (!profileId) {
    return NextResponse.json(
      { error: 'profileId query parameter is required' },
      { status: 400 },
    );
  }

  try {
    // Phase 0: Load profile once
    const profile = await loadProfile(profileId);
    if (!profile) {
      return NextResponse.json(
        { error: 'Profile not found or missing credentials' },
        { status: 404 },
      );
    }

    // Phase 1: Get positions (sequential — risk depends on this)
    const [positions, dbProfile] = await Promise.all([
      getPositions(profileId, profile),
      prisma.botProfile.findUnique({
        where: { id: profileId },
        select: { maxPortfolioExposure: true },
      }),
    ]);

    // Phase 2: Parallel data collection
    const [risk, earlyExits, crypto] = await Promise.all([
      // Risk needs positions
      positions
        ? getRiskAssessment(profileId, profile, positions, dbProfile?.maxPortfolioExposure ?? undefined)
        : null,
      // Early exit scan (no execution)
      scanForEarlyExits(profileId, 0.90, profile).catch(() => ({
        profileId,
        candidates: [],
        executed: [],
        summary: { totalCandidates: 0, totalExecuted: 0, totalProceeds: 0, capitalFreed: 0 },
      })),
      // Crypto prices
      getCryptoPrices(['BTC', 'ETH', 'SOL']).catch(() => ({
        prices: {},
        timestamp: new Date().toISOString(),
      })),
    ]);

    // Phase 3: In-memory data (synchronous, instant)
    const pending = getPendingOpportunities();
    const queueStats = getQueueStats();
    const engineState = getBotState(profileId) as BotState;
    const recentLogs = getBotLogs(profileId, 20);

    // Phase 4: Detect market categories from opportunity questions
    const questions = pending.map((p) => p.opportunity.question);
    const marketCategories = detectMarketCategories(questions);

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      profileId,
      engine: {
        status: engineState.status,
        cycleCount: engineState.cycleCount,
        lastScanAt: engineState.lastScanAt,
        marketsScanned: engineState.marketsScanned,
        ordersPlaced: engineState.ordersPlaced,
      },
      portfolio: {
        balance: positions?.balance ?? 0,
        heldPositions: positions?.heldPositions ?? [],
        openOrders: positions?.openOrders ?? [],
        exposure: positions?.exposure ?? { total: 0, percentage: 0 },
      },
      risk: risk
        ? {
            level: risk.riskLevel,
            canTrade: risk.canTrade,
            warnings: risk.warnings,
            maxPositionSize: risk.limits.maxPositionSize,
            drawdown: risk.drawdown,
          }
        : {
            level: 'CRITICAL' as const,
            canTrade: false,
            warnings: ['Position data unavailable'],
            maxPositionSize: 0,
            drawdown: { current: 0, maxAllowed: 0.1, peakBalance: 0 },
          },
      earlyExits: {
        candidates: earlyExits.candidates,
        totalProceeds: earlyExits.summary.totalProceeds,
      },
      opportunities: {
        pending: pending.map((p) => ({
          id: p.id,
          type: p.opportunity.type,
          question: p.opportunity.question,
          signal: p.opportunity.signal,
          tokenId: p.opportunity.tokenId,
          outcome: p.opportunity.outcome,
          conditionId: p.opportunity.conditionId,
          suggestedPrice: p.opportunity.suggestedPrice,
          suggestedSize: p.opportunity.suggestedSize,
          expectedProfit: p.opportunity.expectedProfit,
          confidence: p.opportunity.confidence,
          reasoning: p.opportunity.reasoning,
          timeWindow: p.opportunity.timeWindow,
          riskLevel: p.opportunity.riskLevel,
          autoExecutable: p.opportunity.autoExecutable,
          arbLegs: p.opportunity.arbLegs,
          strategy: p.strategy,
          expiresAt: new Date(p.expiresAt).toISOString(),
        })),
        stats: queueStats,
      },
      crypto,
      recentLogs: recentLogs.map((l) => ({
        level: l.level,
        event: l.event,
        message: l.message,
        createdAt: l.createdAt,
      })),
      marketCategories,
    });
  } catch (error) {
    console.error('cycle-summary error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
