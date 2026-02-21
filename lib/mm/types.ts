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

export interface MarketSelection {
  asset: CryptoAsset;
  mode: MarketMode;
}

export interface SniperConfig {
  selections: MarketSelection[];
  minMinutesLeft: number;      // 0.3 (earliest entry window)
  maxMinutesLeft: number;      // 1.0 (latest entry window)
  minPriceDiffPct: number;     // 0.0012 (0.12%)
  maxTokenPrice: number;       // 0.95
  maxPositionPct: number;      // 0.15 = 15% of balance per position
  maxExposurePct: number;      // 0.80 = 80% of balance total exposure
  maxConcurrentPositions: number; // 6
  priceCheckIntervalMs: number;   // 1500
  marketScanIntervalMs: number;   // 20000
}

export const ALL_MARKET_SELECTIONS: MarketSelection[] = [
  { asset: 'BTC', mode: '5m' },
  { asset: 'BTC', mode: '15m' },
  { asset: 'ETH', mode: '5m' },
  { asset: 'ETH', mode: '15m' },
  { asset: 'SOL', mode: '5m' },
  { asset: 'SOL', mode: '15m' },
  { asset: 'XRP', mode: '5m' },
  { asset: 'XRP', mode: '15m' },
];

export const DEFAULT_SNIPER_CONFIG: SniperConfig = {
  selections: [
    { asset: 'BTC', mode: '5m' },
    { asset: 'BTC', mode: '15m' },
    { asset: 'ETH', mode: '5m' },
    { asset: 'ETH', mode: '15m' },
    { asset: 'SOL', mode: '5m' },
    { asset: 'SOL', mode: '15m' },
    { asset: 'XRP', mode: '5m' },
    { asset: 'XRP', mode: '15m' },
  ],
  minMinutesLeft: 0.3,       // 18s — enter even closer to expiry
  maxMinutesLeft: 1.0,       // 60s — tight window, high certainty
  minPriceDiffPct: 0.0012,   // 0.12% base (adaptive scaling adjusts per time)
  maxTokenPrice: 0.95,       // accept up to 95¢ (3¢+ net profit/share after fees)
  maxPositionPct: 0.15,      // 15% of balance per position
  maxExposurePct: 0.80,      // 80% of balance total exposure
  maxConcurrentPositions: 6, // 6 simultaneous positions
  priceCheckIntervalMs: 1500, // 1.5s — faster reaction
  marketScanIntervalMs: 20000, // 20s — find new markets faster
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
