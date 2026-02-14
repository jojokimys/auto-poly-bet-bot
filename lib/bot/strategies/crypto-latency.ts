import type { Strategy, ScoredOpportunity, BotConfig, StrategySignal } from '../types';

/**
 * Crypto Latency Arb Strategy
 *
 * Polymarket has 15-minute crypto markets ("Will BTC go up?").
 * If Binance shows BTC already up significantly but Polymarket YES
 * is still cheap, buy YES (and vice versa for NO).
 *
 * Requires the scanner to populate spotPrice and openingPrice fields.
 * Targets markets with 2-13 minutes remaining.
 */

export const cryptoLatencyStrategy: Strategy = {
  name: 'crypto-latency',

  evaluate(
    opp: ScoredOpportunity,
    _config: BotConfig,
    balance: number,
    _openPositionCount: number,
  ): StrategySignal | null {
    // ── STAGE 1: Hard Filters ────────────────────────────

    // Must have Binance price data (set by scanner)
    if (opp.spotPrice == null || opp.openingPrice == null) return null;
    if (opp.openingPrice <= 0) return null;

    // Must be short-duration market (2-13 minutes remaining)
    const minutesToExpiry = opp.hoursToExpiry * 60;
    if (minutesToExpiry < 2 || minutesToExpiry > 13) return null;

    // ── STAGE 2: Directional Signal ──────────────────────

    const pctMove = (opp.spotPrice - opp.openingPrice) / opp.openingPrice;
    const absPctMove = Math.abs(pctMove);

    // Need at least 0.1% move to have a directional signal
    if (absPctMove < 0.001) return null;

    let targetTokenId: string;
    let targetOutcome: string;
    let targetPrice: number;

    if (pctMove > 0) {
      // BTC is up → buy YES (price should go up / resolve YES)
      targetPrice = opp.yesPrice;
      targetOutcome = 'Yes';
      // Use the YES token — extract from opp
      // Scanner puts the favored token in tokenId; we need YES specifically
      // yesPrice corresponds to outcomes[0] / tokenIds[0]
      targetTokenId = opp.yesTokenId ?? opp.tokenId;
    } else {
      // BTC is down → buy NO
      targetPrice = opp.noPrice;
      targetOutcome = 'No';
      targetTokenId = opp.noTokenId ?? opp.tokenId;
    }

    // Target token must be cheap enough to have upside (< 70c)
    if (targetPrice > 0.70) return null;
    // Must be at least 5c (avoid dust)
    if (targetPrice < 0.05) return null;

    // ── STAGE 3: Scoring ─────────────────────────────────

    let score = 0;

    // Price move magnitude (0-35 pts): bigger BTC move = stronger signal
    // 0.1% = 10pts, 0.3% = 25pts, 0.5%+ = 35pts
    const movePts = Math.min(35, (absPctMove / 0.005) * 35);
    score += Math.max(0, movePts);

    // Time remaining (0-25 pts): more time = more room for Polymarket to catch up
    // But not too much (>10min means market may already be efficient)
    let timePts = 0;
    if (minutesToExpiry >= 5 && minutesToExpiry <= 10) timePts = 25;
    else if (minutesToExpiry >= 3 && minutesToExpiry < 5) timePts = 20;
    else if (minutesToExpiry > 10) timePts = 15;
    else timePts = 10; // 2-3 min: tight but possible
    score += timePts;

    // Token discount (0-25 pts): cheaper target token = more upside
    // 30c → 25pts, 50c → 15pts, 65c → 5pts
    const discountPts = Math.min(25, ((0.70 - targetPrice) / 0.40) * 25);
    score += Math.max(0, discountPts);

    // Volume (0-15 pts)
    const volPts = Math.min(15, Math.log10(Math.max(1, opp.volume24hr)) * 3);
    score += Math.max(0, volPts);

    // Minimum confidence
    if (score < 50) return null;

    // ── STAGE 4: Position Sizing ─────────────────────────

    // 5-8% of balance, scales with signal strength
    const confidence = Math.min(1.0, score / 80);
    const pctOfBalance = 0.05 + 0.03 * confidence; // 5-8%
    const targetCost = balance * pctOfBalance;

    const limitPrice = targetPrice;
    const size = Math.floor((targetCost / limitPrice) * 100) / 100;
    if (size <= 0) return null;

    const direction = pctMove > 0 ? 'UP' : 'DOWN';

    return {
      action: 'BUY',
      tokenId: targetTokenId,
      outcome: targetOutcome,
      conditionId: opp.conditionId,
      question: opp.question,
      price: limitPrice,
      size,
      reason: [
        `CryptoLatency: BTC ${direction} ${(absPctMove * 100).toFixed(2)}%`,
        `buying ${targetOutcome} @ ${(targetPrice * 100).toFixed(0)}c`,
        `${minutesToExpiry.toFixed(0)}min left`,
        `score ${score.toFixed(0)}/100`,
      ].join(', '),
      score,
    };
  },
};
