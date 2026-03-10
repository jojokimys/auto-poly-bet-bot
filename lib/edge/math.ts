/**
 * Edge Detection Mathematics
 *
 * Core formulas for determining if a trade has enough edge to be profitable.
 * Used by both Latency Arb and Expiry Sniper strategies.
 *
 * Key concepts:
 * - Edge = expected profit per dollar risked, net of fees
 * - Kelly fraction = optimal bet sizing for binary outcomes
 * - Fee drag = Polymarket taker fee curve kills edge near 50c
 */

import { takerFeePerShare } from '../fees';

// ─── Constants ─────────────────────────────────────────

/** Minimum edge (in cents) to enter a trade */
export const MIN_EDGE_CENTS = 3.0;

/** Maximum Kelly fraction (safety cap) */
export const KELLY_FRACTION = 0.25;

/** Maximum position size as % of balance */
export const MAX_POSITION_PCT = 0.15;

/** Minimum token price to trade (avoid illiquid extremes) */
export const MIN_TOKEN_PRICE = 0.03;

/** Maximum token price to trade (fee drag too high near 50c) */
export const MAX_TOKEN_PRICE = 0.97;

// ─── Edge Calculation ──────────────────────────────────

export interface EdgeResult {
  /** Raw edge before fees (cents) */
  rawEdgeCents: number;
  /** Net edge after fees (cents) */
  netEdgeCents: number;
  /** Taker fee (cents per share) */
  feeCents: number;
  /** Is this trade profitable? */
  isProfitable: boolean;
  /** Fair value probability (0-1) */
  fairValue: number;
  /** Current token price (0-1) */
  tokenPrice: number;
  /** Edge ratio: netEdge / tokenPrice (higher = better) */
  edgeRatio: number;
}

/**
 * Calculate edge for a binary option trade.
 *
 * Edge = |fairValue - tokenPrice| - takerFee
 *
 * For a YES token at price p with fair value fv:
 *   - If fv > p: BUY YES (underpriced)
 *   - If fv < p: SELL YES / BUY NO
 *
 * @param fairValue - estimated probability (0-1) that outcome settles YES
 * @param tokenPrice - current CLOB token price (0-1)
 * @param isMaker - true if using post-only order (zero fee)
 */
export function calculateEdge(
  fairValue: number,
  tokenPrice: number,
  isMaker: boolean = false,
): EdgeResult {
  const rawEdgeCents = Math.abs(fairValue - tokenPrice) * 100;
  const feeCents = isMaker ? 0 : takerFeePerShare(tokenPrice) * 100;
  const netEdgeCents = rawEdgeCents - feeCents;

  return {
    rawEdgeCents,
    netEdgeCents,
    feeCents,
    isProfitable: netEdgeCents >= MIN_EDGE_CENTS,
    fairValue,
    tokenPrice,
    edgeRatio: tokenPrice > 0 ? netEdgeCents / (tokenPrice * 100) : 0,
  };
}

// ─── Latency Arb Edge ──────────────────────────────────

/**
 * Latency Arb: Binance price moves before Polymarket CLOB reprices.
 *
 * For a crypto binary option "Will BTC be above $X at time T?":
 *   - If Binance shows BTC sharply above strike → YES token should be near 1.0
 *   - If CLOB still shows YES at 0.85 → edge = (fairValue - 0.85) - fee
 *
 * Fair value for latency arb (near-term):
 *   P(spot > strike) ≈ Φ((spot - strike) / (σ × √T))
 *
 * But for very short timeframes (< 1min), we simplify:
 *   fairValue ≈ clamp(0.5 + (spot - strike) / (2 × σ_tick × strike), 0.02, 0.98)
 *
 * Where σ_tick = recent micro-volatility from Binance trade stream.
 */
export interface LatencyArbSignal {
  edge: EdgeResult;
  /** Direction: BUY YES or BUY NO */
  direction: 'BUY_YES' | 'BUY_NO';
  /** Binance spot price */
  spotPrice: number;
  /** Strike price of the binary option */
  strike: number;
  /** Distance from strike as % of strike */
  strikeDistancePct: number;
  /** Micro-momentum from Binance (% over ~5 trades) */
  microMomentum: number;
  /** Confidence score 0-100 */
  confidence: number;
}

/**
 * Evaluate latency arb opportunity.
 *
 * @param spotPrice - current Binance price
 * @param strike - binary option strike price
 * @param yesTokenPrice - current YES token price on CLOB
 * @param microVolatility - recent price volatility (σ as decimal, e.g. 0.001 = 0.1%)
 * @param microMomentum - price momentum from last ~5 trades (% change)
 * @param hoursToExpiry - time until settlement
 * @param isMaker - using post-only order?
 */
export function evaluateLatencyArb(
  spotPrice: number,
  strike: number,
  yesTokenPrice: number,
  microVolatility: number,
  microMomentum: number,
  hoursToExpiry: number,
  isMaker: boolean = false,
): LatencyArbSignal | null {
  if (spotPrice <= 0 || strike <= 0) return null;

  const strikeDistancePct = (spotPrice - strike) / strike;

  // Fair value estimation using simplified probit
  // σ_effective = microVolatility × strike (dollar vol per tick window)
  const sigmaEffective = Math.max(microVolatility, 0.0001) * strike;
  const zScore = (spotPrice - strike) / sigmaEffective;

  // Approximate Φ(z) using logistic function: 1 / (1 + e^(-1.7 × z))
  // Good approximation of normal CDF, faster than erf
  const fairValue = clamp(1 / (1 + Math.exp(-1.7 * zScore)), 0.02, 0.98);

  // Determine direction
  const direction: 'BUY_YES' | 'BUY_NO' = fairValue > yesTokenPrice ? 'BUY_YES' : 'BUY_NO';

  // Calculate edge based on direction
  const tokenPrice = direction === 'BUY_YES' ? yesTokenPrice : (1 - yesTokenPrice);
  const adjustedFairValue = direction === 'BUY_YES' ? fairValue : (1 - fairValue);
  const edge = calculateEdge(adjustedFairValue, tokenPrice, isMaker);

  // Confidence scoring (0-100)
  let confidence = 0;

  // 1. Edge magnitude (0-30 pts)
  confidence += Math.min(edge.netEdgeCents / 0.5, 30);

  // 2. Strike distance — further from strike = more certain (0-25 pts)
  confidence += Math.min(Math.abs(strikeDistancePct) * 5000, 25);

  // 3. Momentum alignment — momentum agrees with our direction (0-20 pts)
  const momentumAligned =
    (direction === 'BUY_YES' && microMomentum > 0) ||
    (direction === 'BUY_NO' && microMomentum < 0);
  if (momentumAligned) {
    confidence += Math.min(Math.abs(microMomentum) * 20000, 20);
  }

  // 4. Time to expiry — closer = more predictable (0-15 pts)
  if (hoursToExpiry <= 0.5) confidence += 15;
  else if (hoursToExpiry <= 1) confidence += 10;
  else if (hoursToExpiry <= 4) confidence += 5;

  // 5. Token price in sweet spot — far from 50c = low fee (0-10 pts)
  const feeZone = Math.abs(tokenPrice - 0.5);
  confidence += Math.min(feeZone * 20, 10);

  confidence = Math.min(Math.round(confidence), 100);

  if (!edge.isProfitable) return null;

  return {
    edge,
    direction,
    spotPrice,
    strike,
    strikeDistancePct,
    microMomentum,
    confidence,
  };
}

// ─── Expiry Sniper Edge ────────────────────────────────

/**
 * Expiry Sniper: Trade binary options in the final seconds before settlement.
 *
 * As T → 0, the binary option's fair value converges to 0 or 1.
 * Any mispricing in the last 20-60 seconds is pure edge.
 *
 * Fair value near expiry:
 *   If spot > strike by margin → fairValue ≈ 1.0
 *   If spot < strike by margin → fairValue ≈ 0.0
 *   If spot ≈ strike → fairValue ≈ 0.5 (too risky, skip)
 *
 * Margin threshold = max(σ_recent × √(T_remaining / T_1min), minBuffer)
 *   Where σ_recent = realized vol over last 60s from Binance
 *   T_remaining = seconds to expiry
 *   T_1min = 60 seconds (normalization)
 *
 * The key insight: at 20s to expiry, price can move at most ~0.05%
 * for BTC. So if spot is 0.2% above strike, it's nearly certain YES.
 */
export interface ExpirySignal {
  edge: EdgeResult;
  direction: 'BUY_YES' | 'BUY_NO';
  spotPrice: number;
  strike: number;
  secondsToExpiry: number;
  /** How many σ away spot is from strike */
  zScore: number;
  /** Estimated win probability */
  winProbability: number;
  /** Chainlink agrees with direction? */
  chainlinkConfirms: boolean;
  confidence: number;
}

/**
 * Evaluate expiry sniper opportunity.
 *
 * @param spotPrice - current Binance spot price
 * @param chainlinkPrice - Chainlink oracle price (settlement reference)
 * @param strike - binary option strike
 * @param yesTokenPrice - current YES token price on CLOB
 * @param secondsToExpiry - seconds until settlement
 * @param recentVolatility - realized vol over last 60s (decimal, e.g. 0.001)
 * @param isMaker - using post-only?
 */
export function evaluateExpirySniper(
  spotPrice: number,
  chainlinkPrice: number | null,
  strike: number,
  yesTokenPrice: number,
  secondsToExpiry: number,
  recentVolatility: number,
  isMaker: boolean = false,
): ExpirySignal | null {
  if (spotPrice <= 0 || strike <= 0) return null;
  if (secondsToExpiry < 5 || secondsToExpiry > 120) return null; // too close or too far

  // σ_remaining = σ_60s × √(T_remaining / 60)
  // This estimates how much price could move before expiry
  const sigmaRemaining = Math.max(recentVolatility, 0.0001) * Math.sqrt(secondsToExpiry / 60);
  const priceBufferPct = sigmaRemaining;

  // z-score: how many σ away from strike
  const distancePct = (spotPrice - strike) / strike;
  const zScore = distancePct / Math.max(priceBufferPct, 0.00001);

  // Win probability based on z-score
  // At |z| > 3: ~99.9% certain; at |z| > 2: ~97.7%; at |z| < 1: skip (too uncertain)
  const winProbability = clamp(normalCDF(Math.abs(zScore)), 0.5, 0.999);

  // Skip if too close to strike (coin flip territory)
  if (Math.abs(zScore) < 1.5) return null;

  // Direction
  const spotAboveStrike = spotPrice > strike;
  const direction: 'BUY_YES' | 'BUY_NO' = spotAboveStrike ? 'BUY_YES' : 'BUY_NO';

  // Fair value
  const fairValue = spotAboveStrike ? winProbability : (1 - winProbability);

  // Token we're buying
  const tokenPrice = direction === 'BUY_YES' ? yesTokenPrice : (1 - yesTokenPrice);
  const adjustedFairValue = direction === 'BUY_YES' ? fairValue : (1 - fairValue);

  const edge = calculateEdge(adjustedFairValue, tokenPrice, isMaker);

  // Chainlink confirmation
  const chainlinkConfirms = chainlinkPrice
    ? (spotAboveStrike === (chainlinkPrice > strike))
    : false;

  // Confidence scoring
  let confidence = 0;

  // 1. z-score magnitude (0-30 pts) — further from strike = more certain
  confidence += Math.min(Math.abs(zScore) * 10, 30);

  // 2. Edge magnitude (0-20 pts)
  confidence += Math.min(edge.netEdgeCents / 0.3, 20);

  // 3. Chainlink confirmation (0-20 pts)
  if (chainlinkConfirms) confidence += 20;
  else if (chainlinkPrice === null) confidence += 5; // neutral

  // 4. Time proximity — closer to expiry = more predictable (0-20 pts)
  if (secondsToExpiry <= 20) confidence += 20;
  else if (secondsToExpiry <= 45) confidence += 15;
  else if (secondsToExpiry <= 60) confidence += 10;
  else confidence += 5;

  // 5. Token price edge zone (0-10 pts)
  const priceEdge = Math.abs(tokenPrice - 0.5);
  confidence += Math.min(priceEdge * 20, 10);

  confidence = Math.min(Math.round(confidence), 100);

  if (!edge.isProfitable) return null;

  return {
    edge,
    direction,
    spotPrice,
    strike,
    secondsToExpiry,
    zScore,
    winProbability,
    chainlinkConfirms,
    confidence,
  };
}

// ─── Kelly Criterion (Binary Options) ──────────────────

/**
 * Kelly fraction for binary option sizing.
 *
 * For a binary option paying $1 if win, costing $p per share:
 *   f* = (winProb × (1 - p) - (1 - winProb) × p) / (1 - p)
 *      = (winProb - p) / (1 - p)
 *
 * We use fractional Kelly (KELLY_FRACTION × f*) for safety.
 *
 * @param winProbability - estimated P(win)
 * @param tokenPrice - cost per share (0-1)
 * @param balance - available balance in USD
 * @returns recommended position size in USD (0 if no edge)
 */
export function kellySize(
  winProbability: number,
  tokenPrice: number,
  balance: number,
): number {
  if (tokenPrice <= 0 || tokenPrice >= 1) return 0;
  if (winProbability <= tokenPrice) return 0; // no edge

  // Kelly fraction for binary: f* = (p_win - cost) / (1 - cost)
  const fullKelly = (winProbability - tokenPrice) / (1 - tokenPrice);

  // Fractional Kelly
  const fractionalKelly = fullKelly * KELLY_FRACTION;

  // Cap at MAX_POSITION_PCT of balance
  const maxSize = balance * MAX_POSITION_PCT;

  return Math.min(fractionalKelly * balance, maxSize);
}

// ─── Helpers ───────────────────────────────────────────

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

/**
 * Approximate normal CDF using Abramowitz & Stegun formula.
 * Accurate to ~1.5e-7 for all z.
 */
export function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;

  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z);

  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327; // 1/√(2π)
  const p = d * Math.exp(-0.5 * z * z);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));

  return sign === 1 ? 1 - p * poly : p * poly;
}

/**
 * Estimate realized volatility from a price series.
 * Returns annualized vol as decimal (e.g. 0.001 = 0.1% per interval).
 *
 * @param prices - array of recent prices (chronological)
 * @returns per-interval volatility (not annualized)
 */
export function estimateVolatility(prices: number[]): number {
  if (prices.length < 3) return 0.001; // default fallback

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }

  if (returns.length < 2) return 0.001;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);

  return Math.sqrt(variance);
}
