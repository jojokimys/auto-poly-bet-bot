import type { Strategy, ScoredOpportunity, BotConfig, StrategySignal } from '../types';

/**
 * Multi-Outcome Bundle Arb Strategy
 *
 * For events with 3+ outcomes (elections, sports brackets, etc.),
 * exactly one YES resolves to $1.00 (winner-take-all).
 * If the sum of all YES best asks < $0.98 (after 2% winner fee),
 * buying one share of each outcome guarantees profit.
 *
 * Profit = $0.98 - sum(YES asks).
 * E.g., 5 outcomes at 45c+25c+12c+8c+5c = 95c → 3c profit (3.2%).
 *
 * This is a market-neutral strategy — no directional risk.
 * Structurally higher edge than binary complement arb (3-6c vs 1-2c)
 * because humans are bad at maintaining probability distributions.
 */

const WINNER_FEE = 0.02;
const EFFECTIVE_PAYOUT = 1.0 - WINNER_FEE; // $0.98

export const multiOutcomeArbStrategy: Strategy = {
  name: 'multi-outcome-arb',

  evaluate(
    opp: ScoredOpportunity,
    _config: BotConfig,
    balance: number,
    _openPositionCount: number,
  ): StrategySignal | null {
    // ── STAGE 1: Hard Filters ────────────────────────────

    // Must have bundle data from scanner
    if (!opp.bundleLegs || opp.bundleLegs.length < 3) return null;
    if (opp.bundleCost == null) return null;

    // Bundle cost must be under $0.975 (net 0.5c+ after 2% winner fee)
    if (opp.bundleCost >= 0.975) return null;

    // All legs must have ask depth ≥ $25
    if (opp.bundleLegs.some((leg) => leg.askDepth < 25)) return null;

    const grossProfit = EFFECTIVE_PAYOUT - opp.bundleCost;
    if (grossProfit <= 0) return null;

    // ── STAGE 2: Scoring (0-100) ─────────────────────────

    let score = 0;

    // Profit margin (0-40 pts): higher edge = more points
    // grossProfit ranges ~0.005 to ~0.05 typically
    const marginPts = Math.min(40, (grossProfit / 0.03) * 40);
    score += Math.max(0, marginPts);

    // Minimum depth across all legs (0-30 pts)
    const minDepth = Math.min(...opp.bundleLegs.map((l) => l.askDepth));
    const depthPts = Math.min(30, (minDepth / 300) * 30);
    score += Math.max(0, depthPts);

    // Event volume (0-30 pts)
    const volPts = Math.min(30, Math.log10(Math.max(1, opp.volume24hr)) * 5);
    score += Math.max(0, volPts);

    // Minimum score threshold
    if (score < 30) return null;

    // ── STAGE 3: Position Sizing ─────────────────────────

    // Market-neutral: 8% of balance × confidence (same as complement arb)
    const confidence = Math.min(1.0, score / 80);
    const targetCost = balance * 0.08 * confidence;

    // Size = how many shares of each outcome to buy
    const size = Math.floor((targetCost / opp.bundleCost) * 100) / 100;
    if (size <= 0) return null;

    // ── STAGE 4: Build Signal ────────────────────────────

    // Primary leg: the most expensive outcome (most important to fill)
    const sortedLegs = [...opp.bundleLegs].sort((a, b) => b.bestAsk - a.bestAsk);
    const primaryLeg = sortedLegs[0];
    const remainingLegs = sortedLegs.slice(1);

    const netReturnPct = (grossProfit / opp.bundleCost) * 100;

    return {
      action: 'BUY',
      tokenId: primaryLeg.tokenId,
      outcome: primaryLeg.outcome,
      conditionId: opp.conditionId,
      question: opp.bundleEventTitle ?? opp.question,
      price: primaryLeg.bestAsk,
      size,
      reason: [
        `BundleArb: ${opp.bundleLegs.length} outcomes`,
        `cost ${(opp.bundleCost * 100).toFixed(1)}c`,
        `profit ${(grossProfit * 100).toFixed(1)}c/share (~${netReturnPct.toFixed(1)}%)`,
        `score ${score.toFixed(0)}/100`,
        `minDepth $${minDepth.toFixed(0)}`,
      ].join(', '),
      score,
      bundleLegs: remainingLegs.map((leg) => ({
        tokenId: leg.tokenId,
        outcome: leg.outcome,
        price: leg.bestAsk,
        size,
      })),
    };
  },
};
