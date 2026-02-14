import type { Strategy, ScoredOpportunity, BotConfig, StrategySignal } from '../types';

/**
 * Complement Arb Strategy
 *
 * In binary markets, YES + NO must resolve to $1.00.
 * If bestAsk(YES) + bestAsk(NO) < $0.98 (after 2% winner fee),
 * buying both guarantees profit regardless of outcome.
 *
 * Profit = $0.98 - (yesAsk + noAsk).
 * E.g., YES@51c + NO@46c = 97c → 1c profit/share (~1%).
 *
 * This is a market-neutral strategy — no directional risk.
 */

const WINNER_FEE = 0.02;
const EFFECTIVE_PAYOUT = 1.0 - WINNER_FEE; // $0.98

export const complementArbStrategy: Strategy = {
  name: 'complement-arb',

  evaluate(
    opp: ScoredOpportunity,
    _config: BotConfig,
    balance: number,
    _openPositionCount: number,
  ): StrategySignal | null {
    // ── STAGE 1: Hard Filters ────────────────────────────

    // Must have CLOB order book data (set by scanner)
    if (opp.yesBestAsk == null || opp.noBestAsk == null) return null;
    if (opp.yesTokenId == null || opp.noTokenId == null) return null;

    const combinedCost = opp.yesBestAsk + opp.noBestAsk;

    // Combined cost must be under $0.975 (2.5c+ gross → 0.5c+ net after fee)
    if (combinedCost >= 0.975) return null;

    // Must have sufficient ask depth on both sides (≥$50)
    const depthYes = opp.askDepthYes ?? 0;
    const depthNo = opp.askDepthNo ?? 0;
    if (depthYes < 50 || depthNo < 50) return null;

    // Spread on each side should be reasonable (<5c)
    if (opp.yesBestAsk > 0.95 || opp.noBestAsk > 0.95) return null;

    // ── STAGE 2: Scoring ─────────────────────────────────

    let score = 0;

    // Profit margin score (0-40 pts)
    const grossProfit = EFFECTIVE_PAYOUT - combinedCost;
    // grossProfit ranges ~0.005 to ~0.05 typically
    const marginPts = Math.min(40, (grossProfit / 0.03) * 40);
    score += Math.max(0, marginPts);

    // Liquidity depth score (0-30 pts)
    const minDepth = Math.min(depthYes, depthNo);
    const depthPts = Math.min(30, (minDepth / 500) * 30);
    score += Math.max(0, depthPts);

    // Volume score (0-30 pts)
    const volumePts = Math.min(30, Math.log10(Math.max(1, opp.volume24hr)) * 6);
    score += Math.max(0, volumePts);

    // Minimum score threshold
    if (score < 40) return null;

    // ── STAGE 3: Position Sizing ─────────────────────────

    // Safe since market-neutral: 8% of balance × confidence
    const confidence = Math.min(1.0, score / 80);
    const targetCost = balance * 0.08 * confidence;

    // Size is how many shares to buy on each side
    const size = Math.floor((targetCost / combinedCost) * 100) / 100;
    if (size <= 0) return null;

    const netReturnPct = (grossProfit / combinedCost) * 100;

    return {
      action: 'BUY',
      tokenId: opp.yesTokenId,
      outcome: 'Yes',
      conditionId: opp.conditionId,
      question: opp.question,
      price: opp.yesBestAsk,
      size,
      reason: [
        `CompArb: YES@${(opp.yesBestAsk * 100).toFixed(1)}c + NO@${(opp.noBestAsk * 100).toFixed(1)}c = ${(combinedCost * 100).toFixed(1)}c`,
        `profit ${(grossProfit * 100).toFixed(1)}c/share (~${netReturnPct.toFixed(1)}%)`,
        `score ${score.toFixed(0)}/100`,
        `depth $${depthYes.toFixed(0)}/$${depthNo.toFixed(0)}`,
      ].join(', '),
      score,
      secondLeg: {
        tokenId: opp.noTokenId,
        outcome: 'No',
        price: opp.noBestAsk,
        size,
      },
    };
  },
};
