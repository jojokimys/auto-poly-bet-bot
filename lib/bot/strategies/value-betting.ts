import type { Strategy, ScoredOpportunity, BotConfig, StrategySignal } from '../types';

/**
 * Value Betting Strategy
 *
 * Buys outcomes that appear undervalued based on the scanner's multi-factor
 * scoring. Targets markets with:
 * - High liquidity and volume (tradeable, validated by crowd)
 * - Moderate dislocation (0.1-0.3 from 50/50) — leaning but not decided
 * - Tight spreads (efficient pricing, easy fills)
 * - Reasonable time to expiry (24h-30d sweet spot)
 *
 * Places limit orders slightly below market price for better fills.
 */
export const valueBettingStrategy: Strategy = {
  name: 'value-betting',

  evaluate(
    opp: ScoredOpportunity,
    config: BotConfig,
    balance: number,
    openPositionCount: number
  ): StrategySignal | null {
    // Only trade outcomes with meaningful lean (skip 50/50 markets)
    if (opp.dislocation < 0.05) return null;

    // Skip very high-probability outcomes (>85¢ — low upside)
    if (opp.price > 0.85) return null;

    // Skip very low-probability outcomes (<15¢ — too speculative)
    if (opp.price < 0.15) return null;

    // Calculate position size based on confidence (score)
    // Higher score → larger fraction of maxBetAmount
    const confidence = Math.min(1, opp.score / 80);
    const targetCost = config.maxBetAmount * confidence;

    // Place limit order slightly below market (1-2% better price for fills)
    const limitDiscount = 0.01 + (opp.spread / 2);
    const limitPrice = Math.max(0.01, opp.price - limitDiscount);
    const size = targetCost / limitPrice;

    // Expected value estimate:
    // If the favored outcome wins, payout is $1/share, cost is limitPrice
    // Edge = (probability of win * $1 - limitPrice) / limitPrice
    // Use price as a rough probability proxy
    const impliedEdge = (opp.price - limitPrice) / limitPrice;

    return {
      action: 'BUY',
      tokenId: opp.tokenId,
      outcome: opp.outcome,
      conditionId: opp.conditionId,
      question: opp.question,
      price: Math.round(limitPrice * 100) / 100, // Round to cents
      size: Math.round(size * 100) / 100,
      reason: `Score ${opp.score.toFixed(1)}, ${opp.outcome} @ ${(opp.price * 100).toFixed(0)}¢, edge ~${(impliedEdge * 100).toFixed(1)}%`,
      score: opp.score,
    };
  },
};
