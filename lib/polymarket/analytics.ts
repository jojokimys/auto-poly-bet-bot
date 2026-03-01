import 'server-only';

import type { TradeRecord } from '@/lib/types/polymarket';
import type {
  DashboardTrade,
  DashboardStats,
  BalanceDataPoint,
  PnlDataPoint,
  DashboardData,
} from '@/lib/types/dashboard';
import { prisma } from '@/lib/db/prisma';
import {
  getClientForProfile,
  getProfileBalance,
  type ProfileCredentials,
} from '@/lib/bot/profile-client';

/** Convert raw TradeRecord → DashboardTrade with numeric fields */
export function parseTrade(
  t: TradeRecord,
  profileId?: string,
  profileName?: string,
): DashboardTrade {
  const price = parseFloat(t.price);
  const size = parseFloat(t.size);
  const feeRateBps = parseFloat(t.fee_rate_bps || '0');
  const cost = price * size;
  const fee = cost * (feeRateBps / 10_000);

  // match_time can be Unix seconds string ("1771085685") or ISO string
  let matchTime = t.match_time;
  const asNum = Number(matchTime);
  if (!isNaN(asNum) && asNum > 1_000_000_000 && asNum < 2_000_000_000) {
    // Unix seconds → ISO string
    matchTime = new Date(asNum * 1000).toISOString();
  }

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
    matchTime,
    realizedPnl: null,
    profileId,
    profileName,
  };
}

/**
 * FIFO BUY/SELL matching per asset_id (and per profile when mixing profiles).
 * Sets `realizedPnl` on sell trades.
 */
export function matchTrades(trades: DashboardTrade[]): DashboardTrade[] {
  // Group by composite key: profileId + asset_id
  // This ensures FIFO matching is scoped per-profile per-asset
  const byKey = new Map<string, DashboardTrade[]>();
  for (const t of trades) {
    const key = `${t.profileId ?? '_'}::${t.asset_id}`;
    const list = byKey.get(key) ?? [];
    list.push(t);
    byKey.set(key, list);
  }

  const result: DashboardTrade[] = [];

  for (const [, assetTrades] of byKey) {
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

  const totalFees = trades.reduce((sum, t) => sum + t.fee, 0);

  // Count open positions and compute position value using FIFO entry prices
  const netByAsset = new Map<string, number>();
  const buyQueues = new Map<string, { price: number; size: number }[]>();
  for (const t of trades) {
    const key = `${t.profileId ?? '_'}::${t.asset_id}`;
    const current = netByAsset.get(key) ?? 0;
    if (t.side === 'BUY') {
      netByAsset.set(key, current + t.size);
      const queue = buyQueues.get(key) ?? [];
      queue.push({ price: t.price, size: t.size });
      buyQueues.set(key, queue);
    } else {
      netByAsset.set(key, current - t.size);
      // Consume from buy queue (FIFO)
      let remaining = t.size;
      const queue = buyQueues.get(key) ?? [];
      while (remaining > 0 && queue.length > 0) {
        const buy = queue[0];
        const matched = Math.min(remaining, buy.size);
        buy.size -= matched;
        remaining -= matched;
        if (buy.size <= 0.0001) queue.shift();
      }
    }
  }
  const openPositions = [...netByAsset.values()].filter((v) => v > 0.001).length;

  // Position value = sum of remaining buy queue entries (size × entry price)
  let positionValue = 0;
  for (const queue of buyQueues.values()) {
    for (const entry of queue) {
      if (entry.size > 0.0001) {
        positionValue += entry.size * entry.price;
      }
    }
  }

  // Balance-based PnL: infer starting balance by reversing all trades,
  // then PnL = currentBalance + openPositionValue - inferredStart.
  // This captures resolved positions (redeemed wins add to balance,
  // expired losses reduce it) that never appear as SELL trades.
  let inferredStart = currentBalance;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t.side === 'BUY') {
      inferredStart += t.cost + t.fee;
    } else {
      inferredStart -= t.cost - t.fee;
    }
  }
  const totalPnl = currentBalance + positionValue - inferredStart;

  const grossProfit = wins.reduce((sum, t) => sum + t.realizedPnl!, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPnl!, 0));
  const pnlValues = sells.map((t) => t.realizedPnl!);

  return {
    totalTrades: trades.length,
    totalBuys: trades.filter((t) => t.side === 'BUY').length,
    totalSells: sells.length,
    wins: wins.length,
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
    positionValue,
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

/** Fetch trades for a single profile from Polymarket API */
async function fetchProfileTrades(
  profile: ProfileCredentials,
): Promise<TradeRecord[]> {
  const client = getClientForProfile(profile);
  const trades = await client.getTrades();

  return (trades as any[]).map((t) => ({
    id: t.id,
    market: t.market,
    asset_id: t.asset_id,
    side: t.side as 'BUY' | 'SELL',
    price: t.price,
    size: t.size,
    fee_rate_bps: t.fee_rate_bps,
    status: t.status,
    match_time: t.match_time,
    type: t.type || 'LIMIT',
    outcome: t.outcome,
  }));
}

/** Load a single profile's credentials from DB */
async function loadProfileCredentials(
  profileId: string,
): Promise<ProfileCredentials | null> {
  const profile = await prisma.botProfile.findUnique({
    where: { id: profileId },
  });
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    privateKey: profile.privateKey,
    funderAddress: profile.funderAddress,
    apiKey: profile.apiKey,
    apiSecret: profile.apiSecret,
    apiPassphrase: profile.apiPassphrase,
    builderApiKey: profile.builderApiKey,
    builderApiSecret: profile.builderApiSecret,
    builderApiPassphrase: profile.builderApiPassphrase,
  };
}

/** Load all active profiles' credentials from DB */
async function loadAllProfileCredentials(): Promise<ProfileCredentials[]> {
  const profiles = await prisma.botProfile.findMany({
    where: { isActive: true },
  });
  return profiles.map((p) => ({
    id: p.id,
    name: p.name,
    privateKey: p.privateKey,
    funderAddress: p.funderAddress,
    signatureType: p.signatureType,
    apiKey: p.apiKey,
    apiSecret: p.apiSecret,
    apiPassphrase: p.apiPassphrase,
    builderApiKey: p.builderApiKey,
    builderApiSecret: p.builderApiSecret,
    builderApiPassphrase: p.builderApiPassphrase,
  }));
}

/**
 * Main entry: fetch data from Polymarket and compute all analytics.
 * @param profileId - specific profile ID, or undefined/null for all profiles
 */
export async function getDashboardData(
  profileId?: string | null,
): Promise<DashboardData> {
  if (profileId) {
    // Single profile mode
    return getDashboardDataForProfile(profileId);
  }
  // All profiles mode
  return getDashboardDataForAllProfiles();
}

/** Dashboard data for a single profile */
async function getDashboardDataForProfile(
  profileId: string,
): Promise<DashboardData> {
  const creds = await loadProfileCredentials(profileId);
  if (!creds) {
    return {
      trades: [],
      stats: {
        totalTrades: 0,
        totalBuys: 0,
        totalSells: 0,
        wins: 0,
        winRate: 0,
        totalPnl: 0,
        avgTradeSize: 0,
        bestTrade: 0,
        worstTrade: 0,
        profitFactor: 0,
        totalFees: 0,
        openPositions: 0,
        currentBalance: 0,
        positionValue: 0,
      },
      balanceHistory: [],
      pnlHistory: [],
    };
  }

  const [rawTrades, balance] = await Promise.all([
    fetchProfileTrades(creds),
    getProfileBalance(creds),
  ]);

  const parsed = rawTrades.map((t) => parseTrade(t, creds.id, creds.name));
  const matched = matchTrades(parsed);
  const stats = computeStats(matched, balance);
  const balanceHistory = buildBalanceHistory(matched, balance);
  const pnlHistory = buildPnlHistory(matched);

  return { trades: matched, stats, balanceHistory, pnlHistory };
}

/** Dashboard data aggregated across all active profiles */
async function getDashboardDataForAllProfiles(): Promise<DashboardData> {
  const allCreds = await loadAllProfileCredentials();

  if (allCreds.length === 0) {
    return {
      trades: [],
      stats: {
        totalTrades: 0,
        totalBuys: 0,
        totalSells: 0,
        wins: 0,
        winRate: 0,
        totalPnl: 0,
        avgTradeSize: 0,
        bestTrade: 0,
        worstTrade: 0,
        profitFactor: 0,
        totalFees: 0,
        openPositions: 0,
        currentBalance: 0,
        positionValue: 0,
      },
      balanceHistory: [],
      pnlHistory: [],
    };
  }

  // Fetch trades and balances for all profiles in parallel
  const results = await Promise.all(
    allCreds.map(async (creds) => {
      try {
        const [rawTrades, balance] = await Promise.all([
          fetchProfileTrades(creds),
          getProfileBalance(creds),
        ]);
        return {
          creds,
          trades: rawTrades.map((t) => parseTrade(t, creds.id, creds.name)),
          balance,
        };
      } catch (error) {
        console.error(`Failed to fetch data for profile ${creds.name}:`, error);
        return { creds, trades: [] as DashboardTrade[], balance: 0 };
      }
    }),
  );

  // Merge all trades and sum balances
  const allTrades: DashboardTrade[] = [];
  let totalBalance = 0;

  for (const r of results) {
    allTrades.push(...r.trades);
    totalBalance += r.balance;
  }

  const matched = matchTrades(allTrades);
  const stats = computeStats(matched, totalBalance);
  const balanceHistory = buildBalanceHistory(matched, totalBalance);
  const pnlHistory = buildPnlHistory(matched);

  return { trades: matched, stats, balanceHistory, pnlHistory };
}
