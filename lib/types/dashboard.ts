/** Dashboard analytics types */

export interface PortfolioDateRange {
  after?: string;  // ISO date string (YYYY-MM-DD)
  before?: string; // ISO date string (YYYY-MM-DD)
}

export interface DailyPnl {
  date: string;  // YYYY-MM-DD
  pnl: number;
  wins: number;
  losses: number;
}

export interface PortfolioStats {
  totalPnl: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface DashboardTrade {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  outcome: string;
  price: number;
  size: number;
  fee: number;
  cost: number;
  matchTime: string;
  realizedPnl: number | null;
  profileId?: string;
  profileName?: string;
}

export interface DashboardStats {
  totalTrades: number;
  totalBuys: number;
  totalSells: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgTradeSize: number;
  bestTrade: number;
  worstTrade: number;
  profitFactor: number;
  totalFees: number;
  openPositions: number;
  currentBalance: number;
  positionValue: number;
}

export interface BalanceDataPoint {
  date: string;
  balance: number;
}

export interface PnlDataPoint {
  date: string;
  pnl: number;
}

export interface DashboardData {
  trades: DashboardTrade[];
  stats: DashboardStats;
  balanceHistory: BalanceDataPoint[];
  pnlHistory: PnlDataPoint[];
}
