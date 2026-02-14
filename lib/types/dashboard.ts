/** Dashboard analytics types */

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
  winRate: number;
  totalPnl: number;
  avgTradeSize: number;
  bestTrade: number;
  worstTrade: number;
  profitFactor: number;
  totalFees: number;
  openPositions: number;
  currentBalance: number;
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
