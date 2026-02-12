import { create } from 'zustand';
import type { DashboardData, DashboardTrade, DashboardStats, BalanceDataPoint, PnlDataPoint } from '@/lib/types/dashboard';

interface DashboardState {
  trades: DashboardTrade[];
  stats: DashboardStats | null;
  balanceHistory: BalanceDataPoint[];
  pnlHistory: PnlDataPoint[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  fetchDashboard: () => Promise<void>;
}

const DEBOUNCE_MS = 30_000;

export const useDashboardStore = create<DashboardState>((set, get) => ({
  trades: [],
  stats: null,
  balanceHistory: [],
  pnlHistory: [],
  loading: false,
  error: null,
  lastFetchedAt: null,

  fetchDashboard: async () => {
    const { lastFetchedAt, loading } = get();
    if (loading) return;
    if (lastFetchedAt && Date.now() - lastFetchedAt < DEBOUNCE_MS) return;

    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/dashboard');
      if (!res.ok) throw new Error('Failed to fetch dashboard data');
      const data: DashboardData = await res.json();
      set({
        trades: data.trades,
        stats: data.stats,
        balanceHistory: data.balanceHistory,
        pnlHistory: data.pnlHistory,
        loading: false,
        lastFetchedAt: Date.now(),
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  },
}));
