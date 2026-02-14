import type { Strategy, ScoredOpportunity, BotConfig, StrategySignal } from '../types';

/**
 * Panic Reversal Sniper Strategy
 *
 * When a high-probability market (>50c) suddenly drops 5c+ but
 * fundamentals haven't changed, buy the dip expecting recovery.
 *
 * Uses in-memory price history to detect sudden drops from recent highs.
 * Confirms the drop is isolated (opposing side rose correspondingly)
 * and checks for recovery momentum before entering.
 */

// In-memory price history for drop detection
const priceHistory = new Map<string, { price: number; timestamp: number }[]>();

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const MIN_DROP = 0.05; // 5c minimum drop from 2h high

export const panicReversalStrategy: Strategy = {
  name: 'panic-reversal',

  evaluate(
    opp: ScoredOpportunity,
    _config: BotConfig,
    balance: number,
    _openPositionCount: number,
  ): StrategySignal | null {
    const now = Date.now();

    // ── Price History Tracking ───────────────────────────

    const history = priceHistory.get(opp.conditionId) || [];
    history.push({ price: opp.price, timestamp: now });

    // Keep only last 2 hours
    const cutoff = now - TWO_HOURS_MS;
    const recentHistory = history.filter((h) => h.timestamp >= cutoff);
    priceHistory.set(opp.conditionId, recentHistory);

    // ── STAGE 1: Hard Filters ────────────────────────────

    // Price must be in 50-90c range (was high-probability, now dipped)
    if (opp.price < 0.50 || opp.price > 0.90) return null;

    // Minimum volume and liquidity
    if (opp.volume24hr < 10000) return null;
    if (opp.liquidity < 5000) return null;

    // Need at least 3 price observations to detect a drop
    if (recentHistory.length < 3) return null;

    // ── STAGE 2: Drop Detection ──────────────────────────

    // Find the 2-hour high
    const twoHourHigh = Math.max(...recentHistory.map((h) => h.price));
    const dropFromHigh = twoHourHigh - opp.price;

    // Must have dropped at least 5c from 2h high
    if (dropFromHigh < MIN_DROP) return null;

    // ── STAGE 3: Isolation Check ─────────────────────────

    // Opposing side should have risen correspondingly (not a broken market)
    const opposingPrice = opp.outcome === 'Yes' ? opp.noPrice : opp.yesPrice;
    const priceSum = opp.price + opposingPrice;
    // If sum deviates too much from $1, market may be broken
    if (Math.abs(priceSum - 1.0) > 0.05) return null;

    // ── STAGE 4: Recovery Signal ─────────────────────────

    // Check if price stopped falling (latest ≥ previous observation)
    const prevPrice = recentHistory[recentHistory.length - 2].price;
    const recovering = opp.price >= prevPrice;

    // Must show at least stabilization
    if (!recovering) return null;

    // ── STAGE 5: Scoring ─────────────────────────────────

    let score = 0;

    // Drop magnitude (0-30 pts): bigger drop = more opportunity
    const dropPts = Math.min(30, (dropFromHigh / 0.15) * 30);
    score += Math.max(0, dropPts);

    // Volume conviction (0-25 pts)
    const volPts = Math.min(25, Math.log10(Math.max(1, opp.volume24hr)) * 5);
    score += Math.max(0, volPts);

    // Recovery momentum (0-25 pts)
    const recoveryAmount = opp.price - Math.min(...recentHistory.slice(-5).map((h) => h.price));
    const recoveryPts = Math.min(25, (recoveryAmount / 0.03) * 25);
    score += Math.max(0, recoveryPts);

    // Spread tightness (0-20 pts)
    let spreadPts = 0;
    if (opp.spread <= 0.01) spreadPts = 20;
    else if (opp.spread <= 0.02) spreadPts = 15;
    else if (opp.spread <= 0.03) spreadPts = 10;
    else if (opp.spread <= 0.05) spreadPts = 5;
    score += spreadPts;

    // Minimum confidence threshold
    if (score < 55) return null;

    // ── STAGE 6: Position Sizing ─────────────────────────

    // Conservative 3-5% of balance (higher risk strategy)
    const confidence = Math.min(1.0, score / 80);
    const pctOfBalance = 0.03 + 0.02 * confidence; // 3-5%
    const targetCost = balance * pctOfBalance;

    const limitPrice = opp.price;
    const size = Math.floor((targetCost / limitPrice) * 100) / 100;
    if (size <= 0) return null;

    return {
      action: 'BUY',
      tokenId: opp.tokenId,
      outcome: opp.outcome,
      conditionId: opp.conditionId,
      question: opp.question,
      price: limitPrice,
      size,
      reason: [
        `PanicReversal: ${opp.outcome} @ ${(opp.price * 100).toFixed(0)}c`,
        `drop ${(dropFromHigh * 100).toFixed(0)}c from 2h high ${(twoHourHigh * 100).toFixed(0)}c`,
        `recovering +${(recoveryAmount * 100).toFixed(1)}c`,
        `score ${score.toFixed(0)}/100`,
      ].join(', '),
      score,
    };
  },
};
