import 'server-only';

import { Wallet } from '@ethersproject/wallet';
import type { ProfileCredentials } from '@/lib/bot/profile-client';
import { getClientForProfile } from '@/lib/bot/profile-client';
import { parseTrade, matchTrades } from '@/lib/polymarket/analytics';
import type { PortfolioStats, PortfolioDateRange, DailyPnl } from '@/lib/types/dashboard';
import type { TradeRecord } from '@/lib/types/polymarket';

export type { PortfolioStats, PortfolioDateRange, DailyPnl };

const LB_API_URL = 'https://lb-api.polymarket.com';
const PNL_API_URL = 'https://user-pnl-api.polymarket.com';

function getWalletAddress(profile: ProfileCredentials): string {
  return profile.funderAddress || new Wallet(profile.privateKey).address;
}

/**
 * Fetch PnL for a date range using the PnL timeseries API.
 * Returns cumPnl(end) - cumPnl(start).
 */
async function fetchPnlForRange(
  walletAddress: string,
  range: PortfolioDateRange,
): Promise<number> {
  const hasRange = range.after || range.before;

  if (!hasRange) {
    // All-time: use the simpler lb-api
    const res = await fetch(
      `${LB_API_URL}/profit?address=${walletAddress}&window=all&limit=1`,
      { cache: 'no-store' },
    );
    if (!res.ok) return 0;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return 0;
    return data[0].amount ?? 0;
  }

  // Custom range: use PnL timeseries
  const res = await fetch(
    `${PNL_API_URL}/user-pnl?user_address=${walletAddress}&interval=all&fidelity=1d`,
    { cache: 'no-store' },
  );
  if (!res.ok) return 0;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return 0;

  // data = [{ t: unixSeconds, p: cumPnl }, ...]
  const points: { t: number; p: number }[] = data;

  const afterTs = range.after ? new Date(range.after).getTime() / 1000 : 0;
  // 'before' is inclusive end-of-day: add 1 day
  const beforeTs = range.before
    ? new Date(range.before).getTime() / 1000 + 86400
    : Infinity;

  // Find cumulative PnL just before the start date
  let startPnl = 0;
  for (const pt of points) {
    if (pt.t < afterTs) startPnl = pt.p;
    else break;
  }

  // Find cumulative PnL at the end date
  let endPnl = startPnl;
  for (const pt of points) {
    if (pt.t <= beforeTs) endPnl = pt.p;
  }

  return endPnl - startPnl;
}

/** Fetch all trades from CLOB API, filter by date client-side, then FIFO-match for win/loss */
async function fetchAndMatchTrades(
  profile: ProfileCredentials,
  range: PortfolioDateRange,
): Promise<{ totalTrades: number; wins: number; losses: number }> {
  const client = getClientForProfile(profile);
  const rawTrades = await client.getTrades() as any[];

  if (!Array.isArray(rawTrades) || rawTrades.length === 0) {
    return { totalTrades: 0, wins: 0, losses: 0 };
  }

  // match_time is Unix seconds (string), e.g. "1771085685"
  // Convert range dates to Unix seconds for comparison
  const afterSec = range.after ? new Date(range.after).getTime() / 1000 : 0;
  const beforeSec = range.before
    ? new Date(range.before).getTime() / 1000 + 86400 // end-of-day inclusive
    : Infinity;

  const filtered = rawTrades.filter((t) => {
    const sec = parseInt(t.match_time, 10);
    return !isNaN(sec) && sec >= afterSec && sec < beforeSec;
  });

  if (filtered.length === 0) {
    return { totalTrades: 0, wins: 0, losses: 0 };
  }

  const tradeRecords: TradeRecord[] = filtered.map((t) => ({
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

  const parsed = tradeRecords.map((t) => parseTrade(t, profile.id, profile.name));
  const matched = matchTrades(parsed);

  const sells = matched.filter((t) => t.side === 'SELL' && t.realizedPnl !== null);
  const wins = sells.filter((t) => t.realizedPnl! > 0).length;
  const losses = sells.filter((t) => t.realizedPnl! < 0).length;

  return { totalTrades: filtered.length, wins, losses };
}

function toUTCDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Fetch daily PnL from cumulative timeseries + per-day win/loss from CLOB trades */
export async function getDailyPnl(
  profile: ProfileCredentials,
): Promise<DailyPnl[]> {
  const walletAddress = getWalletAddress(profile);

  // Fetch PnL timeseries and trades in parallel
  const [pnlRes, rawTrades] = await Promise.all([
    fetch(
      `${PNL_API_URL}/user-pnl?user_address=${walletAddress}&interval=all&fidelity=1d`,
      { cache: 'no-store' },
    ),
    getClientForProfile(profile).getTrades().catch(() => [] as any[]),
  ]);

  // Build per-day PnL from timeseries
  const pnlByDate = new Map<string, number>();
  if (pnlRes.ok) {
    const data = await pnlRes.json();
    if (Array.isArray(data) && data.length > 0) {
      const points: { t: number; p: number }[] = data;
      for (let i = 0; i < points.length; i++) {
        const prev = i > 0 ? points[i - 1].p : 0;
        const date = toUTCDate(points[i].t);
        pnlByDate.set(date, (pnlByDate.get(date) ?? 0) + (points[i].p - prev));
      }
    }
  }

  // Build per-day wins/losses from FIFO-matched trades
  const wlByDate = new Map<string, { wins: number; losses: number }>();
  if (Array.isArray(rawTrades) && rawTrades.length > 0) {
    const tradeRecords: TradeRecord[] = rawTrades.map((t: any) => ({
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

    const parsed = tradeRecords.map((t) => parseTrade(t, profile.id, profile.name));
    const matched = matchTrades(parsed);

    for (const t of matched) {
      if (t.side !== 'SELL' || t.realizedPnl === null) continue;
      const ms = new Date(t.matchTime).getTime();
      if (isNaN(ms)) continue;
      const date = toUTCDate(ms / 1000);
      const entry = wlByDate.get(date) ?? { wins: 0, losses: 0 };
      if (t.realizedPnl > 0) entry.wins++;
      else entry.losses++;
      wlByDate.set(date, entry);
    }
  }

  // Merge all dates
  const allDates = new Set([...pnlByDate.keys(), ...wlByDate.keys()]);
  const result: DailyPnl[] = [];
  for (const date of allDates) {
    const wl = wlByDate.get(date);
    result.push({
      date,
      pnl: pnlByDate.get(date) ?? 0,
      wins: wl?.wins ?? 0,
      losses: wl?.losses ?? 0,
    });
  }

  result.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

/** Get portfolio stats — PnL from Polymarket APIs, win rate from FIFO-matched CLOB trades */
export async function getPortfolioStats(
  profile: ProfileCredentials,
  range: PortfolioDateRange = {},
): Promise<PortfolioStats> {
  const walletAddress = getWalletAddress(profile);

  const [totalPnl, tradeStats] = await Promise.all([
    fetchPnlForRange(walletAddress, range),
    fetchAndMatchTrades(profile, range),
  ]);

  const closedWithOutcome = tradeStats.wins + tradeStats.losses;

  return {
    totalPnl,
    totalTrades: tradeStats.totalTrades,
    wins: tradeStats.wins,
    losses: tradeStats.losses,
    winRate: closedWithOutcome > 0 ? tradeStats.wins / closedWithOutcome : 0,
  };
}
