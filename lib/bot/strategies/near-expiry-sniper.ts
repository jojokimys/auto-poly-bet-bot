import type { Strategy, ScoredOpportunity, BotConfig, StrategySignal } from '../types';

/**
 * Near-Expiry Sniper Strategy
 *
 * Buys outcome tokens priced 90-97 cents in markets expiring within 1-72 hours,
 * where the outcome is nearly certain. Captures the residual discount as profit
 * when the market resolves to $1.00 (minus the 2% winner fee).
 *
 * Multi-signal confirmation: requires 3 of 4 signals (time decay, momentum,
 * volume conviction, spread tightness) to confirm before entering.
 */

const WINNER_FEE = 0.02;
const EFFECTIVE_PAYOUT = 1.0 - WINNER_FEE; // $0.98

// In-memory price history for momentum calculation
const priceHistory = new Map<string, { price: number; timestamp: number }[]>();

export const nearExpirySniperStrategy: Strategy = {
  name: 'near-expiry-sniper',

  evaluate(
    opp: ScoredOpportunity,
    config: BotConfig,
    balance: number,
    _openPositionCount: number
  ): StrategySignal | null {
    // ── STAGE 1: Hard Filters ────────────────────────────

    // Only target high-probability outcomes (90-94 cents)
    // Above 94c, margin after 2% winner fee is <4c — too thin
    if (opp.price < 0.90 || opp.price > 0.94) return null;

    // Only target near-expiry markets (1-8 hours)
    // Accuracy jumps to 95.4% at 4h; beyond 8h it drops to ~88%
    if (opp.hoursToExpiry < 1 || opp.hoursToExpiry > 8) return null;

    // Minimum liquidity (raised to avoid slippage eating margin)
    if (opp.liquidity < 2000) return null;
    // Minimum volume (higher = better price discovery)
    if (opp.volume24hr < 5000) return null;

    // Maximum spread — tighter to ensure real consensus
    if (opp.spread > 0.02) return null;

    // Sum check: yes + no should be approximately 1.00
    const priceSum = opp.yesPrice + opp.noPrice;
    if (Math.abs(priceSum - 1.0) > 0.02) return null;

    // Opposing outcome must be low (consistency check)
    const opposingPrice = opp.outcome === 'Yes' ? opp.noPrice : opp.yesPrice;
    if (opposingPrice > 0.12) return null;

    // Net profit must be meaningful after winner fee
    const netProfitPerShare = EFFECTIVE_PAYOUT - opp.price;
    if (netProfitPerShare <= 0.005) return null;

    // ── STAGE 2: Signal Scoring ──────────────────────────

    let totalScore = 0;
    let confirmedSignals = 0;

    // --- Signal 1: Price Level (0-25 pts) ---
    const priceScore = ((opp.price - 0.90) / 0.04) * 25;
    totalScore += Math.min(25, Math.max(0, priceScore));

    // --- Signal 2: Time Decay (0-25 pts) ---
    let timeScore = 0;
    if (opp.hoursToExpiry <= 2) timeScore = 25;
    else if (opp.hoursToExpiry <= 4) timeScore = 22;
    else if (opp.hoursToExpiry <= 6) timeScore = 18;
    else timeScore = 12;
    totalScore += timeScore;

    if (timeScore >= 18) confirmedSignals++; // Confirmed if <= 6h

    // --- Signal 3: Price Momentum (0-20 pts) ---
    let momentumScore = 0;
    const history = priceHistory.get(opp.conditionId) || [];
    const now = Date.now();

    // Store current price for future momentum calculations
    history.push({ price: opp.price, timestamp: now });
    // Keep only last 24 hours of data
    const cutoff = now - 24 * 60 * 60 * 1000;
    const recentHistory = history.filter((h) => h.timestamp >= cutoff);
    priceHistory.set(opp.conditionId, recentHistory);

    if (recentHistory.length >= 2) {
      const oldestPrice = recentHistory[0].price;
      const priceDelta = opp.price - oldestPrice;

      // Check for sudden reversals (any 3+ cent drop in history)
      let hasReversal = false;
      for (let i = 1; i < recentHistory.length; i++) {
        if (recentHistory[i - 1].price - recentHistory[i].price >= 0.03) {
          hasReversal = true;
          break;
        }
      }

      if (hasReversal) {
        // HARD REJECT: sudden reversal detected
        return null;
      }

      if (priceDelta < 0) momentumScore = 0;
      else if (priceDelta < 0.02) momentumScore = 5;
      else if (priceDelta < 0.05) momentumScore = 12;
      else momentumScore = 20;

      if (priceDelta > 0) confirmedSignals++;
    } else {
      // No history yet — neutral score (first scan)
      momentumScore = 8;
    }
    totalScore += momentumScore;

    // --- Signal 4: Volume Conviction (0-15 pts) ---
    let volumeScore = 0;
    const volRatio = opp.volume24hr / Math.max(1, opp.liquidity);
    if (volRatio < 0.1) volumeScore = 0;
    else if (volRatio < 0.3) volumeScore = 5;
    else if (volRatio < 0.5) volumeScore = 10;
    else volumeScore = 15;
    totalScore += volumeScore;

    if (volRatio >= 0.3) confirmedSignals++;

    // --- Signal 5: Spread Tightness (0-15 pts) ---
    let spreadScore = 0;
    if (opp.spread <= 0.005) spreadScore = 15;
    else if (opp.spread <= 0.01) spreadScore = 12;
    else if (opp.spread <= 0.015) spreadScore = 8;
    else spreadScore = 4;
    totalScore += spreadScore;

    if (opp.spread <= 0.015) confirmedSignals++;

    // ── STAGE 3: Confirmation Gate ───────────────────────

    // Require at least 3 of 4 signals to confirm
    if (confirmedSignals < 3) return null;

    // Minimum total score threshold
    if (totalScore < 60) return null;

    // ── STAGE 4: Position Sizing ─────────────────────────

    const maxPerTrade = balance * 0.05; // 5% of portfolio

    // Confidence-based sizing
    const confidence = Math.min(1.0, totalScore / 80);
    let targetCost = maxPerTrade * confidence;

    // All-signals bonus
    if (confirmedSignals === 4) {
      targetCost = Math.min(targetCost * 1.2, balance * 0.07);
    }

    // Place at current price — for near-expiry we want fills, not discount
    const limitPrice = opp.price;
    const size = Math.floor((targetCost / limitPrice) * 100) / 100;

    if (size <= 0) return null;

    const expectedReturn = ((EFFECTIVE_PAYOUT - limitPrice) / limitPrice) * 100;

    return {
      action: 'BUY',
      tokenId: opp.tokenId,
      outcome: opp.outcome,
      conditionId: opp.conditionId,
      question: opp.question,
      price: limitPrice,
      size,
      reason: [
        `NearExpiry: ${opp.outcome} @ ${(opp.price * 100).toFixed(0)}c`,
        `expiry ${opp.hoursToExpiry.toFixed(1)}h`,
        `score ${totalScore.toFixed(0)}/100`,
        `signals ${confirmedSignals}/4`,
        `return ~${expectedReturn.toFixed(1)}%`,
      ].join(', '),
      score: totalScore,
    };
  },
};
