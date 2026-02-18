/** Market Maker types */

export type VolatilityRegime = 'calm' | 'normal' | 'elevated' | 'volatile';

export type CryptoAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export const ALL_CRYPTO_ASSETS: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

export type MarketMode = '5m' | '15m';

export interface MMConfig {
  mode: MarketMode;
  assets: CryptoAsset[];
  baseSpreadCents: number;
  maxPositionSize: number;
  quoteRefreshMs: number;
  preExpiryPullMs: number;
  circuitBreakerPct: number;
  maxTotalExposure: number;
  oneSideFillTimeoutMs: number;
  minMinutes: number;
  maxMinutes: number;
  klineInterval: string;
}

export const MM_PRESETS: Record<MarketMode, MMConfig> = {
  '5m': {
    mode: '5m',
    assets: ['BTC', 'ETH'],
    baseSpreadCents: 2,
    maxPositionSize: 10,
    quoteRefreshMs: 2000,
    preExpiryPullMs: 30_000,
    circuitBreakerPct: 0.003,
    maxTotalExposure: 100,
    oneSideFillTimeoutMs: 20_000,
    minMinutes: 1.5,
    maxMinutes: 5,
    klineInterval: '5m',
  },
  '15m': {
    mode: '15m',
    assets: ['BTC', 'ETH'],
    baseSpreadCents: 3,
    maxPositionSize: 10,
    quoteRefreshMs: 3000,
    preExpiryPullMs: 60_000,
    circuitBreakerPct: 0.005,
    maxTotalExposure: 200,
    oneSideFillTimeoutMs: 45_000,
    minMinutes: 3,
    maxMinutes: 14,
    klineInterval: '15m',
  },
};

export const DEFAULT_MM_CONFIG: MMConfig = MM_PRESETS['15m'];

export interface MMState {
  status: 'stopped' | 'running' | 'error';
  startedAt: string | null;
  volatilityRegime: VolatilityRegime;
  activeMarkets: number;
  quotesPlaced: number;
  fillsBuy: number;
  fillsSell: number;
  roundTrips: number;
  grossPnl: number;
  totalExposure: number;
  error: string | null;
}

export interface ActiveMarket {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  endTime: Date;
  cryptoAsset: CryptoAsset;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  yesHeld: number;
  noHeld: number;
  bidOrderId: string | null;
  askOrderId: string | null;
  bidPrice: number | null;
  askPrice: number | null;
  // Fill tracking
  yesFillTime: number | null;   // timestamp when YES fill detected
  noFillTime: number | null;    // timestamp when NO fill detected
  yesEntryPrice: number | null; // price at which YES was filled
  noEntryPrice: number | null;  // price at which NO was filled
  negRisk: boolean;
  strikePrice: number | null;   // target price from market question (e.g. $97,500)
}

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VolatilityState {
  regime: VolatilityRegime;
  atrpPercentile: number;
  bbwPercentile: number;
  atrRatio: number;
  lastUpdate: number;
}

export interface QuoteResult {
  bidPrice: number;
  askPrice: number;
  size: number;
}

export interface BookSnapshot {
  assetId: string;
  buys: { price: string; size: string }[];
  sells: { price: string; size: string }[];
  timestamp: number;
}

// ─── Sniper Types ────────────────────────────────────────

export interface SniperConfig {
  mode: MarketMode;
  assets: CryptoAsset[];
  minMinutesLeft: number;      // 0.5 (earliest entry window)
  maxMinutesLeft: number;      // 3.0 (latest entry window)
  minPriceDiffPct: number;     // 0.0015 (0.15%)
  maxTokenPrice: number;       // 0.93
  maxPositionSize: number;     // 10 (USDC)
  maxTotalExposure: number;    // 30 (USDC)
  maxConcurrentPositions: number; // 3
  priceCheckIntervalMs: number;   // 2000
  marketScanIntervalMs: number;   // 30000
}

export const DEFAULT_SNIPER_CONFIG: SniperConfig = {
  mode: '15m',
  assets: ['BTC', 'ETH'],
  minMinutesLeft: 0.5,
  maxMinutesLeft: 3.0,
  minPriceDiffPct: 0.0015,
  maxTokenPrice: 0.93,
  maxPositionSize: 10,
  maxTotalExposure: 30,
  maxConcurrentPositions: 3,
  priceCheckIntervalMs: 2000,
  marketScanIntervalMs: 30000,
};

export interface SniperState {
  status: 'stopped' | 'running' | 'error';
  startedAt: string | null;
  activeMarkets: number;
  totalTrades: number;
  wins: number;
  losses: number;
  grossPnl: number;
  totalExposure: number;
  error: string | null;
}

export interface SniperMarket extends ActiveMarket {
  direction: 'YES' | 'NO' | null;
  entryPrice: number | null;
  entryTime: number | null;
  confidence: number;
  tokenId: string | null;
  held: number;
}

export interface SniperDetail {
  state: SniperState;
  markets: SniperMarketInfo[];
  config: SniperConfig;
}

export interface SniperMarketInfo {
  conditionId: string;
  question: string;
  cryptoAsset: string;
  endTime: string;
  strikePrice: number | null;
  minutesLeft: number;
  direction: 'YES' | 'NO' | null;
  entryPrice: number | null;
  entryTime: number | null;
  confidence: number;
  held: number;
  bestAsk: number | null;
  status: 'watching' | 'entered' | 'expired';
}
