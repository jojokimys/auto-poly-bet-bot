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
  selectedProfileId: string | null; // null = all profiles
  fetchDashboard: (profileId?: string | null) => Promise<void>;
  setSelectedProfileId: (profileId: string | null) => void;
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
  selectedProfileId: null,

  setSelectedProfileId: (profileId: string | null) => {
    const { selectedProfileId } = get();
    if (profileId === selectedProfileId) return;
    // Reset debounce so fetch happens immediately on profile change
    set({ selectedProfileId: profileId, lastFetchedAt: null });
  },

  fetchDashboard: async (profileId?: string | null) => {
    const state = get();
    if (state.loading) return;

    // Use provided profileId or the stored one
    const targetProfileId = profileId !== undefined ? profileId : state.selectedProfileId;

    if (state.lastFetchedAt && Date.now() - state.lastFetchedAt < DEBOUNCE_MS) return;

    set({ loading: true, error: null });
    try {
      const url = targetProfileId
        ? `/api/dashboard?profileId=${encodeURIComponent(targetProfileId)}`
        : '/api/dashboard';
      const res = await fetch(url);
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
