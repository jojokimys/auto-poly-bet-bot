import type { ActiveMarket, MMConfig, QuoteResult, VolatilityRegime } from './types';

const SPREAD_MULTIPLIERS: Record<VolatilityRegime, number> = {
  calm: 1.0,
  normal: 1.5,
  elevated: 2.5,
  volatile: 0, // no quoting
};

const SKEW_PER_SHARE = 0.005; // 1 share imbalance → 0.5c skew
const MIN_PRICE = 0.05;
const MAX_PRICE = 0.95;
const MAX_COMBINED_COST = 0.975; // must be < $0.98 for profitability

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function roundToTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

export function calculateQuotes(
  market: ActiveMarket,
  regime: VolatilityRegime,
  config: MMConfig,
  balance: number,
  tickSize = 0.01,
): QuoteResult | null {
  // No quoting in volatile regime
  if (regime === 'volatile') return null;

  // Need valid midpoint
  if (market.midpoint === null || market.midpoint <= 0.05 || market.midpoint >= 0.95) return null;

  const mid = market.midpoint;
  const baseSpread = config.baseSpreadCents / 100;
  const spread = baseSpread * SPREAD_MULTIPLIERS[regime];
  const halfSpread = spread / 2;

  // Inventory skew: push quotes to reduce imbalance
  const netInventory = market.yesHeld - market.noHeld;
  const skew = netInventory * SKEW_PER_SHARE;

  // BUY YES price (our bid for YES)
  let bidPrice = mid - halfSpread - skew;
  // BUY NO price (effectively our ask for YES at 1 - askPrice)
  let askPrice = (1 - mid) - halfSpread + skew;

  // Round to tick size
  bidPrice = roundToTick(bidPrice, tickSize);
  askPrice = roundToTick(askPrice, tickSize);

  // Clamp to valid range
  bidPrice = clamp(bidPrice, MIN_PRICE, MAX_PRICE);
  askPrice = clamp(askPrice, MIN_PRICE, MAX_PRICE);

  // Profitability check: combined cost must be < $0.975
  if (bidPrice + askPrice >= MAX_COMBINED_COST) return null;

  // Position sizing: don't exceed balance or max position
  if (!Number.isFinite(balance) || balance <= 0) return null;

  const costPerShare = Math.max(bidPrice, askPrice);
  const maxByBalance = costPerShare > 0 ? Math.floor(balance / (costPerShare * 2)) : 0;
  const size = Math.min(config.maxPositionSize, maxByBalance);

  if (!Number.isFinite(size) || size < 1) return null;
  if (!Number.isFinite(bidPrice) || !Number.isFinite(askPrice)) return null;

  return { bidPrice, askPrice, size };
}
