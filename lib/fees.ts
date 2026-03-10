/** Polymarket taker fee calculations.
 *
 * Fee curve: takerFee = shares × 0.25 × (price × (1 - price))²
 * - At 50c: ~1.56% (kills profitability)
 * - At 15c/85c: ~0.013% (nearly free)
 * - Post-only (maker) orders: ZERO taker fee + earn 20% rebate pool
 */

/** Absolute taker fee per share at a given price */
export function takerFeePerShare(price: number): number {
  const p = Math.max(0, Math.min(1, price));
  return 0.25 * (p * (1 - p)) ** 2;
}

/** Taker fee as a percentage of price (0-1 scale) */
export function takerFeePct(price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return takerFeePerShare(price) / price;
}

/**
 * Check if a trade is profitable after fees.
 * @param price - token price (0-1)
 * @param edgeCents - expected edge in cents (e.g. 2 = 2c edge)
 * @param isMaker - true if using post-only (zero fee)
 * @returns true if expected profit > fee cost
 */
export function isFeeProfitable(price: number, edgeCents: number, isMaker: boolean): boolean {
  if (isMaker) return edgeCents > 0;
  const feeCents = takerFeePerShare(price) * 100;
  return edgeCents > feeCents;
}
