/** Polymarket CLOB & Gamma API types */

export interface WalletConfig {
  privateKey: string;
  funderAddress?: string;
}

export interface ApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

/** Raw market from CLOB API */
export interface ClobMarket {
  condition_id: string;
  question: string;
  tokens: ClobToken[];
  minimum_order_size: number;
  minimum_tick_size: number;
  active: boolean;
  closed: boolean;
  end_date_iso: string;
  game_start_time?: string;
  description?: string;
  market_slug?: string;
  icon?: string;
}

export interface ClobToken {
  token_id: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

/** Raw event from Gamma API */
export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  startDate: string;
  endDate: string;
  markets: GammaMarket[];
  active: boolean;
  closed: boolean;
  liquidity: number;
  volume: number;
  commentCount: number;
  image?: string;
}

/** Raw market from Gamma API */
export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  liquidity: string;
  volume: string;
  active: boolean;
  closed: boolean;
  outcomes: string; // JSON string: '["Yes","No"]'
  outcomePrices: string; // JSON string: '[0.55, 0.45]'
  clobTokenIds: string; // JSON string: '["token1","token2"]'
  description?: string;
  image?: string;
  icon?: string;
  volume24hr?: string;
  spread?: string;
  negRisk?: boolean;
}

export interface OrderBookSummary {
  market: string;
  asset_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  hash: string;
  timestamp: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OpenOrder {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  price: string;
  original_size: string;
  size_matched: string;
  status: string;
  outcome: string;
  type: string;
  created_at: string;
  expiration: string;
  associate_trades: string[];
}

export interface TradeRecord {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  price: string;
  size: string;
  fee_rate_bps: string;
  status: string;
  match_time: string;
  type: string;
  outcome: string;
}

export interface BalanceAllowance {
  balance: string;
  allowance: string;
}
