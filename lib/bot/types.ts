/** Bot engine types */

export interface BotConfig {
  maxBetAmount: number;
  minLiquidity: number;
  minVolume: number;
  maxSpread: number;
  scanIntervalSeconds: number;
  minScore: number;
  maxPortfolioExposure: number; // fraction of balance
}

/**
 * Tuned for a ~$285 USDC bankroll.
 * - $25 max per trade (~8.8% risk per position)
 * - 40% portfolio exposure ceiling (overridable per-profile)
 * - 15s scan interval for faster opportunity capture
 */
export const DEFAULT_BOT_CONFIG: BotConfig = {
  maxBetAmount: 25,
  minLiquidity: 1000,
  minVolume: 5000,
  maxSpread: 0.05,
  scanIntervalSeconds: 15,
  minScore: 60,
  maxPortfolioExposure: 0.4,
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
  profileId?: string;
  profileName?: string;
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
  // Complement arb fields
  yesTokenId?: string;
  noTokenId?: string;
  yesBestAsk?: number;
  noBestAsk?: number;
  askDepthYes?: number;
  askDepthNo?: number;
  // Crypto latency arb fields
  spotPrice?: number;
  openingPrice?: number;
  // Crypto scalper fields
  cryptoAsset?: string;
  // Multi-outcome bundle arb fields
  bundleEventId?: string;
  bundleEventTitle?: string;
  bundleLegs?: {
    tokenId: string;
    outcome: string;
    marketQuestion: string;
    bestAsk: number;
    askDepth: number;
  }[];
  bundleCost?: number;
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
  /** Strategy can flag this signal as auto-executable (overrides registry default) */
  autoExecutable?: boolean;
  /** Second leg for complement arb (opposing token order) */
  secondLeg?: {
    tokenId: string;
    outcome: string;
    price: number;
    size: number;
  };
  /** Bundle legs for multi-outcome arb (all remaining outcome orders) */
  bundleLegs?: {
    tokenId: string;
    outcome: string;
    price: number;
    size: number;
  }[];
}

export interface Strategy {
  name: string;
  evaluate(
    opportunity: ScoredOpportunity,
    config: BotConfig,
    balance: number,
    openPositionCount: number,
    profileId?: string,
  ): StrategySignal | null | Promise<StrategySignal | null>;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  adjustedSize?: number;
}
