import { create } from 'zustand';
import type { Market } from '@/lib/types/app';

interface MarketState {
  markets: Market[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  selectedMarket: Market | null;

  fetchMarkets: (limit?: number) => Promise<void>;
  setSearchQuery: (query: string) => void;
  setSelectedMarket: (market: Market | null) => void;
  filteredMarkets: () => Market[];
}

export const useMarketStore = create<MarketState>((set, get) => ({
  markets: [],
  loading: false,
  error: null,
  searchQuery: '',
  selectedMarket: null,

  fetchMarkets: async (limit = 50) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`/api/markets?limit=${limit}`);
      if (!res.ok) throw new Error('Failed to fetch markets');
      const data = await res.json();
      set({ markets: data.markets, loading: false });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSelectedMarket: (market) => set({ selectedMarket: market }),

  filteredMarkets: () => {
    const { markets, searchQuery } = get();
    if (!searchQuery.trim()) return markets;
    const q = searchQuery.toLowerCase();
    return markets.filter((m) =>
      m.question.toLowerCase().includes(q),
    );
  },
}));
