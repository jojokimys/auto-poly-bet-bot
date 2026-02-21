import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOGS_DIR = join(process.cwd(), 'logs');

function getFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOGS_DIR, `sniper-${date}.jsonl`);
}

export interface TradeEntry {
  event: 'entry';
  ts: string;
  profileId: string;
  asset: string;
  mode: string;
  conditionId: string;
  direction: 'YES' | 'NO';
  spotPrice: number;
  strikePrice: number;
  priceDiffPct: number;
  adaptiveThreshold: number;
  confidence: number;
  secondsLeft: number;
  askPrice: number;
  bidPrice: number | null;
  spread: number | null;
  size: number;
  usdcSize: number;
  balance: number;
  totalExposure: number;
  positionSizePct: number;
  expectedPnl: number;
}

export interface TradeExit {
  event: 'exit';
  ts: string;
  profileId: string;
  asset: string;
  conditionId: string;
  direction: 'YES' | 'NO';
  entryPrice: number;
  held: number;
  result: 'win' | 'loss';
  pnl: number;
  holdDurationSec: number;
}

export interface TradeSkip {
  event: 'skip';
  ts: string;
  profileId: string;
  asset: string;
  conditionId: string;
  reason: 'threshold' | 'price-too-high' | 'order-failed';
  secondsLeft: number;
  spotPrice: number;
  strikePrice: number;
  priceDiffPct: number;
  adaptiveThreshold: number;
  confidence: number;
  askPrice?: number;
  maxTokenPrice?: number;
  error?: string;
}

export type TradeLog = TradeEntry | TradeExit | TradeSkip;

export function logTrade(record: TradeLog): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(getFilePath(), JSON.stringify(record) + '\n');
  } catch {
    // non-critical — don't crash the engine
  }
}
