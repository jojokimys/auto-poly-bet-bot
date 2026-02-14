import { create } from 'zustand';
import type { BotState, BotLogEntry } from '@/lib/bot/types';

interface BotStoreState {
  /** Map of profileId → BotState for all running bots */
  states: Record<string, BotState>;
  logs: BotLogEntry[];
  loading: boolean;
  error: string | null;

  fetchState: () => Promise<void>;
  fetchLogs: (profileId?: string) => Promise<void>;
  startBot: (profileId: string) => Promise<void>;
  stopBot: (profileId: string) => Promise<void>;
  stopAll: () => Promise<void>;
}

const initialBotState: BotState = {
  status: 'stopped',
  startedAt: null,
  lastScanAt: null,
  cycleCount: 0,
  marketsScanned: 0,
  opportunitiesFound: 0,
  ordersPlaced: 0,
  totalPnl: 0,
  error: null,
};

export { initialBotState };

export const useBotStore = create<BotStoreState>((set) => ({
  states: {},
  logs: [],
  loading: false,
  error: null,

  fetchState: async () => {
    try {
      const res = await fetch('/api/bot');
      if (!res.ok) throw new Error('Failed to fetch bot state');
      const data = await res.json();
      set({ states: data.states ?? {} });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  },

  fetchLogs: async (profileId?: string) => {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (profileId) params.set('profileId', profileId);
      const res = await fetch(`/api/bot/logs?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch logs');
      const data = await res.json();
      set({ logs: data.logs });
    } catch {
      // Silent fail for logs
    }
  },

  startBot: async (profileId: string) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', profileId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start bot');
      }
      const data = await res.json();
      set((prev) => ({
        states: { ...prev.states, [data.profileId]: data.state },
        loading: false,
      }));
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  },

  stopBot: async (profileId: string) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', profileId }),
      });
      if (!res.ok) throw new Error('Failed to stop bot');
      const data = await res.json();
      set((prev) => ({
        states: { ...prev.states, [data.profileId]: data.state },
        loading: false,
      }));
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  },

  stopAll: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stopAll' }),
      });
      if (!res.ok) throw new Error('Failed to stop all bots');
      const data = await res.json();
      set({ states: data.states ?? {}, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  },
}));
