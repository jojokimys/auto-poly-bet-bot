import 'server-only';

import type { TradeRecord } from '@/lib/types/polymarket';
import type {
  DashboardTrade,
  DashboardStats,
  BalanceDataPoint,
  PnlDataPoint,
  DashboardData,
} from '@/lib/types/dashboard';
import { getTrades, getBalanceAllowance } from './trading';

/** Convert raw TradeRecord → DashboardTrade with numeric fields */
export function parseTrade(t: TradeRecord): DashboardTrade {
  const price = parseFloat(t.price);
  const size = parseFloat(t.size);
  const feeRateBps = parseFloat(t.fee_rate_bps || '0');
  const cost = price * size;
  const fee = cost * (feeRateBps / 10_000);

  return {
    id: t.id,
    market: t.market,
    asset_id: t.asset_id,
    side: t.side,
    outcome: t.outcome,
    price,
    size,
    fee,
    cost,
    matchTime: t.match_time,
    realizedPnl: null,
  };
}

/**
 * FIFO BUY/SELL matching per asset_id.
 * Sets `realizedPnl` on sell trades.
 */
export function matchTrades(trades: DashboardTrade[]): DashboardTrade[] {
  // Group by asset_id
  const byAsset = new Map<string, DashboardTrade[]>();
  for (const t of trades) {
    const list = byAsset.get(t.asset_id) ?? [];
    list.push(t);
    byAsset.set(t.asset_id, list);
  }

  const result: DashboardTrade[] = [];

  for (const [, assetTrades] of byAsset) {
    // Sort chronologically
    assetTrades.sort(
      (a, b) => new Date(a.matchTime).getTime() - new Date(b.matchTime).getTime()
    );

    const buyQueue: { price: number; size: number; fee: number }[] = [];

    for (const trade of assetTrades) {
      if (trade.side === 'BUY') {
        buyQueue.push({ price: trade.price, size: trade.size, fee: trade.fee });
        result.push(trade);
      } else {
        // SELL — match against BUY queue
        let remaining = trade.size;
        let totalBuyCost = 0;
        let totalBuyFee = 0;

        while (remaining > 0 && buyQueue.length > 0) {
          const buy = buyQueue[0];
          const matched = Math.min(remaining, buy.size);
          totalBuyCost += matched * buy.price;
          totalBuyFee += buy.fee * (matched / buy.size);
          buy.size -= matched;
          remaining -= matched;
          if (buy.size <= 0.0001) buyQueue.shift();
        }

        const sellRevenue = trade.size * trade.price;
        const pnl = sellRevenue - totalBuyCost - trade.fee - totalBuyFee;
        result.push({ ...trade, realizedPnl: pnl });
      }
    }
  }

  // Re-sort all trades chronologically
  result.sort(
    (a, b) => new Date(a.matchTime).getTime() - new Date(b.matchTime).getTime()
  );

  return result;
}

/** Compute aggregate statistics from matched trades */
export function computeStats(
  trades: DashboardTrade[],
  currentBalance: number
): DashboardStats {
  const sells = trades.filter((t) => t.side === 'SELL' && t.realizedPnl !== null);
  const wins = sells.filter((t) => t.realizedPnl! > 0);
  const losses = sells.filter((t) => t.realizedPnl! < 0);

  const totalPnl = sells.reduce((sum, t) => sum + t.realizedPnl!, 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.realizedPnl!, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPnl!, 0));
  const totalFees = trades.reduce((sum, t) => sum + t.fee, 0);

  // Count open positions: assets with unmatched buys
  const netByAsset = new Map<string, number>();
  for (const t of trades) {
    const current = netByAsset.get(t.asset_id) ?? 0;
    netByAsset.set(
      t.asset_id,
      t.side === 'BUY' ? current + t.size : current - t.size
    );
  }
  const openPositions = [...netByAsset.values()].filter((v) => v > 0.001).length;

  const pnlValues = sells.map((t) => t.realizedPnl!);

  return {
    totalTrades: trades.length,
    totalBuys: trades.filter((t) => t.side === 'BUY').length,
    totalSells: sells.length,
    winRate: sells.length > 0 ? wins.length / sells.length : 0,
    totalPnl,
    avgTradeSize: trades.length > 0
      ? trades.reduce((s, t) => s + t.cost, 0) / trades.length
      : 0,
    bestTrade: pnlValues.length > 0 ? Math.max(...pnlValues) : 0,
    worstTrade: pnlValues.length > 0 ? Math.min(...pnlValues) : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    totalFees,
    openPositions,
    currentBalance,
  };
}

/**
 * Build balance history by walking backwards from current balance
 * to infer starting balance, then forward to produce data points.
 */
export function buildBalanceHistory(
  trades: DashboardTrade[],
  currentBalance: number
): BalanceDataPoint[] {
  if (trades.length === 0) {
    return [{ date: new Date().toISOString(), balance: currentBalance }];
  }

  // Walk backwards to infer starting balance
  // Each BUY decreases balance (we paid), each SELL increases it (we received)
  let inferredStart = currentBalance;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t.side === 'BUY') {
      inferredStart += t.cost + t.fee;
    } else {
      inferredStart -= t.cost - t.fee;
    }
  }

  // Walk forward producing data points
  const points: BalanceDataPoint[] = [];
  let balance = inferredStart;
  points.push({ date: trades[0].matchTime, balance });

  for (const t of trades) {
    if (t.side === 'BUY') {
      balance -= t.cost + t.fee;
    } else {
      balance += t.cost - t.fee;
    }
    points.push({ date: t.matchTime, balance });
  }

  return points;
}

/** Build cumulative P&L history from matched sell trades */
export function buildPnlHistory(trades: DashboardTrade[]): PnlDataPoint[] {
  const sells = trades.filter((t) => t.side === 'SELL' && t.realizedPnl !== null);
  if (sells.length === 0) return [];

  let cumulative = 0;
  return sells.map((t) => {
    cumulative += t.realizedPnl!;
    return { date: t.matchTime, pnl: cumulative };
  });
}

/** Main entry: fetch data from Polymarket and compute all analytics */
export async function getDashboardData(): Promise<DashboardData> {
  const [rawTrades, balanceResult] = await Promise.all([
    getTrades(),
    getBalanceAllowance(),
  ]);

  const currentBalance = parseFloat(balanceResult.balance);
  const parsed = rawTrades.map(parseTrade);
  const matched = matchTrades(parsed);
  const stats = computeStats(matched, currentBalance);
  const balanceHistory = buildBalanceHistory(matched, currentBalance);
  const pnlHistory = buildPnlHistory(matched);

  return {
    trades: matched,
    stats,
    balanceHistory,
    pnlHistory,
  };
}
