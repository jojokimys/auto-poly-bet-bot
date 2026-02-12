/** Bot engine types */

export interface BotConfig {
  maxBetAmount: number;
  minLiquidity: number;
  minVolume: number;
  maxSpread: number;
  scanIntervalMinutes: number;
  minScore: number;
  maxOpenPositions: number;
  maxPortfolioExposure: number; // fraction of balance
}

/**
 * Tuned for a ~$100 USDC starting bankroll.
 * - $5 max per trade (5% risk per position)
 * - 5 open positions max ($25 total exposure cap)
 * - 30% portfolio exposure ceiling
 * - Conservative scoring threshold (60+)
 */
export const DEFAULT_BOT_CONFIG: BotConfig = {
  maxBetAmount: 5,
  minLiquidity: 1000,
  minVolume: 5000,
  maxSpread: 0.05,
  scanIntervalMinutes: 5,
  minScore: 60,
  maxOpenPositions: 5,
  maxPortfolioExposure: 0.3,
};

export type BotStatus = 'stopped' | 'running' | 'error';

export interface BotState {
  status: BotStatus;
  startedAt: string | null;
  lastScanAt: string | null;
  cycleCount: number;
  marketsScanned: number;
  opportunitiesFound: number;
  ordersPlaced: number;
  totalPnl: number;
  error: string | null;
}

export interface BotLogEntry {
  id: string;
  level: 'info' | 'warn' | 'error' | 'trade';
  event: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface ScoredOpportunity {
  conditionId: string;
  question: string;
  tokenId: string;
  outcome: string;
  price: number;
  yesPrice: number;
  noPrice: number;
  volume24hr: number;
  liquidity: number;
  spread: number;
  dislocation: number;
  hoursToExpiry: number;
  score: number;
}

export interface StrategySignal {
  action: 'BUY' | 'SELL';
  tokenId: string;
  outcome: string;
  conditionId: string;
  question: string;
  price: number;
  size: number;
  reason: string;
  score: number;
}

export interface Strategy {
  name: string;
  evaluate(
    opportunity: ScoredOpportunity,
    config: BotConfig,
    balance: number,
    openPositionCount: number
  ): StrategySignal | null;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  adjustedSize?: number;
}
