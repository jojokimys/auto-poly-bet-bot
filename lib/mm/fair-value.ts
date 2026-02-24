/**
 * Fair value calculation for binary crypto options on Polymarket.
 *
 * Uses Black-Scholes framework: P(YES) = N(d2) where
 *   d2 = [ln(S/K) - σ²T/2] / (σ√T)
 *
 * Key insight: binary options on Polymarket are essentially
 * "Will BTC be above $97,500 at 5:00 PM?" → European digital option.
 */

import type { Candle } from './types';

// ─── Normal CDF (Abramowitz & Stegun approximation, max error 7.5e-8) ─────

const A1 = 0.254829592;
const A2 = -0.284496736;
const A3 = 1.421413741;
const A4 = -1.453152027;
const A5 = 1.061405429;
const P_CONST = 0.3275911;

export function normalCDF(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + P_CONST * absX);
  const y = 1 - (((((A5 * t + A4) * t) + A3) * t + A2) * t + A1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1 + sign * y);
}

// ─── Binary Option Fair Value ─────────────────────────────

/**
 * Fair value of a binary YES token using Black-Scholes N(d2).
 *
 * @param spot - current spot price (e.g. 97600)
 * @param strike - strike price from market question (e.g. 97500)
 * @param sigma - annualized volatility (e.g. 0.60 for 60%)
 * @param minutesLeft - minutes until expiry
 * @returns P(YES) probability [0, 1]
 */
export function binaryFairValue(
  spot: number,
  strike: number,
  sigma: number,
  minutesLeft: number,
): number {
  if (minutesLeft <= 0) return spot >= strike ? 1 : 0;
  if (strike <= 0 || spot <= 0 || sigma <= 0) return 0.5;

  const T = minutesLeft / (365.25 * 24 * 60); // years
  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(spot / strike) - (sigma * sigma * T) / 2) / (sigma * sqrtT);

  return normalCDF(d2);
}

// ─── Realized Volatility Estimators ───────────────────────

/**
 * Parkinson range-based volatility estimator.
 * 5.2x more efficient than close-to-close.
 *
 * σ² = (1 / 4n·ln2) × Σ [ln(H/L)]²
 */
export function realizedVolParkinson(candles: Candle[]): number {
  if (candles.length < 2) return 0.6; // fallback

  let sumSq = 0;
  for (const c of candles) {
    if (c.high <= 0 || c.low <= 0 || c.high < c.low) continue;
    const logHL = Math.log(c.high / c.low);
    sumSq += logHL * logHL;
  }

  const n = candles.length;
  const variance = sumSq / (4 * n * Math.LN2);

  // Scale from per-candle to annualized
  // Assume candles are 1-minute → 525960 minutes per year
  const minutesPerYear = 365.25 * 24 * 60;
  return Math.sqrt(variance * minutesPerYear);
}

/**
 * Garman-Klass OHLC volatility estimator.
 * 7.4x more efficient than close-to-close.
 *
 * σ² = (1/n) × Σ [0.5·ln(H/L)² - (2ln2-1)·ln(C/O)²]
 */
export function realizedVolGarmanKlass(candles: Candle[]): number {
  if (candles.length < 2) return 0.6; // fallback

  let sum = 0;
  let count = 0;

  for (const c of candles) {
    if (c.high <= 0 || c.low <= 0 || c.open <= 0 || c.close <= 0 || c.high < c.low) continue;
    const logHL = Math.log(c.high / c.low);
    const logCO = Math.log(c.close / c.open);
    sum += 0.5 * logHL * logHL - (2 * Math.LN2 - 1) * logCO * logCO;
    count++;
  }

  if (count < 2) return 0.6;

  const variance = sum / count;
  const minutesPerYear = 365.25 * 24 * 60;
  return Math.sqrt(Math.max(0, variance) * minutesPerYear);
}

// ─── Implied Volatility (bisection) ──────────────────────

/**
 * Solve for implied vol that matches the observed market price.
 * Uses bisection — simple and robust for binary options.
 *
 * @param marketPrice - observed market YES token price (0-1)
 * @param spot - current spot
 * @param strike - strike from market question
 * @param minutesLeft - minutes until expiry
 * @returns annualized implied volatility
 */
export function impliedVol(
  marketPrice: number,
  spot: number,
  strike: number,
  minutesLeft: number,
): number {
  if (minutesLeft <= 0) return 0;
  if (marketPrice <= 0.01 || marketPrice >= 0.99) return 0;

  let lo = 0.01;
  let hi = 5.0; // 500% vol max

  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const modelPrice = binaryFairValue(spot, strike, mid, minutesLeft);

    if (Math.abs(modelPrice - marketPrice) < 0.0001) return mid;

    if (modelPrice > marketPrice) {
      // Model thinks YES is too likely → vol too low (for spot > strike)
      // or vol too high (for spot < strike). Adjust based on moneyness.
      if (spot >= strike) hi = mid;
      else lo = mid;
    } else {
      if (spot >= strike) lo = mid;
      else hi = mid;
    }
  }

  return (lo + hi) / 2;
}

// ─── Mispricing Analysis ─────────────────────────────────

export type MispricingSignal = 'BUY_YES' | 'BUY_NO' | 'NO_TRADE';

export interface MispricingResult {
  signal: MispricingSignal;
  fairYesPrice: number;
  marketYesPrice: number;
  edge: number; // fair - market (positive = YES underpriced)
  confidence: number; // 0-1
}

/**
 * Analyze mispricing between model fair value and market price.
 *
 * @param spot - current spot price
 * @param strike - strike from market question
 * @param sigma - annualized vol
 * @param minutesLeft - minutes to expiry
 * @param marketYesPrice - current market YES token midpoint
 * @param minEdgeCents - minimum edge in cents to trigger signal (default 0.5)
 */
export function analyzeMispricing(
  spot: number,
  strike: number,
  sigma: number,
  minutesLeft: number,
  marketYesPrice: number,
  minEdgeCents = 0.5,
): MispricingResult {
  const fairYesPrice = binaryFairValue(spot, strike, sigma, minutesLeft);
  const edge = fairYesPrice - marketYesPrice;
  const edgeCents = edge * 100;

  // Confidence scales with |edge| and time remaining
  const absEdge = Math.abs(edge);
  const timeConfidence = Math.min(1, minutesLeft / 2); // more time = more reliable
  const confidence = Math.min(1, absEdge * 10) * timeConfidence;

  let signal: MispricingSignal = 'NO_TRADE';
  if (edgeCents > minEdgeCents) {
    signal = 'BUY_YES'; // YES underpriced
  } else if (edgeCents < -minEdgeCents) {
    signal = 'BUY_NO'; // NO underpriced (YES overpriced)
  }

  return {
    signal,
    fairYesPrice: parseFloat(fairYesPrice.toFixed(4)),
    marketYesPrice,
    edge: parseFloat(edge.toFixed(4)),
    confidence: parseFloat(confidence.toFixed(3)),
  };
}
