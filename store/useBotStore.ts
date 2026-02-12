import { create } from 'zustand';
import type { BotState, BotLogEntry } from '@/lib/bot/types';

interface BotStoreState {
  state: BotState;
  logs: BotLogEntry[];
  loading: boolean;
  error: string | null;

  fetchState: () => Promise<void>;
  fetchLogs: () => Promise<void>;
  startBot: () => Promise<void>;
  stopBot: () => Promise<void>;
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

export const useBotStore = create<BotStoreState>((set) => ({
  state: initialBotState,
  logs: [],
  loading: false,
  error: null,

  fetchState: async () => {
    try {
      const res = await fetch('/api/bot');
      if (!res.ok) throw new Error('Failed to fetch bot state');
      const data: BotState = await res.json();
      set({ state: data });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  },

  fetchLogs: async () => {
    try {
      const res = await fetch('/api/bot/logs?limit=50');
      if (!res.ok) throw new Error('Failed to fetch logs');
      const data = await res.json();
      set({ logs: data.logs });
    } catch {
      // Silent fail for logs
    }
  },

  startBot: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start bot');
      }
      const data: BotState = await res.json();
      set({ state: data, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  },

  stopBot: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      if (!res.ok) throw new Error('Failed to stop bot');
      const data: BotState = await res.json();
      set({ state: data, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  },
}));
