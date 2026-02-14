import type { Strategy, ScoredOpportunity, BotConfig, StrategySignal } from '../types';

/**
 * Micro-Scalper Strategy
 *
 * Ultra-short-term strategy targeting markets expiring in 5-60 minutes.
 * Three tiers with progressively looser filters as time-to-expiry increases:
 *
 *   Sprint (5-15 min):  95-97c, spread ≤1c,   liq ≥$3k, vol ≥$8k, pos 10%
 *   Dash   (15-30 min): 94-97c, spread ≤1.5c, liq ≥$2.5k, vol ≥$6k, pos 8%
 *   Quick  (30-60 min): 93-96c, spread ≤2c,   liq ≥$2k, vol ≥$5k, pos 6%
 *
 * Polymarket charges a 2% winner fee, so effective payout is $0.98/share.
 * Momentum guard: any 2c+ price drop in recent history → HARD REJECT.
 */

const WINNER_FEE = 0.02;
const EFFECTIVE_PAYOUT = 1.0 - WINNER_FEE; // $0.98

interface Tier {
  name: string;
  minMinutes: number;
  maxMinutes: number;
  minPrice: number;
  maxPrice: number;
  maxSpread: number;
  minLiquidity: number;
  minVolume: number;
  maxPositionPct: number;
}

const TIERS: Tier[] = [
  {
    name: 'Sprint',
    minMinutes: 5,
    maxMinutes: 15,
    minPrice: 0.95,
    maxPrice: 0.97,
    maxSpread: 0.01,
    minLiquidity: 3000,
    minVolume: 8000,
    maxPositionPct: 0.10,
  },
  {
    name: 'Dash',
    minMinutes: 15,
    maxMinutes: 30,
    minPrice: 0.94,
    maxPrice: 0.97,
    maxSpread: 0.015,
    minLiquidity: 2500,
    minVolume: 6000,
    maxPositionPct: 0.08,
  },
  {
    name: 'Quick',
    minMinutes: 30,
    maxMinutes: 60,
    minPrice: 0.93,
    maxPrice: 0.96,
    maxSpread: 0.02,
    minLiquidity: 2000,
    minVolume: 5000,
    maxPositionPct: 0.06,
  },
];

// In-memory price history for momentum guard (2-hour window)
const priceHistory = new Map<string, { price: number; timestamp: number }[]>();

function matchTier(minutesToExpiry: number, price: number): Tier | null {
  for (const tier of TIERS) {
    if (
      minutesToExpiry >= tier.minMinutes &&
      minutesToExpiry < tier.maxMinutes &&
      price >= tier.minPrice &&
      price <= tier.maxPrice
    ) {
      return tier;
    }
  }
  return null;
}

export const microScalperStrategy: Strategy = {
  name: 'micro-scalper',

  evaluate(
    opp: ScoredOpportunity,
    _config: BotConfig,
    balance: number,
    _openPositionCount: number
  ): StrategySignal | null {
    const minutesToExpiry = opp.hoursToExpiry * 60;

    // ── STAGE 1: Tier Matching ────────────────────────────
    const tier = matchTier(minutesToExpiry, opp.price);
    if (!tier) return null;

    // ── STAGE 2: Hard Filters ─────────────────────────────

    // Spread check (tier-specific)
    if (opp.spread > tier.maxSpread) return null;

    // Liquidity check (tier-specific)
    if (opp.liquidity < tier.minLiquidity) return null;

    // Volume check (tier-specific)
    if (opp.volume24hr < tier.minVolume) return null;

    // Sum check: yes + no should be approximately $1.00 (±2c)
    const priceSum = opp.yesPrice + opp.noPrice;
    if (Math.abs(priceSum - 1.0) > 0.02) return null;

    // Opposing outcome must be <10c — confirms consensus
    const opposingPrice = opp.outcome === 'Yes' ? opp.noPrice : opp.yesPrice;
    if (opposingPrice >= 0.10) return null;

    // Net profit must be ≥1c/share after 2% fee
    const netProfitPerShare = EFFECTIVE_PAYOUT - opp.price;
    if (netProfitPerShare < 0.01) return null;

    // ── STAGE 3: Momentum Guard ───────────────────────────

    const now = Date.now();
    const history = priceHistory.get(opp.conditionId) || [];

    // Store current price
    history.push({ price: opp.price, timestamp: now });

    // Keep only last 2 hours of data
    const cutoff = now - 2 * 60 * 60 * 1000;
    const recentHistory = history.filter((h) => h.timestamp >= cutoff);
    priceHistory.set(opp.conditionId, recentHistory);

    let momentumStable = true;
    let priceRising = false;

    if (recentHistory.length >= 2) {
      const oldestPrice = recentHistory[0].price;
      const priceDelta = opp.price - oldestPrice;

      // Check for any 2c+ drop → HARD REJECT (market instability)
      for (let i = 1; i < recentHistory.length; i++) {
        if (recentHistory[i - 1].price - recentHistory[i].price >= 0.02) {
          return null;
        }
      }

      if (priceDelta > 0) priceRising = true;
      if (priceDelta < -0.005) momentumStable = false;
    }

    // ── STAGE 4: Confidence Scoring (0-100) ───────────────

    let confidence = 0;

    // Time proximity (0-30 pts): closer to expiry = higher
    if (minutesToExpiry <= 10) confidence += 30;
    else if (minutesToExpiry <= 20) confidence += 25;
    else if (minutesToExpiry <= 40) confidence += 20;
    else confidence += 15;

    // Price level (0-21 pts): higher price = more certain
    const pricePoints = (opp.price - 0.90) * 300;
    confidence += Math.min(21, Math.max(0, pricePoints));

    // Spread tightness (0-20 pts)
    if (opp.spread <= 0.005) confidence += 20;
    else if (opp.spread <= 0.01) confidence += 15;
    else if (opp.spread <= 0.015) confidence += 10;
    else confidence += 5;

    // Volume conviction (0-15 pts)
    const volRatio = opp.volume24hr / Math.max(1, opp.liquidity);
    if (volRatio >= 0.5) confidence += 15;
    else if (volRatio >= 0.3) confidence += 10;
    else confidence += 5;

    // Momentum stability (0-10 pts)
    if (priceRising) confidence += 10;
    else if (momentumStable) confidence += 5;

    // ── STAGE 5: Confidence Gate ──────────────────────────

    if (confidence < 60) return null;

    // ── STAGE 6: Position Sizing ──────────────────────────

    const scaledPct = tier.maxPositionPct * (confidence / 85);
    const targetCost = balance * Math.min(scaledPct, tier.maxPositionPct);

    // Buy at market price — need fills in tight windows
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
        `MicroScalp[${tier.name}]: ${opp.outcome} @ ${(opp.price * 100).toFixed(0)}c`,
        `expiry ${minutesToExpiry.toFixed(0)}min`,
        `conf ${confidence.toFixed(0)}/100`,
        `return ~${expectedReturn.toFixed(1)}%`,
      ].join(', '),
      score: confidence,
    };
  },
};
