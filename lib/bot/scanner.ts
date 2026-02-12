import 'server-only';

import { fetchMarkets } from '@/lib/polymarket/gamma';
import type { GammaMarket } from '@/lib/types/polymarket';
import type { BotConfig, ScoredOpportunity } from './types';

/**
 * Score a market for trading opportunity.
 * Adapted from scripts/market-scanner.ts to use lib modules.
 */
function scoreMarket(gm: GammaMarket): ScoredOpportunity | null {
  const volume24hr = parseFloat(gm.volume24hr || '0');
  const liquidity = parseFloat(gm.liquidity) || 0;
  const spread = parseFloat(gm.spread || '0');

  let yesPrice = 0;
  let noPrice = 0;
  let outcomes: string[] = [];
  let tokenIds: string[] = [];

  try {
    const prices: number[] = JSON.parse(gm.outcomePrices || '[]');
    outcomes = JSON.parse(gm.outcomes || '[]');
    tokenIds = JSON.parse(gm.clobTokenIds || '[]');
    yesPrice = prices[0] || 0;
    noPrice = prices[1] || 0;
  } catch {
    return null;
  }

  if (yesPrice === 0 && noPrice === 0) return null;
  if (outcomes.length < 2 || tokenIds.length < 2) return null;

  const dislocation = Math.abs(yesPrice - 0.5);

  const endDate = new Date(gm.endDate);
  const hoursToExpiry = Math.max(
    0,
    (endDate.getTime() - Date.now()) / (1000 * 60 * 60)
  );

  // Scoring formula (same as scripts/market-scanner.ts):
  let score = 0;

  // Volume score (log scale, 0-30 pts)
  score += Math.min(30, Math.log10(Math.max(1, volume24hr)) * 6);

  // Liquidity score (0-20 pts)
  score += Math.min(20, Math.log10(Math.max(1, liquidity)) * 4);

  // Spread score (tighter = better, 0-20 pts)
  const spreadPenalty = Math.min(20, spread * 200);
  score += 20 - spreadPenalty;

  // Dislocation score (moderate preferred, 0-15 pts)
  if (dislocation >= 0.05 && dislocation <= 0.35) {
    score += 15 * (1 - Math.abs(dislocation - 0.2) / 0.2);
  }

  // Time decay score (0-15 pts)
  if (hoursToExpiry > 24 && hoursToExpiry < 720) {
    score += 15;
  } else if (hoursToExpiry > 6 && hoursToExpiry <= 24) {
    score += 10;
  } else if (hoursToExpiry >= 720 && hoursToExpiry < 2160) {
    score += 8;
  }

  // Determine the favored outcome (higher probability side)
  const favoredIdx = yesPrice >= noPrice ? 0 : 1;

  return {
    conditionId: gm.conditionId,
    question: gm.question,
    tokenId: tokenIds[favoredIdx],
    outcome: outcomes[favoredIdx],
    price: favoredIdx === 0 ? yesPrice : noPrice,
    yesPrice,
    noPrice,
    volume24hr,
    liquidity,
    spread,
    dislocation,
    hoursToExpiry,
    score,
  };
}

/**
 * Scan markets and return scored opportunities filtered by bot config thresholds.
 */
export async function scanMarkets(
  config: BotConfig,
  limit = 100
): Promise<ScoredOpportunity[]> {
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit,
    order: 'volume24hr',
    ascending: false,
  });

  const scored: ScoredOpportunity[] = [];

  for (const gm of gammaMarkets) {
    const opp = scoreMarket(gm);
    if (!opp) continue;

    // Apply config filters
    if (opp.liquidity < config.minLiquidity) continue;
    if (opp.volume24hr < config.minVolume) continue;
    if (opp.spread > config.maxSpread) continue;
    if (opp.score < config.minScore) continue;

    // Skip markets expiring in < 6 hours (too risky)
    if (opp.hoursToExpiry < 6) continue;

    scored.push(opp);
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored;
}
