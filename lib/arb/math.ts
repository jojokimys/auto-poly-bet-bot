/**
 * Arb math utilities — edge calculation, fair value, Kelly sizing, z-scores.
 *
 * Binary option fair value via Black-Scholes:
 *   P(up) = Φ((spot - strike) / (strike × σ × √T))
 *
 * Edge = fairValue - tokenPrice - takerFee
 */

import { takerFeePerShare } from '@/lib/fees';

/** Standard normal CDF (Abramowitz & Stegun approximation) */
export function normalCDF(x: number): number {
  if (x > 8) return 1;
  if (x < -8) return 0;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

/**
 * Inverse normal CDF (Beasley-Springer-Moro approximation).
 * Maps probability [0,1] back to z-score.
 */
export function invNormalCDF(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02,
    -2.759285104469687e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02,
    -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01,
    -2.400758277161838e+00, -2.549732539343734e+00,
    4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01,
    2.445134137142996e+00, 3.754408661907416e+00,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

/**
 * Fair value of "Up" token using Black-Scholes binary option probability.
 * @param spot - Current CEX spot price (e.g. Binance BTC)
 * @param strike - Reference price at market open
 * @param vol - Annualized volatility as decimal (e.g. 0.5 for 50%)
 * @param secondsToExpiry - Seconds until market settlement
 * @returns Probability that spot > strike at expiry [0, 1]
 */
export function fairValueUp(spot: number, strike: number, vol: number, secondsToExpiry: number): number {
  if (secondsToExpiry <= 0) return spot >= strike ? 1 : 0;
  if (vol <= 0 || strike <= 0) return spot >= strike ? 0.99 : 0.01;

  const T = secondsToExpiry / (365.25 * 24 * 3600); // fraction of year
  const d = (Math.log(spot / strike)) / (vol * Math.sqrt(T));
  return normalCDF(d);
}

/**
 * Estimate short-term realized volatility from recent price samples.
 * Returns annualized vol. Uses log returns.
 * @param prices - Recent price samples (chronological)
 * @param intervalSec - Average interval between samples in seconds
 */
export function estimateVolatility(prices: number[], intervalSec: number): number {
  if (prices.length < 3 || intervalSec <= 0) return 0.5; // default 50% annualized

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  if (returns.length < 2) return 0.5;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdPerInterval = Math.sqrt(variance);

  // Annualize: σ_annual = σ_interval × √(intervals_per_year)
  const intervalsPerYear = (365.25 * 24 * 3600) / intervalSec;
  const annualized = stdPerInterval * Math.sqrt(intervalsPerYear);

  // Floor at 0.20% short-term vol (prevents phantom edges)
  const VOL_FLOOR = 0.002 * Math.sqrt(intervalsPerYear);
  return Math.max(annualized, VOL_FLOOR);
}

/**
 * Calculate z-score of current price move relative to recent volatility.
 * High z-score = strong directional move = higher confidence.
 */
export function zScore(spot: number, strike: number, vol: number, secondsToExpiry: number): number {
  if (vol <= 0 || secondsToExpiry <= 0 || strike <= 0) return 0;
  const T = secondsToExpiry / (365.25 * 24 * 3600);
  return Math.log(spot / strike) / (vol * Math.sqrt(T));
}

/**
 * Net edge in cents for a trade.
 * @param fairValue - Model fair value [0, 1]
 * @param tokenPrice - CLOB token price [0, 1]
 * @param isMaker - Maker orders have zero taker fee
 * @returns Edge in cents (positive = profitable)
 */
export function netEdgeCents(fairValue: number, tokenPrice: number, isMaker: boolean): number {
  const rawEdge = (fairValue - tokenPrice) * 100;
  if (isMaker) return rawEdge;
  const feeCents = takerFeePerShare(tokenPrice) * 100;
  return rawEdge - feeCents;
}

/**
 * Kelly criterion for binary options.
 * f* = (winProb - tokenPrice) / (1 - tokenPrice)
 * Use fractional Kelly (0.25x) to reduce variance.
 */
export function kellySizing(winProb: number, tokenPrice: number, kellyFraction = 0.25): number {
  if (winProb <= tokenPrice || tokenPrice >= 1 || tokenPrice <= 0) return 0;
  const fullKelly = (winProb - tokenPrice) / (1 - tokenPrice);
  return Math.max(0, Math.min(1, fullKelly * kellyFraction));
}

/**
 * Time-scaled z-threshold for latency arb.
 * Earlier in the window = need stronger signal (noisy).
 * Later in window = lower threshold (more data, more certainty).
 */
export function zThreshold(secondsToExpiry: number): number {
  if (secondsToExpiry > 250) return 2.5;
  if (secondsToExpiry > 200) return 2.0;
  if (secondsToExpiry > 100) return 1.8;
  return 1.5;
}

/**
 * Dynamic max shares based on token price.
 * Expensive tokens ($0.60+) → fewer shares to limit dollar risk.
 * Cheap tokens → need more shares to meet $1 minimum order.
 */
export function maxSharesForPrice(tokenPrice: number, baseMax: number, minShares: number): number {
  if (tokenPrice > 0.60) {
    const scaled = Math.ceil(baseMax * (1 - tokenPrice));
    return Math.max(scaled, minShares);
  }
  return Math.max(baseMax, minShares);
}

/**
 * Price gate — require higher z-score for expensive tokens.
 * Returns required z-score, or Infinity to block entry.
 */
export function priceGate(tokenPrice: number): number {
  if (tokenPrice >= 0.90) return Infinity; // hard block
  if (tokenPrice >= 0.85) return 2.5;
  if (tokenPrice >= 0.80) return 2.5;
  if (tokenPrice >= 0.75) return 2.0;
  if (tokenPrice >= 0.65) return 2.0;
  return 0; // no extra gate for cheap tokens
}
