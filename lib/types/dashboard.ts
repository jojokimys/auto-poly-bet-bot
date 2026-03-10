/** Portfolio / dashboard types */

export interface PortfolioDateRange {
  after?: string;
  before?: string;
}

export interface PortfolioStats {
  totalPnl: number;
  wins: number;
  losses: number;
  winRate: number;
  totalTrades: number;
  avgProfit: number;
  avgLoss: number;
}

export interface DailyPnl {
  date: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
}
