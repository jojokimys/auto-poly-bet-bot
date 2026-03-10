/**
 * Trade Logger — structured logging for bot self-improvement.
 *
 * Logs every trade decision with full context (prices, edge, confidence, result).
 * The bot can query past logs to identify patterns:
 *   - Which confidence levels actually win?
 *   - Which z-score thresholds are too aggressive?
 *   - Fee impact on different price zones
 *   - Latency arb hit rate by strike distance
 */

import { prisma } from '@/lib/db/prisma';

// ─── Trade Log Types ───────────────────────────────────

export type TradeStrategy = 'latency-arb' | 'expiry-sniper';
export type TradeOutcome = 'win' | 'loss' | 'breakeven' | 'pending' | 'cancelled';

export interface TradeLogEntry {
  // Identity
  profileId: string;
  strategy: TradeStrategy;

  // Market context
  conditionId: string;
  tokenId: string;
  outcome: string; // "Yes" or "No"
  strike: number;

  // Prices at decision time
  spotPrice: number;
  chainlinkPrice: number | null;
  yesTokenPrice: number;
  bestBid: number;
  bestAsk: number;

  // Edge analysis
  fairValue: number;
  rawEdgeCents: number;
  netEdgeCents: number;
  feeCents: number;
  edgeRatio: number;

  // Signal details
  direction: 'BUY_YES' | 'BUY_NO';
  confidence: number;

  // Strategy-specific
  /** Latency arb: micro-momentum at signal time */
  microMomentum?: number;
  /** Latency arb: strike distance % */
  strikeDistancePct?: number;
  /** Expiry sniper: seconds to expiry */
  secondsToExpiry?: number;
  /** Expiry sniper: z-score */
  zScore?: number;
  /** Expiry sniper: estimated win probability */
  winProbability?: number;
  /** Expiry sniper: chainlink confirmed? */
  chainlinkConfirms?: boolean;

  // Execution
  orderPrice: number;
  orderSize: number;
  isMaker: boolean;

  // Timing
  signalTimestamp: number;
  orderTimestamp?: number;
  fillTimestamp?: number;
  settlementTimestamp?: number;

  // Result (filled in later)
  fillPrice?: number;
  fillSize?: number;
  tradeOutcome?: TradeOutcome;
  pnl?: number;
  settlementPrice?: number;
}

// ─── Database Operations ───────────────────────────────

/**
 * Log a trade signal to BotLog with structured data.
 * Uses the existing BotLog model for storage.
 */
export async function logTradeSignal(entry: TradeLogEntry): Promise<string> {
  const log = await prisma.botLog.create({
    data: {
      profileId: entry.profileId,
      level: 'trade',
      event: 'signal',
      message: `[${entry.strategy}] ${entry.direction} ${entry.outcome} @ ${entry.orderPrice.toFixed(3)} | edge=${entry.netEdgeCents.toFixed(1)}c conf=${entry.confidence}`,
      data: JSON.stringify(entry),
    },
  });
  return log.id;
}

/**
 * Update a trade log with execution result.
 */
export async function logTradeResult(
  logId: string,
  result: {
    fillPrice?: number;
    fillSize?: number;
    tradeOutcome: TradeOutcome;
    pnl?: number;
    settlementPrice?: number;
    fillTimestamp?: number;
    settlementTimestamp?: number;
  },
): Promise<void> {
  const existing = await prisma.botLog.findUnique({ where: { id: logId } });
  if (!existing || !existing.data) return;

  const entry: TradeLogEntry = JSON.parse(existing.data);
  Object.assign(entry, result);

  await prisma.botLog.update({
    where: { id: logId },
    data: {
      level: result.tradeOutcome === 'win' ? 'trade' : result.tradeOutcome === 'loss' ? 'warn' : 'trade',
      event: 'result',
      message: `[${entry.strategy}] ${result.tradeOutcome.toUpperCase()} | pnl=${result.pnl?.toFixed(2) ?? '?'} | ${entry.direction} ${entry.outcome} @ ${entry.orderPrice.toFixed(3)}`,
      data: JSON.stringify(entry),
    },
  });
}

/**
 * Log an order placement event.
 */
export async function logOrderPlaced(
  profileId: string,
  strategy: TradeStrategy,
  data: {
    tokenId: string;
    side: string;
    price: number;
    size: number;
    orderId?: string;
    isMaker: boolean;
  },
): Promise<void> {
  await prisma.botLog.create({
    data: {
      profileId,
      level: 'info',
      event: 'order',
      message: `[${strategy}] ${data.side} ${data.size.toFixed(1)} shares @ ${data.price.toFixed(3)} ${data.isMaker ? '(maker)' : '(taker)'}`,
      data: JSON.stringify(data),
    },
  });
}

/**
 * Log a skip (opportunity seen but not taken).
 */
export async function logSkip(
  profileId: string,
  strategy: TradeStrategy,
  reason: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await prisma.botLog.create({
    data: {
      profileId,
      level: 'info',
      event: 'signal',
      message: `[${strategy}] SKIP: ${reason}`,
      data: data ? JSON.stringify(data) : null,
    },
  });
}

/**
 * Log an error during trading.
 */
export async function logTradeError(
  profileId: string,
  strategy: TradeStrategy,
  error: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await prisma.botLog.create({
    data: {
      profileId,
      level: 'error',
      event: 'error',
      message: `[${strategy}] ERROR: ${error}`,
      data: data ? JSON.stringify(data) : null,
    },
  });
}

// ─── Analytics Queries ─────────────────────────────────

export interface TradeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgEdgeCents: number;
  avgConfidence: number;
  avgNetEdge: number;
  profitFactor: number;
}

/**
 * Get aggregated trade stats for a strategy over a time window.
 */
export async function getTradeStats(
  profileId: string,
  strategy: TradeStrategy,
  hoursBack: number = 24,
): Promise<TradeStats> {
  const since = new Date(Date.now() - hoursBack * 3600 * 1000);

  const logs = await prisma.botLog.findMany({
    where: {
      profileId,
      event: 'result',
      createdAt: { gte: since },
      message: { contains: `[${strategy}]` },
    },
    orderBy: { createdAt: 'desc' },
  });

  const entries: TradeLogEntry[] = logs
    .filter(l => l.data)
    .map(l => JSON.parse(l.data!));

  const wins = entries.filter(e => e.tradeOutcome === 'win');
  const losses = entries.filter(e => e.tradeOutcome === 'loss');
  const totalPnl = entries.reduce((sum, e) => sum + (e.pnl ?? 0), 0);
  const grossWins = wins.reduce((sum, e) => sum + Math.max(e.pnl ?? 0, 0), 0);
  const grossLosses = Math.abs(losses.reduce((sum, e) => sum + Math.min(e.pnl ?? 0, 0), 0));

  return {
    totalTrades: entries.length,
    wins: wins.length,
    losses: losses.length,
    winRate: entries.length > 0 ? wins.length / entries.length : 0,
    totalPnl,
    avgPnl: entries.length > 0 ? totalPnl / entries.length : 0,
    avgEdgeCents: entries.length > 0
      ? entries.reduce((sum, e) => sum + e.rawEdgeCents, 0) / entries.length : 0,
    avgConfidence: entries.length > 0
      ? entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length : 0,
    avgNetEdge: entries.length > 0
      ? entries.reduce((sum, e) => sum + e.netEdgeCents, 0) / entries.length : 0,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
  };
}

/**
 * Get performance breakdown by confidence bucket.
 * Used by the bot to learn which confidence levels actually produce wins.
 */
export async function getConfidenceBuckets(
  profileId: string,
  strategy: TradeStrategy,
  hoursBack: number = 168, // 1 week
): Promise<{ bucket: string; trades: number; winRate: number; avgPnl: number }[]> {
  const since = new Date(Date.now() - hoursBack * 3600 * 1000);

  const logs = await prisma.botLog.findMany({
    where: {
      profileId,
      event: 'result',
      createdAt: { gte: since },
      message: { contains: `[${strategy}]` },
    },
  });

  const entries: TradeLogEntry[] = logs
    .filter(l => l.data)
    .map(l => JSON.parse(l.data!));

  const buckets = [
    { label: '0-30', min: 0, max: 30 },
    { label: '30-50', min: 30, max: 50 },
    { label: '50-70', min: 50, max: 70 },
    { label: '70-85', min: 70, max: 85 },
    { label: '85-100', min: 85, max: 100 },
  ];

  return buckets.map(b => {
    const inBucket = entries.filter(e => e.confidence >= b.min && e.confidence < b.max);
    const wins = inBucket.filter(e => e.tradeOutcome === 'win');
    const totalPnl = inBucket.reduce((sum, e) => sum + (e.pnl ?? 0), 0);

    return {
      bucket: b.label,
      trades: inBucket.length,
      winRate: inBucket.length > 0 ? wins.length / inBucket.length : 0,
      avgPnl: inBucket.length > 0 ? totalPnl / inBucket.length : 0,
    };
  });
}

/**
 * Get recent trade entries (raw) for review/debugging.
 */
export async function getRecentTrades(
  profileId: string,
  strategy?: TradeStrategy,
  limit: number = 50,
): Promise<TradeLogEntry[]> {
  const where: any = {
    profileId,
    event: { in: ['signal', 'result'] },
    level: 'trade',
  };
  if (strategy) {
    where.message = { contains: `[${strategy}]` };
  }

  const logs = await prisma.botLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return logs
    .filter(l => l.data)
    .map(l => JSON.parse(l.data!));
}

/**
 * Get adaptive thresholds based on historical performance.
 * The bot uses this to self-adjust confidence/edge requirements.
 */
export async function getAdaptiveThresholds(
  profileId: string,
  strategy: TradeStrategy,
): Promise<{
  minConfidence: number;
  minEdgeCents: number;
  suggestedKellyFraction: number;
}> {
  const buckets = await getConfidenceBuckets(profileId, strategy, 168);
  const stats = await getTradeStats(profileId, strategy, 168);

  // Find minimum confidence bucket that's profitable
  let minConfidence = 50; // default
  for (const b of buckets) {
    if (b.trades >= 5 && b.winRate >= 0.55 && b.avgPnl > 0) {
      minConfidence = parseInt(b.bucket.split('-')[0]);
      break;
    }
  }

  // Adjust edge requirement based on recent profitability
  // Floor at 3.0c (MIN_EDGE_CENTS) — never go below the constant
  let minEdgeCents = 3.0; // match MIN_EDGE_CENTS
  if (stats.totalTrades >= 10) {
    if (stats.winRate < 0.45) {
      minEdgeCents = 4.0; // tighten up if losing
    } else if (stats.winRate > 0.65 && stats.profitFactor > 2) {
      minEdgeCents = 3.0; // even when winning big, don't drop below 3c
    }
  }

  // Adjust Kelly based on recent drawdown
  let kellyFraction = 0.25;
  if (stats.totalTrades >= 10) {
    if (stats.totalPnl < 0) {
      kellyFraction = 0.1; // reduce size during drawdown
    } else if (stats.profitFactor > 3) {
      kellyFraction = 0.35; // increase if strong edge
    }
  }

  return {
    minConfidence,
    minEdgeCents,
    suggestedKellyFraction: kellyFraction,
  };
}
