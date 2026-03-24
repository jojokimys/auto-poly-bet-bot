import type { RewardMarket } from './scanner';

/**
 * Polymarket Liquidity Rewards Q-Score Calculator
 *
 * Scoring formula: S(v, s) = ((v - s) / v)² × size
 * - v = max spread (rewardsMaxSpread in cents)
 * - s = actual spread from midpoint (in cents)
 *
 * Two-sided bonus: min(Q_one, Q_two) for balanced quoting
 * Single-sided penalty: divided by c=3.0 when midpoint in [0.10, 0.90]
 */

const SINGLE_SIDE_PENALTY = 3.0;

/** Calculate order score: S(v, s) = ((v - s) / v)² */
export function orderScore(maxSpread: number, actualSpread: number): number {
  if (actualSpread >= maxSpread || maxSpread <= 0) return 0;
  const ratio = (maxSpread - actualSpread) / maxSpread;
  return ratio * ratio;
}

export interface LpOrder {
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  /** Which token this order is for: 0=Yes, 1=No */
  tokenIndex: number;
}

export interface QScoreResult {
  qOne: number;
  qTwo: number;
  qMin: number;
  orders: LpOrder[];
}

/**
 * Calculate Q score for a set of proposed LP orders on a market.
 *
 * "First side" (Q_one): BUY on Yes + SELL on No (providing bid depth on Yes outcome)
 * "Second side" (Q_two): SELL on Yes + BUY on No (providing ask depth on Yes outcome)
 */
export function calculateQScore(
  market: RewardMarket,
  orders: LpOrder[],
): QScoreResult {
  const v = market.rewardsMaxSpread; // max spread in cents
  const mid = market.midpoint;

  let qOne = 0; // bid-side depth (BUY Yes + SELL No)
  let qTwo = 0; // ask-side depth (SELL Yes + BUY No)

  for (const order of orders) {
    // Calculate spread from midpoint in cents
    let spreadCents: number;
    if (order.tokenIndex === 0) {
      // Yes token
      spreadCents = Math.abs(order.price - mid) * 100;
    } else {
      // No token — complement. The No midpoint = 1 - Yes midpoint
      const noMid = 1 - mid;
      spreadCents = Math.abs(order.price - noMid) * 100;
    }

    const score = orderScore(v, spreadCents) * order.size;

    if (order.tokenIndex === 0 && order.side === 'BUY') qOne += score;
    else if (order.tokenIndex === 0 && order.side === 'SELL') qTwo += score;
    else if (order.tokenIndex === 1 && order.side === 'BUY') qTwo += score;
    else if (order.tokenIndex === 1 && order.side === 'SELL') qOne += score;
  }

  // Two-sided liquidity adjustment
  let qMin: number;
  if (mid >= 0.10 && mid <= 0.90) {
    // Single-sided allowed but penalized by c=3.0
    qMin = Math.max(
      Math.min(qOne, qTwo),
      Math.max(qOne / SINGLE_SIDE_PENALTY, qTwo / SINGLE_SIDE_PENALTY),
    );
  } else {
    // Extreme midpoints: must be two-sided
    qMin = Math.min(qOne, qTwo);
  }

  return { qOne, qTwo, qMin, orders };
}

export interface RewardEfficiency {
  market: RewardMarket;
  qScorePerDollar: number;
  optimalOrders: LpOrder[];
  qScore: QScoreResult;
  /** Estimated daily reward share (relative, not absolute) */
  rewardRatio: number;
  /** Minimum capital to qualify for rewards (two-sided) */
  minCapital: number;
  /** Daily ROI % at minimum capital */
  roiAtMin: number;
  /** Daily ROI % at configured capital */
  roiAtConfig: number;
  /** Estimated daily reward ($) at configured capital */
  estDailyReward: number;
}

/**
 * Calculate the reward efficiency for a market — how much Q score you get per dollar deployed.
 *
 * @param spreadPct - 0-100: where to place orders as % of maxSpread from midpoint
 *   0 = 1¢ from mid (max Q, max fill risk)
 *   70 = 70% of maxSpread (low fill risk, decent Q) — DEFAULT
 *   100 = at maxSpread edge (min Q, no fill risk)
 */
export function calculateRewardEfficiency(
  market: RewardMarket,
  capitalPerSide: number,
  spreadPct: number = 70,
): RewardEfficiency {
  const v = market.rewardsMaxSpread;
  const mid = market.midpoint;
  const minSize = market.rewardsMinSize || 1;

  const size = Math.max(minSize, capitalPerSide);

  // Calculate spread based on spreadPct
  const rawSpreadCents = (spreadPct / 100) * v;
  const spreadCents = Math.max(1, Math.min(rawSpreadCents, v - 0.5));
  const spreadDecimal = spreadCents / 100;

  const orders: LpOrder[] = [
    { side: 'BUY', price: roundPrice(mid - spreadDecimal), size, tokenIndex: 0 },
    { side: 'BUY', price: roundPrice((1 - mid) - spreadDecimal), size, tokenIndex: 1 },
  ];

  const qScore = calculateQScore(market, orders);

  const capitalRequired = orders.reduce((sum, o) => sum + o.size * o.price, 0);
  const qScorePerDollar = capitalRequired > 0 ? qScore.qMin / capitalRequired : 0;

  // Reward ratio: estimated daily reward share per dollar deployed
  // = (our Q / total pool Q proxy) × daily rate / our capital
  // Simplified: dailyRate × Q / (liquidity competition) / capital
  const dailyRate = market.rewardsDailyRate || 0;
  const liquidity = market.liquidity || 0;
  const competitionFactor = liquidity > 0 ? 1 / liquidity : 1;
  const rewardRatio = dailyRate * qScore.qMin * competitionFactor;

  // Minimum capital: minSize shares × price for each side (≈ minSize in dollars)
  const minCapital = minSize * mid + minSize * (1 - mid);

  // ROI calculations: reward = dailyRate × ourCapital / (ourCapital + liquidity)
  const rewardAtMin = liquidity + minCapital > 0
    ? dailyRate * minCapital / (minCapital + liquidity) : 0;
  const roiAtMin = minCapital > 0 ? (rewardAtMin / minCapital) * 100 : 0;

  const rewardAtConfig = liquidity + capitalPerSide > 0
    ? dailyRate * capitalPerSide / (capitalPerSide + liquidity) : 0;
  const roiAtConfig = capitalPerSide > 0 ? (rewardAtConfig / capitalPerSide) * 100 : 0;

  return {
    market,
    qScorePerDollar,
    optimalOrders: orders,
    qScore,
    rewardRatio,
    minCapital,
    roiAtMin,
    roiAtConfig,
    estDailyReward: rewardAtConfig,
  };
}

/**
 * Rank all reward markets by ROI at optimal (minimum) capital.
 * Then greedily allocate from a total balance, picking highest-ROI markets first.
 *
 * @param balance - Total available balance (0 = ignore balance, use all markets)
 * @param cashReservePct - Fraction of balance to keep as cash reserve (e.g., 0.40)
 */
export function rankMarketsByEfficiency(
  markets: RewardMarket[],
  capitalPerSide: number = 50,
  topN: number = 20,
  spreadPct: number = 70,
  balance: number = 0,
  cashReservePct: number = 0.40,
): RewardEfficiency[] {
  const results = markets
    .map((m) => calculateRewardEfficiency(m, capitalPerSide, spreadPct))
    .filter((r) => r.qScore.qMin > 0 && r.market.rewardsDailyRate > 0)
    // Sort by ROI at minimum capital (highest ROI first)
    .sort((a, b) => b.roiAtMin - a.roiAtMin);

  // If no balance provided or insufficient, return top N by ROI
  if (balance <= 0) return results.slice(0, topN);

  const available = balance * (1 - cashReservePct);
  // If balance too small for even one market, still return top N (for display)
  if (available < (results[0]?.minCapital ?? Infinity)) {
    return results.slice(0, topN);
  }

  // Greedy allocation: pick highest-ROI markets until budget exhausted
  const selected: RewardEfficiency[] = [];
  let remaining = available;

  for (const r of results) {
    if (selected.length >= topN) break;
    if (remaining <= 0) break;

    const needed = r.minCapital;
    if (needed > remaining) continue;

    remaining -= needed;
    selected.push(r);
  }

  return selected;
}

function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}
