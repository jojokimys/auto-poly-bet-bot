import 'server-only';

import type { BotConfig, StrategySignal, RiskCheckResult } from './types';

/**
 * Validate a strategy signal against risk limits.
 * Returns whether the trade is allowed and an optionally adjusted size.
 */
export function checkRisk(
  signal: StrategySignal,
  config: BotConfig,
  balance: number,
  openPositionCount: number,
  totalExposure: number
): RiskCheckResult {
  // Check max open positions
  if (openPositionCount >= config.maxOpenPositions) {
    return { allowed: false, reason: `Max open positions reached (${config.maxOpenPositions})` };
  }

  // Check portfolio exposure limit
  const maxExposureAmount = balance * config.maxPortfolioExposure;
  const remainingExposure = maxExposureAmount - totalExposure;
  if (remainingExposure <= 0) {
    return { allowed: false, reason: 'Portfolio exposure limit reached' };
  }

  // Check we have enough balance
  const tradeCost = signal.price * signal.size;
  if (tradeCost > balance * 0.95) {
    return { allowed: false, reason: 'Insufficient balance (need 5% buffer)' };
  }

  // Cap size to max bet amount
  let adjustedSize = signal.size;
  if (tradeCost > config.maxBetAmount) {
    adjustedSize = config.maxBetAmount / signal.price;
  }

  // Cap to remaining exposure
  const adjustedCost = signal.price * adjustedSize;
  if (adjustedCost > remainingExposure) {
    adjustedSize = remainingExposure / signal.price;
  }

  // Minimum viable trade size ($1)
  if (signal.price * adjustedSize < 1) {
    return { allowed: false, reason: 'Trade too small after risk adjustment' };
  }

  return { allowed: true, adjustedSize };
}
