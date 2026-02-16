/** Application domain types */

export interface Market {
  conditionId: string;
  question: string;
  slug: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  liquidity: number;
  volume: number;
  volume24hr: number;
  spread: number;
  outcomes: Outcome[];
  description?: string;
  image?: string;
  icon?: string;
}

export interface Outcome {
  name: string;
  tokenId: string;
  price: number;
}

export interface Position {
  conditionId: string;
  question: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
}

export interface Order {
  id: string;
  conditionId: string;
  question?: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  sizeMatched: number;
  status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
  type: 'LIMIT' | 'MARKET';
  outcome: string;
  createdAt: string;
}

export type ConnectionStatus = 'connected' | 'degraded' | 'disconnected';

export interface BotStatus {
  running: boolean;
  lastScanAt: string | null;
  marketsScanned: number;
  opportunitiesFound: number;
}

