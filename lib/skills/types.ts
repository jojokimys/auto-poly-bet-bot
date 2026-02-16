// ─── Skill System Common Types ──────────────────────────

// Data Collector
export interface MarketData {
  conditionId: string;
  question: string;
  endDate: string;
  yesPrice: number;
  noPrice: number;
  volume24hr: number;
  liquidity: number;
  spread: number;
  hoursToExpiry: number;
  outcomes: { name: string; tokenId: string; price: number }[];
}

export interface OrderBookData {
  conditionId: string;
  question: string;
  yes: { bestBid: number; bestAsk: number; depth: number; levels: { price: number; size: number }[] };
  no: { bestBid: number; bestAsk: number; depth: number; levels: { price: number; size: number }[] };
  combinedAsk: number;
  arbOpportunity: boolean;
}

export interface SnapshotData {
  conditionId: string;
  snapshots: { yesPrice: number; noPrice: number; volume24hr: number; snapshotAt: string }[];
}

// Crypto Data
export interface CryptoPriceData {
  prices: Record<string, { price: number; change24h: number }>;
  timestamp: string;
}

// Position Monitor
export interface PositionData {
  profileId: string;
  profileName: string;
  balance: number;
  openOrders: {
    id: string;
    conditionId: string;
    side: string;
    price: number;
    size: number;
    status: string;
    tokenId: string;
  }[];
  heldPositions: {
    tokenId: string;
    conditionId: string;
    outcome: string;
    netSize: number;
    avgEntryPrice: number;
    totalCost: number;
  }[];
  exposure: { total: number; percentage: number };
  summary: { totalPositions: number; totalExposure: number };
}

// Risk Manager
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RiskData {
  profileId: string;
  riskLevel: RiskLevel;
  balance: number;
  totalExposure: number;
  exposurePercent: number;
  maxExposurePercent: number;
  drawdown: { current: number; maxAllowed: number; peakBalance: number };
  canTrade: boolean;
  warnings: string[];
  limits: { maxPositionSize: number };
}

// Order Manager
export interface OrderRequest {
  profileId: string;
  action: 'BUY' | 'SELL';
  conditionId: string;
  tokenId: string;
  outcome: string;
  price: number;
  size: number;
  reason: string;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  message: string;
}

export interface ArbOrderResult {
  success: boolean;
  results: OrderResult[];
  message: string;
}

// Performance
export interface PerformanceData {
  period: string;
  profileId: string;
  stats: {
    totalTrades: number;
    winRate: number;
    totalPnl: number;
    profitFactor: number;
    avgTradeSize: number;
    bestTrade: number;
    worstTrade: number;
    totalFees: number;
    openPositions: number;
  };
  recentTrades: {
    conditionId: string;
    side: string;
    outcome: string;
    price: number;
    size: number;
    realizedPnl: number | null;
    matchTime: string;
  }[];
  learnings: string[];
}

// Explorer
export interface ArbLeg {
  conditionId: string;
  tokenId: string;
  outcome: string;
  price: number;
  size: number;
}

export interface Opportunity {
  type: string;
  conditionId: string;
  question: string;
  signal: 'BUY' | 'SELL';
  tokenId: string;
  outcome: string;
  suggestedPrice: number;
  suggestedSize: number;
  expectedProfit: number;
  confidence: number;
  reasoning: string;
  timeWindow: 'urgent' | 'minutes' | 'hours';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  dataPoints: Record<string, unknown>;
  /** Whether this opportunity can be auto-executed without Claude's approval (arb strategies) */
  autoExecutable: boolean;
  /** Detailed strategy score breakdown */
  strategyScore?: number;
  /** Additional legs for arb execution (complement-arb, multi-outcome-arb) */
  arbLegs?: ArbLeg[];
}

export interface ExploreData {
  opportunities: Opportunity[];
  marketConditions: {
    totalActiveMarkets: number;
    avgSpread: number;
    topVolumeMarkets: string[];
  };
}

// Early Exit
export interface EarlyExitCandidate {
  conditionId: string;
  tokenId: string;
  outcome: string;
  question: string;
  netSize: number;
  avgEntryPrice: number;
  currentBestBid: number;
  sellPrice: number;
  estimatedProceeds: number;
  estimatedPnl: number;
  bidDepthAtPrice: number;
}

export interface EarlyExitResult {
  profileId: string;
  candidates: EarlyExitCandidate[];
  executed: {
    tokenId: string;
    outcome: string;
    size: number;
    price: number;
    orderId: string;
    success: boolean;
    message: string;
  }[];
  summary: {
    totalCandidates: number;
    totalExecuted: number;
    totalProceeds: number;
    capitalFreed: number;
  };
}

// Reporter
export interface ReportRequest {
  profileId: string;
  sessionId: string;
  type: 'cycle' | 'daily' | 'weekly';
  summary: string;
  decisions: { action: string; conditionId?: string; reason: string; outcome?: string }[];
  learnings: string[];
  nextPlan: string;
}
