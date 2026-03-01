import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { TradeEntry, TradeExit } from '@/lib/mm/trade-logger';

const LOGS_DIR = join(process.cwd(), 'logs');

interface MatchedTrade {
  conditionId: string;
  asset: string;
  mode: string;
  direction: 'YES' | 'NO';
  entryTs: string;
  exitTs: string | null;
  entryPrice: number;
  spotPrice: number;
  strikePrice: number;
  priceDiffPct: number;
  confidence: number;
  secondsLeft: number;
  size: number;
  usdcSize: number;
  result: 'win' | 'loss' | 'pending';
  pnl: number;
  holdDurationSec: number | null;
}

interface TradeSession {
  id: string;
  startTs: string;
  endTs: string;
  trades: MatchedTrade[];
  totalPnl: number;
  wins: number;
  losses: number;
  pending: number;
  totalSize: number;
}

// Gap threshold for session splitting (5 minutes)
const SESSION_GAP_MS = 5 * 60 * 1000;

function parseLogFile(filePath: string): (TradeEntry | TradeExit)[] {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const results: (TradeEntry | TradeExit)[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.event === 'entry' || parsed.event === 'exit') {
          results.push(parsed);
        }
      } catch { /* skip malformed lines */ }
    }
    return results;
  } catch {
    return [];
  }
}

function getLogFiles(days: number): string[] {
  if (!existsSync(LOGS_DIR)) return [];
  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith('sniper-') && f.endsWith('.jsonl'))
    .sort()
    .reverse();

  if (days > 0) {
    return files.slice(0, days);
  }
  return files;
}

export async function GET(req: NextRequest) {
  const profileId = req.nextUrl.searchParams.get('profileId');
  const days = parseInt(req.nextUrl.searchParams.get('days') ?? '7', 10);
  const date = req.nextUrl.searchParams.get('date'); // specific date: YYYY-MM-DD

  let logFiles: string[];
  if (date) {
    const filePath = join(LOGS_DIR, `sniper-${date}.jsonl`);
    logFiles = existsSync(filePath) ? [filePath] : [];
  } else {
    logFiles = getLogFiles(days).map((f) => join(LOGS_DIR, f));
  }

  // Parse all log entries
  let allEntries: TradeEntry[] = [];
  let allExits: TradeExit[] = [];

  for (const file of logFiles) {
    const records = parseLogFile(file);
    for (const r of records) {
      if (r.event === 'entry') allEntries.push(r as TradeEntry);
      else if (r.event === 'exit') allExits.push(r as TradeExit);
    }
  }

  // Filter by profileId
  if (profileId) {
    allEntries = allEntries.filter((e) => e.profileId === profileId);
    allExits = allExits.filter((e) => e.profileId === profileId);
  }

  // Build exit lookup by conditionId
  const exitMap = new Map<string, TradeExit>();
  for (const exit of allExits) {
    exitMap.set(exit.conditionId, exit);
  }

  // Match entries with exits
  const trades: MatchedTrade[] = [];
  for (const entry of allEntries) {
    const exit = exitMap.get(entry.conditionId);
    trades.push({
      conditionId: entry.conditionId,
      asset: entry.asset,
      mode: entry.mode,
      direction: entry.direction,
      entryTs: entry.ts,
      exitTs: exit?.ts ?? null,
      entryPrice: entry.askPrice,
      spotPrice: entry.spotPrice,
      strikePrice: entry.strikePrice,
      priceDiffPct: entry.priceDiffPct,
      confidence: entry.confidence,
      secondsLeft: entry.secondsLeft,
      size: entry.size,
      usdcSize: entry.usdcSize,
      result: exit?.result ?? 'pending',
      pnl: exit?.pnl ?? 0,
      holdDurationSec: exit?.holdDurationSec ?? null,
    });
  }

  // Sort by entry time
  trades.sort((a, b) => new Date(a.entryTs).getTime() - new Date(b.entryTs).getTime());

  // Group into sessions
  const sessions: TradeSession[] = [];
  let currentSession: TradeSession | null = null;

  for (const trade of trades) {
    const tradeTime = new Date(trade.entryTs).getTime();

    if (!currentSession || tradeTime - new Date(currentSession.endTs).getTime() > SESSION_GAP_MS) {
      // Start new session
      currentSession = {
        id: `s-${sessions.length}`,
        startTs: trade.entryTs,
        endTs: trade.exitTs ?? trade.entryTs,
        trades: [],
        totalPnl: 0,
        wins: 0,
        losses: 0,
        pending: 0,
        totalSize: 0,
      };
      sessions.push(currentSession);
    }

    currentSession.trades.push(trade);
    currentSession.totalPnl += trade.pnl;
    currentSession.totalSize += trade.usdcSize;
    if (trade.result === 'win') currentSession.wins++;
    else if (trade.result === 'loss') currentSession.losses++;
    else currentSession.pending++;

    // Update session end time
    const endCandidate = trade.exitTs ?? trade.entryTs;
    if (new Date(endCandidate).getTime() > new Date(currentSession.endTs).getTime()) {
      currentSession.endTs = endCandidate;
    }
  }

  // Reverse so newest first
  sessions.reverse();

  // Summary stats
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const totalWins = trades.filter((t) => t.result === 'win').length;
  const totalLosses = trades.filter((t) => t.result === 'loss').length;
  const totalTrades = trades.length;

  // Cumulative PnL points for chart (chronological)
  const pnlPoints: { ts: string; pnl: number; asset: string; result: string }[] = [];
  let cumPnl = 0;
  for (const trade of trades) {
    if (trade.result !== 'pending') {
      cumPnl += trade.pnl;
      pnlPoints.push({
        ts: trade.exitTs ?? trade.entryTs,
        pnl: Math.round(cumPnl * 1000) / 1000,
        asset: trade.asset,
        result: trade.result,
      });
    }
  }

  return NextResponse.json({
    sessions,
    summary: { totalPnl, totalWins, totalLosses, totalTrades },
    pnlChart: pnlPoints,
  });
}
